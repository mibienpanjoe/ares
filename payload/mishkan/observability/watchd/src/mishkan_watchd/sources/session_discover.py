"""Session discover source — glob ~/.claude/projects/*/*.jsonl.

Detects active Claude Code sessions by file mtime. Emits synthetic
session_start / session_stop bus events. A session is "active" if its
JSONL has been written to in the last 60 s.
"""
from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _iso(ts: float | None = None) -> str:
    t = datetime.fromtimestamp(ts or time.time(), tz=timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


async def run(queue: asyncio.Queue[dict[str, Any]], projects_dir: Path,
              poll_interval: float = 10.0, active_window_s: float = 60.0) -> None:
    """Poll active sessions and emit session_start / session_stop deltas."""
    known: dict[str, dict[str, Any]] = {}  # session_id -> {project, mtime}
    try:
        while True:
            now = time.time()
            seen: set[str] = set()
            try:
                for jsonl in projects_dir.glob("*/*.jsonl"):
                    try:
                        st = jsonl.stat()
                    except OSError:
                        continue
                    if (now - st.st_mtime) > active_window_s:
                        continue
                    session_id = jsonl.stem
                    project = jsonl.parent.name
                    seen.add(session_id)
                    if session_id not in known:
                        known[session_id] = {"project": project, "mtime": st.st_mtime}
                        await queue.put({
                            "ts": _iso(now),
                            "session": session_id,
                            "project": project,
                            "type": "session_start",
                            "tool": None,
                            "outcome": "completed",
                            "payload": {"jsonl_path": str(jsonl)},
                        })
                    else:
                        known[session_id]["mtime"] = st.st_mtime
            except OSError:
                pass

            # Detect dropped sessions (no recent mtime, not in seen).
            for sid in list(known.keys()):
                if sid not in seen and (now - known[sid]["mtime"]) > active_window_s:
                    project = known[sid]["project"]
                    known.pop(sid, None)
                    await queue.put({
                        "ts": _iso(now),
                        "session": sid,
                        "project": project,
                        "type": "session_stop",
                        "tool": None,
                        "outcome": "completed",
                        "payload": {},
                    })

            await asyncio.sleep(poll_interval)
    except asyncio.CancelledError:
        return
