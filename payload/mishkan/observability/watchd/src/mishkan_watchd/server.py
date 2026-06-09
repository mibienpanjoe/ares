"""UNIX socket server — NDJSON snapshot+delta protocol.

On client connect: send one {"type":"snapshot","state":{...}} frame,
then a stream of {"type":"delta",...} for every event, plus
{"type":"heartbeat","ts":"..."} every 5 s.

Protocol is intentionally simple:
  - One JSON object per line, LF-terminated.
  - No versioning, no auth beyond filesystem 0600 perms on the socket.
  - Clients connect, optionally send {"op":"subscribe"} (the server
    treats every client as subscribed by default), and read.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _iso() -> str:
    t = datetime.now(tz=timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


class WatchdServer:
    def __init__(self, socket_path: Path, state, heartbeat_s: float = 5.0) -> None:
        self.socket_path = socket_path
        self.state = state
        self.heartbeat_s = heartbeat_s
        self.clients: set[asyncio.StreamWriter] = set()
        self.lock = asyncio.Lock()
        self._heartbeat_task: asyncio.Task | None = None

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
                f"mishkan-watchd: daemon already running on {self.socket_path}"
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
        return server

    async def stop(self) -> None:
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
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
            try:
                writer.close()
            except Exception:
                pass

    async def _heartbeat_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(self.heartbeat_s)
                frame = json.dumps({"type": "heartbeat", "ts": _iso()}, separators=(",", ":"))
                await self._broadcast_raw(frame)
        except asyncio.CancelledError:
            return
