"""ARES observability bus — Python emitter (stdlib only).

Same contract as bus.sh: append-only NDJSON, fail-open on every error path.
Use this from Python-based hooks (e.g. model-route.py) to avoid shelling out.

    from mishkan_bus import emit  # via sys.path injection or relative import
    emit(session, "hook_fire", payload={"hook": "model-route", "decision": "allow"})
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


def _log_dir() -> Optional[Path]:
    """Resolve and create the log directory. None on failure."""
    home = Path(os.path.expanduser("~"))
    runtime_home = (
        os.environ.get("ARES_HOME")
        or os.environ.get("MISHKAN_HOME")
        or (str(home / ".ares") if (home / ".ares").exists() or not (home / ".claude" / "mishkan").exists() else str(home / ".claude" / "mishkan"))
    )
    base = os.environ.get("ARES_LOG_DIR") or os.environ.get("MISHKAN_LOG_DIR") or str(Path(runtime_home) / "logs")
    try:
        p = Path(base)
        p.mkdir(parents=True, exist_ok=True)
        return p
    except Exception:
        return None


def _iso_ms() -> str:
    """UTC ISO-8601 with ms precision."""
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{datetime.now(tz=timezone.utc).microsecond // 1000:03d}Z"


def _iso_s() -> str:
    """UTC ISO-8601 with second precision (legacy)."""
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def emit(
    session: str,
    type: str,
    *,
    tool: Optional[str] = None,
    outcome: Optional[str] = None,
    payload: Optional[dict[str, Any]] = None,
    agent: Optional[str] = None,
    subagent_id: Optional[str] = None,
) -> None:
    """Append one event line to the session's NDJSON log. Fail-open on any error."""
    try:
        if not session or not type:
            return
        d = _log_dir()
        if d is None:
            return
        try:
            project = os.getcwd()
        except Exception:
            project = "unknown"
        event: dict[str, Any] = {
            "ts": _iso_ms(),
            "session": session,
            "project": project,
            "agent": agent,
            "subagent_id": subagent_id,
            "type": type,
            "tool": tool,
            "outcome": outcome,
            "payload": payload or {},
            # Back-compat fields (consumers of the original observe shape).
            "timestamp": _iso_s(),
            "tool_calls": [tool] if tool else [],
            "team": None,
            "sprint": None,
            "tokens_input": 0,
            "tokens_cached": 0,
            "tokens_output": 0,
            "cost": 0,
            "cognee_writes": 0,
        }
        line = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
        path = d / f"{session}.jsonl"
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        return
