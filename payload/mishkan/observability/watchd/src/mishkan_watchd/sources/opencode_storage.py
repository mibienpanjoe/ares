"""OpenCode storage source.

OpenCode stores runtime state as JSON records under:

  storage/session/<project-id>/<session-id>.json
  storage/message/<session-id>/<message-id>.json
  storage/part/<message-id>/<part-id>.json

This source polls those files and maps newly-written records into ARES bus
events. It is intentionally passive: no OpenCode hook support is assumed.
"""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _iso(ts: float | None = None) -> str:
    t = datetime.fromtimestamp(ts or time.time(), tz=timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def _iso_ms(ms: int | float | None) -> str:
    try:
        return _iso(float(ms) / 1000.0)
    except Exception:
        return _iso()


def _load_json(path: Path) -> dict[str, Any] | None:
    try:
        obj = json.loads(path.read_text())
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def _storage_root(data_dir: Path) -> Path:
    return data_dir / "storage" if (data_dir / "storage").is_dir() else data_dir


def _session_files(data_dir: Path) -> list[Path]:
    root = _storage_root(data_dir)
    session_dir = root / "session"
    if not session_dir.is_dir():
        return []
    return list(session_dir.glob("*/*.json"))


def _message_files(data_dir: Path, raw_session_id: str) -> list[Path]:
    root = _storage_root(data_dir)
    msg_dir = root / "message" / raw_session_id
    if not msg_dir.is_dir():
        return []
    return list(msg_dir.glob("*.json"))


def _part_files(data_dir: Path, message_id: str) -> list[Path]:
    root = _storage_root(data_dir)
    part_dir = root / "part" / message_id
    if not part_dir.is_dir():
        return []
    return list(part_dir.glob("*.json"))


def _existing_message_and_part_paths(data_dir: Path, raw_session_id: str) -> tuple[set[Path], set[Path]]:
    """Return current OpenCode message/part paths for startup de-duplication.

    Like the JSONL tailer, OpenCode observation starts at the current end of
    storage to avoid flooding the bus with historical sessions on daemon start.
    """
    messages = set(_message_files(data_dir, raw_session_id))
    parts: set[Path] = set()
    for msg_path in messages:
        message_id = msg_path.stem
        parts.update(_part_files(data_dir, message_id))
    return messages, parts


def _session_start_event(session_path: Path, session_obj: dict[str, Any]) -> dict[str, Any] | None:
    raw_session_id = session_obj.get("id") or session_path.stem
    if not raw_session_id:
        return None
    directory = session_obj.get("directory")
    project = directory or session_obj.get("projectID") or session_path.parent.name or "opencode"
    updated = (session_obj.get("time") or {}).get("updated") or session_path.stat().st_mtime * 1000
    return {
        "ts": _iso_ms(updated),
        "session": f"opencode:{raw_session_id}",
        "project": project,
        "runtime": "opencode",
        "type": "session_start",
        "tool": None,
        "outcome": "completed",
        "payload": {
            "runtime": "opencode",
            "raw_session_id": raw_session_id,
            "jsonl_path": str(session_path),
            "session_path": str(session_path),
            "directory": directory,
            "project_id": session_obj.get("projectID"),
            "title": session_obj.get("title"),
        },
    }


def _message_events(message_obj: dict[str, Any]) -> list[dict[str, Any]]:
    raw_session_id = message_obj.get("sessionID")
    if not raw_session_id:
        return []
    sid = f"opencode:{raw_session_id}"
    ts = _iso_ms((message_obj.get("time") or {}).get("completed")
                 or (message_obj.get("time") or {}).get("created"))
    events: list[dict[str, Any]] = []
    tokens = message_obj.get("tokens") or {}
    if tokens:
        cache = tokens.get("cache") or {}
        events.append({
            "ts": ts,
            "session": sid,
            "project": (message_obj.get("path") or {}).get("cwd"),
            "runtime": "opencode",
            "type": "token_usage",
            "tool": None,
            "outcome": "completed",
            "agent": message_obj.get("agent"),
            "payload": {
                "runtime": "opencode",
                "message_id": message_obj.get("id"),
                "model": message_obj.get("modelID"),
                "provider": message_obj.get("providerID"),
                "tokens_in": int(tokens.get("input") or 0),
                "tokens_out": int(tokens.get("output") or 0),
                "cache_read": int(cache.get("read") or 0),
                "cache_write": int(cache.get("write") or 0),
                "reasoning_output_tokens": int(tokens.get("reasoning") or 0),
                "cost_estimate_usd": float(message_obj.get("cost") or 0.0),
            },
        })
    return events


def _part_event(part_obj: dict[str, Any]) -> dict[str, Any] | None:
    if part_obj.get("type") != "tool":
        return None
    raw_session_id = part_obj.get("sessionID")
    if not raw_session_id:
        return None
    state = part_obj.get("state") or {}
    status = state.get("status") or "unknown"
    timing = state.get("time") or {}
    return {
        "ts": _iso_ms(timing.get("end") or timing.get("start")),
        "session": f"opencode:{raw_session_id}",
        "project": None,
        "runtime": "opencode",
        "type": "tool_call",
        "tool": str(part_obj.get("tool") or "unknown"),
        "outcome": status,
        "payload": {
            "runtime": "opencode",
            "message_id": part_obj.get("messageID"),
            "part_id": part_obj.get("id"),
            "call_id": part_obj.get("callID"),
            "status": status,
        },
    }


async def run(queue: asyncio.Queue[dict[str, Any]], data_dir: Path,
              poll_interval: float = 3.0, active_window_s: float = 60.0) -> None:
    """Poll OpenCode storage and emit session/tool/token events."""
    known_sessions: dict[str, dict[str, Any]] = {}
    seen_messages: dict[str, set[Path]] = {}
    seen_parts: dict[str, set[Path]] = {}
    try:
        while True:
            now = time.time()
            active_raw_ids: set[str] = set()

            for session_path in _session_files(data_dir):
                try:
                    st = session_path.stat()
                except OSError:
                    continue
                if (now - st.st_mtime) > active_window_s:
                    continue
                session_obj = _load_json(session_path)
                if not session_obj:
                    continue
                raw_session_id = session_obj.get("id") or session_path.stem
                if not raw_session_id:
                    continue
                active_raw_ids.add(raw_session_id)
                sid = f"opencode:{raw_session_id}"
                if sid not in known_sessions:
                    event = _session_start_event(session_path, session_obj)
                    if event:
                        await queue.put(event)
                    known_sessions[sid] = {"path": session_path, "mtime": st.st_mtime}
                    existing_messages, existing_parts = _existing_message_and_part_paths(
                        data_dir, raw_session_id,
                    )
                    seen_messages[sid] = existing_messages
                    seen_parts[sid] = existing_parts
                else:
                    known_sessions[sid]["mtime"] = st.st_mtime

                for msg_path in _message_files(data_dir, raw_session_id):
                    if msg_path in seen_messages.setdefault(sid, set()):
                        continue
                    msg_obj = _load_json(msg_path)
                    if not msg_obj:
                        continue
                    seen_messages[sid].add(msg_path)
                    for event in _message_events(msg_obj):
                        await queue.put(event)
                    message_id = msg_obj.get("id") or msg_path.stem
                    for part_path in _part_files(data_dir, message_id):
                        if part_path in seen_parts.setdefault(sid, set()):
                            continue
                        part_obj = _load_json(part_path)
                        if not part_obj:
                            continue
                        seen_parts[sid].add(part_path)
                        event = _part_event(part_obj)
                        if event:
                            await queue.put(event)

            for sid in list(known_sessions.keys()):
                raw_id = sid.split(":", 1)[1]
                if raw_id not in active_raw_ids and (now - known_sessions[sid]["mtime"]) > active_window_s:
                    known = known_sessions.pop(sid, None) or {}
                    session_path = known.get("path")
                    await queue.put({
                        "ts": _iso(now),
                        "session": sid,
                        "project": None,
                        "runtime": "opencode",
                        "type": "session_stop",
                        "tool": None,
                        "outcome": "completed",
                        "payload": {
                            "runtime": "opencode",
                            "session_path": str(session_path) if session_path else None,
                        },
                    })
                    seen_messages.pop(sid, None)
                    seen_parts.pop(sid, None)

            await asyncio.sleep(poll_interval)
    except asyncio.CancelledError:
        return
