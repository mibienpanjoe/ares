"""Daemon socket client — connects to mishkan-watchd UNIX socket.

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
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional


DEFAULT_SOCKET = Path(os.path.expanduser("~/.claude/mishkan/run/watch.sock"))


class DaemonClient:
    """Async client to the mishkan-watchd UNIX socket."""

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
        while not self._stop.is_set():
            try:
                await self._connect_and_read()
                delay = 1.0  # reset on clean exit
            except Exception as e:
                if self._on_status:
                    await self._on_status(f"daemon offline: {e}")
            await asyncio.sleep(delay)
            delay = min(delay * 2.0, 30.0)

    async def _connect_and_read(self) -> None:
        if not self.socket_path.exists():
            raise FileNotFoundError(f"socket {self.socket_path} not found")
        self._reader, self._writer = await asyncio.open_unix_connection(str(self.socket_path))
        if self._on_status:
            await self._on_status("connected")
        # Optional: announce subscription. Server accepts and ignores for now.
        try:
            self._writer.write(b'{"op":"subscribe"}\n')
            await self._writer.drain()
        except Exception:
            pass
        try:
            while not self._stop.is_set():
                line = await self._reader.readline()
                if not line:
                    raise ConnectionError("daemon closed connection")
                try:
                    frame = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if self._on_frame:
                    await self._on_frame(frame)
        finally:
            try:
                if self._writer:
                    self._writer.close()
            except Exception:
                pass
            self._reader = self._writer = None
