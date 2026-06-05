"""Bus tail source — inotify on ~/.claude/mishkan/logs/*.jsonl.

Picks up every new line from the Phase 1+1.5 emitters: tool_call,
file_change, hook_fire, agent_spawn, skill_invoke, plan, web_query,
cron_event, error, token_usage. Pushes each parsed event into the
shared queue.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer


class _TailHandler(FileSystemEventHandler):
    def __init__(self, queue: asyncio.Queue[dict[str, Any]], loop: asyncio.AbstractEventLoop) -> None:
        self.queue = queue
        self.loop = loop
        self.offsets: dict[str, int] = {}

    def on_modified(self, event):  # type: ignore[override]
        if event.is_directory:
            return
        path = event.src_path
        if not path.endswith(".jsonl"):
            return
        self._drain(path)

    def on_created(self, event):  # type: ignore[override]
        if event.is_directory:
            return
        if event.src_path.endswith(".jsonl"):
            self.offsets[event.src_path] = 0
            self._drain(event.src_path)

    def _drain(self, path: str) -> None:
        try:
            size = os.path.getsize(path)
        except OSError:
            return
        off = self.offsets.get(path, 0)
        if off > size:
            off = 0
        if off == size:
            return
        try:
            with open(path, "rb") as fh:
                fh.seek(off)
                buf = fh.read()
        except OSError:
            return
        text = buf.decode("utf-8", errors="replace")
        last_nl = text.rfind("\n")
        if last_nl == -1:
            return
        complete = text[: last_nl + 1]
        self.offsets[path] = off + len(complete.encode("utf-8", errors="replace"))
        for raw in complete.splitlines():
            if not raw.strip():
                continue
            try:
                event = json.loads(raw)
            except Exception:
                continue
            if not isinstance(event, dict):
                continue
            # Thread-safe push into the asyncio queue.
            asyncio.run_coroutine_threadsafe(self.queue.put(event), self.loop)


async def run(queue: asyncio.Queue[dict[str, Any]], log_dir: Path) -> None:
    """Start a watchdog observer on log_dir. Backfills existing files first."""
    log_dir.mkdir(parents=True, exist_ok=True)
    loop = asyncio.get_running_loop()
    handler = _TailHandler(queue, loop)

    # Backfill: read each existing file from offset 0.
    for f in log_dir.glob("*.jsonl"):
        handler._drain(str(f))

    observer = Observer()
    observer.schedule(handler, str(log_dir), recursive=False)
    observer.start()
    try:
        # Block forever — watchdog runs its own thread.
        while True:
            await asyncio.sleep(3600)
    except asyncio.CancelledError:
        pass
    finally:
        observer.stop()
        observer.join(timeout=1.0)
