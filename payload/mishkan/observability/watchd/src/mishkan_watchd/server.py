"""UNIX socket server — NDJSON snapshot+delta protocol.

On client connect: send one {"type":"snapshot","state":{...}} frame,
then a stream of {"type":"delta",...} for every event, plus
{"type":"heartbeat","ts":"..."} every 5 s.

Protocol is intentionally simple:
  - One JSON object per line, LF-terminated.
  - No versioning, no auth beyond filesystem 0600 perms on the socket.
  - Clients connect, optionally send {"op":"subscribe"} (the server
    treats every client as subscribed by default), and read.

Idle-shutdown contract
----------------------
The daemon self-exits when no TUI client has been connected for
``idle_timeout_s`` seconds (default 300 — 5 min).

Lifecycle:
  - ``_idle_since`` is set to the current monotonic clock at construction
    time, providing a startup-grace period: a daemon that is auto-started
    but never connected to will exit after the timeout rather than running
    forever.
  - ``_idle_since`` is cleared (set to ``None``) the moment a client
    connects (``_handle`` adds it to ``self.clients``).
  - ``_idle_since`` is reset to *now* whenever the active client count
    drops back to zero — either via the normal ``_handle`` finally path
    or via the dead-writer eviction in ``_broadcast_raw``.
  - An ``_idle_watcher`` task (10 s tick) checks the condition. When idle
    for more than ``idle_timeout_s`` it logs one line and invokes
    ``_shutdown_cb()``, which is ``stop_event.set()`` wired from
    ``__main__._run``; the normal SIGTERM teardown path then runs.

To disable idle-shutdown entirely: pass ``idle_timeout_s=0`` (or any
value <= 0). This is intended for power users running the daemon as a
persistent background service (e.g. via systemd --user).

Multi-window safety: as long as ANY client is connected ``len(self.clients) > 0``
and the daemon never idle-exits; the countdown only begins after the LAST
client disconnects.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

# Default idle-shutdown window in seconds.  Overridable via --idle-timeout
# CLI arg or MISHKAN_WATCHD_IDLE_TIMEOUT env var.  Set to 0 or negative to
# disable entirely.
DAEMON_IDLE_SHUTDOWN_S: float = 300.0


def _iso() -> str:
    t = datetime.now(tz=timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


class WatchdServer:
    def __init__(
        self,
        socket_path: Path,
        state,
        heartbeat_s: float = 5.0,
        idle_timeout_s: float = DAEMON_IDLE_SHUTDOWN_S,
        shutdown_cb: Callable[[], None] | None = None,
    ) -> None:
        self.socket_path = socket_path
        self.state = state
        self.heartbeat_s = heartbeat_s
        self.idle_timeout_s = idle_timeout_s
        self._shutdown_cb = shutdown_cb
        self.clients: set[asyncio.StreamWriter] = set()
        self.lock = asyncio.Lock()
        self._heartbeat_task: asyncio.Task | None = None
        self._idle_watcher_task: asyncio.Task | None = None
        # Start the idle clock at construction time (startup-grace: a daemon
        # that is auto-started but never connected to exits after the timeout).
        self._idle_since: float | None = time.monotonic()

    @staticmethod
    def _socket_is_live(socket_path: Path) -> bool:
        """Return True if a daemon is already listening on socket_path.

        Attempts a non-blocking connect and an immediate close. If it
        succeeds the socket has a live owner; if it raises (connection
        refused, file not found, timeout) the socket is stale or absent.
        """
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                s.settimeout(0.5)
                s.connect(str(socket_path))
            return True
        except (OSError, socket.timeout):
            return False

    async def start(self) -> asyncio.AbstractServer:
        # Ensure parent dir exists.
        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        # Check liveness BEFORE unlinking: if a daemon is already serving
        # this socket, do not steal it — return a no-op guard server instead.
        # Only unlink a socket whose owner is gone (stale file).
        if self.socket_path.exists() and self._socket_is_live(self.socket_path):
            raise RuntimeError(
                f"ares-watchd: daemon already running on {self.socket_path}"
            )
        try:
            self.socket_path.unlink()
        except FileNotFoundError:
            pass
        server = await asyncio.start_unix_server(self._handle, path=str(self.socket_path))
        try:
            os.chmod(self.socket_path, 0o600)
        except OSError:
            pass
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        if self.idle_timeout_s > 0:
            self._idle_watcher_task = asyncio.create_task(self._idle_watcher_loop())
        return server

    async def stop(self) -> None:
        for task in (self._heartbeat_task, self._idle_watcher_task):
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        for w in list(self.clients):
            try:
                w.close()
            except Exception:
                pass

    async def broadcast(self, event: dict[str, Any]) -> None:
        """Push a delta frame to every connected client."""
        frame = json.dumps({"type": "delta", "event": event}, separators=(",", ":"))
        await self._broadcast_raw(frame)

    async def _broadcast_raw(self, frame: str) -> None:
        async with self.lock:
            dead: list[asyncio.StreamWriter] = []
            for w in self.clients:
                try:
                    w.write((frame + "\n").encode("utf-8"))
                    await w.drain()
                except Exception:
                    dead.append(w)
            for w in dead:
                self.clients.discard(w)
                try:
                    w.close()
                except Exception:
                    pass
            # If dead-writer eviction drained the last client, start the idle
            # clock so the idle watcher can eventually shut the daemon down.
            if dead and not self.clients:
                self._idle_since = time.monotonic()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        # On connect: send snapshot.
        try:
            snap = json.dumps({
                "type": "snapshot",
                "ts": _iso(),
                "state": self.state.to_snapshot(),
            }, separators=(",", ":"))
            writer.write((snap + "\n").encode("utf-8"))
            await writer.drain()
        except Exception:
            try:
                writer.close()
            except Exception:
                pass
            return

        async with self.lock:
            self.clients.add(writer)
            # A client is now connected — clear the idle clock.
            self._idle_since = None

        # Drain incoming control frames (subscribe / filter), but the
        # daemon's policy is "every connected client is subscribed to all
        # deltas"; we accept-and-ignore for forward compatibility.
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                # Future: handle filter / unsubscribe ops here.
        except Exception:
            pass
        finally:
            async with self.lock:
                self.clients.discard(writer)
                # If this was the last client, start the idle countdown.
                if not self.clients:
                    self._idle_since = time.monotonic()
            try:
                writer.close()
            except Exception:
                pass

    async def _idle_watcher_loop(self) -> None:
        """Periodically check whether the daemon has been client-free too long.

        Tick every 10 s.  When no client has been connected for at least
        ``idle_timeout_s`` seconds, log a single line and invoke the shutdown
        callback (which sets the stop event in ``_run``, triggering the normal
        SIGTERM teardown path).

        The check is skipped when ``idle_timeout_s <= 0`` (disabled) — the
        task is not even started in that case; this branch exists only as a
        belt-and-suspenders guard.
        """
        _TICK = 10.0
        try:
            while True:
                await asyncio.sleep(_TICK)
                if self.idle_timeout_s <= 0:
                    continue
                async with self.lock:
                    idle_since = self._idle_since
                    n_clients = len(self.clients)
                if n_clients > 0 or idle_since is None:
                    continue
                elapsed = time.monotonic() - idle_since
                if elapsed >= self.idle_timeout_s:
                    print(
                        f"ares-watchd: no clients for {elapsed:.0f}s, shutting down",
                        file=sys.stderr,
                    )
                    if self._shutdown_cb is not None:
                        self._shutdown_cb()
                    return
        except asyncio.CancelledError:
            return

    async def _heartbeat_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(self.heartbeat_s)
                frame = json.dumps({"type": "heartbeat", "ts": _iso()}, separators=(",", ":"))
                await self._broadcast_raw(frame)
        except asyncio.CancelledError:
            return
