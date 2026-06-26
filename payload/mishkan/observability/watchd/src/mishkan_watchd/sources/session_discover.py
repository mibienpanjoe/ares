"""Session discover source — glob runtime transcript JSONL files.

Detects active runtime sessions by file mtime. Emits synthetic session_start /
session_stop bus events. A session is "active" if its JSONL has been written to
in the active window.
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
              poll_interval: float = 10.0, active_window_s: float = 60.0,
              runtime: str = "claude", recursive: bool = False) -> None:
    """Poll active sessions and emit session_start / session_stop deltas."""
    known: dict[str, dict[str, Any]] = {}  # session_id -> {project, mtime}
    try:
        while True:
            now = time.time()
            seen: set[str] = set()
            try:
                iterator = projects_dir.rglob("*.jsonl") if recursive else projects_dir.glob("*/*.jsonl")
                for jsonl in iterator:
                    try:
                        st = jsonl.stat()
                    except OSError:
                        continue
                    if (now - st.st_mtime) > active_window_s:
                        continue
                    raw_session_id = jsonl.stem
                    session_id = raw_session_id if runtime == "claude" else f"{runtime}:{raw_session_id}"
                    project = _project_name(projects_dir, jsonl, runtime)
                    seen.add(session_id)
                    if session_id not in known:
                        known[session_id] = {"project": project, "mtime": st.st_mtime}
                        await queue.put({
                            "ts": _iso(now),
                            "session": session_id,
                            "project": project,
                            "runtime": runtime,
                            "type": "session_start",
                            "tool": None,
                            "outcome": "completed",
                            "payload": {
                                "jsonl_path": str(jsonl),
                                "runtime": runtime,
                                "raw_session_id": raw_session_id,
                            },
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
                        "runtime": runtime,
                        "type": "session_stop",
                        "tool": None,
                        "outcome": "completed",
                        "payload": {"runtime": runtime},
                    })

            await asyncio.sleep(poll_interval)
    except asyncio.CancelledError:
        return


def _project_name(root: Path, jsonl: Path, runtime: str) -> str:
    if runtime == "claude":
        return jsonl.parent.name
    try:
        rel = jsonl.relative_to(root)
        if len(rel.parts) > 1:
            return rel.parts[0]
    except Exception:
        pass
    return runtime
