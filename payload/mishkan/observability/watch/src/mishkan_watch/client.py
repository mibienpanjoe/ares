"""Daemon socket client — connects to ares-watchd UNIX socket.

NDJSON snapshot+delta+heartbeat protocol. The client receives the initial
snapshot then a continuous stream of frames; each frame is dispatched to
the App via an async callback.

Reconnect on disconnect with exponential backoff (capped at 30 s). The
UI degrades to "daemon offline" status when no heartbeat in 10 s.
"""
from __future__ import annotations

import asyncio
import json
import os
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional


def _runtime_home() -> Path:
    if os.environ.get("ARES_HOME"):
        return Path(os.path.expanduser(os.environ["ARES_HOME"]))
    if os.environ.get("MISHKAN_HOME"):
        return Path(os.path.expanduser(os.environ["MISHKAN_HOME"]))
    home = Path(os.path.expanduser("~"))
    if (home / ".ares").exists() or not (home / ".claude" / "mishkan").exists():
        return home / ".ares"
    return home / ".claude" / "mishkan"


RUNTIME_HOME = _runtime_home()
DEFAULT_SOCKET = RUNTIME_HOME / "run" / "watch.sock"
DEBUG_LOG = Path(os.path.expanduser(
    os.environ.get("ARES_LOG_DIR")
    or os.environ.get("MISHKAN_LOG_DIR")
    or str(RUNTIME_HOME / "logs")
)) / "_tui-debug.log"


def _dlog(msg: str) -> None:
    """Append-only diagnostic log so we can see what the TUI actually does
    in production. Fail-open."""
    try:
        DEBUG_LOG.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(tz=timezone.utc).strftime("%H:%M:%S.%f")[:-3]
        with open(DEBUG_LOG, "a") as fh:
            fh.write(f"[{ts}] {msg}\n")
    except Exception:
        return


class DaemonClient:
    """Async client to the ares-watchd UNIX socket."""

    def __init__(self, socket_path: Path | None = None) -> None:
        self.socket_path = socket_path or DEFAULT_SOCKET
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._task: Optional[asyncio.Task] = None
        self._on_frame: Optional[Callable[[dict[str, Any]], Awaitable[None]]] = None
        self._on_status: Optional[Callable[[str], Awaitable[None]]] = None
        self._stop = asyncio.Event()

    async def start(self,
                    on_frame: Callable[[dict[str, Any]], Awaitable[None]],
                    on_status: Callable[[str], Awaitable[None]]) -> None:
        self._on_frame = on_frame
        self._on_status = on_status
        self._task = asyncio.create_task(self._run_with_backoff(), name="daemon-client")

    async def stop(self) -> None:
        self._stop.set()
        if self._writer:
            try:
                self._writer.close()
            except Exception:
                pass
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run_with_backoff(self) -> None:
        delay = 1.0
        _dlog(f"client._run_with_backoff start socket={self.socket_path}")
        while not self._stop.is_set():
            try:
                await self._connect_and_read()
                _dlog("client._connect_and_read returned cleanly")
                delay = 1.0  # reset on clean exit
            except Exception as e:
                _dlog(f"client EXCEPTION in connect_and_read: {type(e).__name__}: {e}\n{traceback.format_exc()}")
                if self._on_status:
                    await self._on_status(f"daemon offline: {e}")
            await asyncio.sleep(delay)
            delay = min(delay * 2.0, 30.0)

    async def _connect_and_read(self) -> None:
        if not self.socket_path.exists():
            _dlog(f"client: socket {self.socket_path} MISSING")
            raise FileNotFoundError(f"socket {self.socket_path} not found")
        # The snapshot frame can exceed asyncio's default 64 KB readline
        # limit when many sessions × many recent_events are aggregated.
        # 16 MB is generous enough for any realistic harness state.
        _dlog("client: opening unix connection limit=16MB")
        self._reader, self._writer = await asyncio.open_unix_connection(
            str(self.socket_path), limit=2 ** 24
        )
        _dlog("client: connected")
        if self._on_status:
            await self._on_status("connected")
        # Optional: announce subscription. Server accepts and ignores for now.
        try:
            self._writer.write(b'{"op":"subscribe"}\n')
            await self._writer.drain()
            _dlog("client: subscribe sent")
        except Exception as e:
            _dlog(f"client: subscribe send failed: {e}")
        frames_seen = {"snapshot": 0, "delta": 0, "heartbeat": 0, "other": 0}
        try:
            while not self._stop.is_set():
                line = await self._reader.readline()
                if not line:
                    _dlog("client: readline got empty (closed)")
                    raise ConnectionError("daemon closed connection")
                _dlog(f"client: readline got {len(line)} bytes")
                try:
                    frame = json.loads(line)
                except json.JSONDecodeError as e:
                    _dlog(f"client: json decode failed: {e}; head={line[:120]!r}")
                    continue
                ftype = frame.get("type", "other")
                frames_seen[ftype] = frames_seen.get(ftype, 0) + 1
                _dlog(f"client: frame type={ftype} totals={frames_seen}")
                if self._on_frame:
                    try:
                        await self._on_frame(frame)
                    except Exception as e:
                        _dlog(f"client: _on_frame raised: {type(e).__name__}: {e}\n{traceback.format_exc()}")
        finally:
            _dlog(f"client: loop exiting frames_seen={frames_seen}")
            try:
                if self._writer:
                    self._writer.close()
            except Exception:
                pass
            self._reader = self._writer = None
