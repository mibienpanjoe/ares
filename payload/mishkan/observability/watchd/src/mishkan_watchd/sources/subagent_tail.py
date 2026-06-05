"""Subagent JSONL tail — captures tool calls made BY subagents.

Claude Code runs subagents (Task tool) in a sandboxed sub-session. Their
tool calls do NOT fire the parent's PostToolUse hook — they are logged
to a separate JSONL under:

    ~/.claude/projects/<encoded-cwd>/<parent-sid>/subagents/agent-<id>.jsonl

and a sibling `agent-<id>.meta.json` carries {agentType, description,
toolUseId}. This source watches that directory per active parent
session, tails each agent JSONL from end-of-file, and synthesises
tool_call events tagged with:

    session = parent_sid
    agent   = agentType (from meta.json)
    tool    = tool_use.name
    payload = {tool_use_id, input_excerpt}

so the Agents tab can show real history for ezra / jakin / etc.

Failure modes are silent — missing meta.json, malformed line, IO
error: skip and continue. Observability never breaks the daemon.
"""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


def _iso(ts: float | None = None) -> str:
    t = datetime.fromtimestamp(ts or time.time(), tz=timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


class _SubagentTailer:
    """One tailer per subagent JSONL file."""

    def __init__(self, parent_sid: str, jsonl_path: Path,
                 queue: asyncio.Queue[dict[str, Any]]) -> None:
        self.parent_sid = parent_sid
        self.path = jsonl_path
        self.queue = queue
        # Start at end of file — only NEW tool calls going forward.
        try:
            self.offset = jsonl_path.stat().st_size
        except OSError:
            self.offset = 0
        # Read sibling meta.json for agent name.
        self.agent_name = "?"
        self.tool_use_id: Optional[str] = None
        meta = jsonl_path.with_suffix(".meta.json")
        if meta.exists():
            try:
                m = json.loads(meta.read_text())
                self.agent_name = m.get("agentType") or m.get("subagent_type") or "?"
                self.tool_use_id = m.get("toolUseId")
            except Exception:
                pass

    async def step(self) -> None:
        try:
            size = self.path.stat().st_size
        except OSError:
            return
        if self.offset > size:
            self.offset = 0
        if self.offset == size:
            return
        try:
            with open(self.path, "rb") as fh:
                fh.seek(self.offset)
                buf = fh.read()
        except OSError:
            return
        text = buf.decode("utf-8", errors="replace")
        last_nl = text.rfind("\n")
        if last_nl == -1:
            return
        complete = text[: last_nl + 1]
        self.offset += len(complete.encode("utf-8", errors="replace"))
        for raw in complete.splitlines():
            if not raw.strip():
                continue
            try:
                obj = json.loads(raw)
            except Exception:
                continue
            if not isinstance(obj, dict):
                continue
            await self._scan(obj)

    async def _scan(self, obj: dict[str, Any]) -> None:
        # Only assistant turns carry tool_use blocks.
        if obj.get("type") != "assistant":
            return
        msg = obj.get("message") or {}
        content = msg.get("content") or []
        if not isinstance(content, list):
            return
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") != "tool_use":
                continue
            tool_name = part.get("name") or "?"
            input_repr = part.get("input")
            input_excerpt = ""
            if isinstance(input_repr, dict):
                # Pick a short representative field if present.
                for k in ("file_path", "command", "query", "url", "skill",
                          "subagent_type", "pattern"):
                    if k in input_repr:
                        v = input_repr[k]
                        if isinstance(v, str):
                            input_excerpt = v[:120]
                            break
                if not input_excerpt:
                    input_excerpt = json.dumps(input_repr)[:120]
            await self.queue.put({
                "ts": _iso(),
                "session": self.parent_sid,
                "project": None,
                "agent": self.agent_name,
                "subagent_id": self.tool_use_id,
                "type": "tool_call",
                "tool": tool_name,
                "outcome": "completed",
                "payload": {
                    "source": "subagent_tail",
                    "tool_use_id": part.get("id"),
                    "input_excerpt": input_excerpt,
                },
            })


def _scan_subagent_dirs(projects_dir: Path,
                        active_sessions: dict[str, Path]) -> list[tuple[str, Path]]:
    """Return (parent_sid, agent_jsonl_path) for every subagent file under
    each active session's subagents/ folder.
    """
    out: list[tuple[str, Path]] = []
    for parent_sid, parent_jsonl in active_sessions.items():
        # Subagents dir is sibling of the parent JSONL file:
        #   <parent_jsonl>.parent / <parent_sid> / subagents
        # parent_jsonl already lives in projects/<encoded>/<sid>.jsonl
        # so the subagents dir is projects/<encoded>/<sid>/subagents/
        try:
            base = parent_jsonl.parent
            subdir = base / parent_sid / "subagents"
            if not subdir.is_dir():
                continue
            for f in subdir.glob("agent-*.jsonl"):
                out.append((parent_sid, f))
        except Exception:
            continue
    return out


async def run(queue: asyncio.Queue[dict[str, Any]],
              active_sessions_provider, poll_interval: float = 3.0) -> None:
    """Watch every active parent session's subagents/ dir."""
    tailers: dict[Path, _SubagentTailer] = {}
    try:
        while True:
            try:
                active = active_sessions_provider() or {}
            except Exception:
                active = {}
            # Discover any new subagent JSONLs.
            try:
                projects_dir = Path()  # unused — paths derived from parent jsonl
                discovered = _scan_subagent_dirs(projects_dir, active)
            except Exception:
                discovered = []
            for parent_sid, jsonl_path in discovered:
                if jsonl_path not in tailers:
                    tailers[jsonl_path] = _SubagentTailer(parent_sid, jsonl_path, queue)
            # Prune tailers whose parent session is no longer active.
            active_paths = {p for _, p in discovered}
            for path in list(tailers.keys()):
                if path not in active_paths:
                    tailers.pop(path, None)
            # Step each tailer.
            for t in list(tailers.values()):
                try:
                    await t.step()
                except Exception:
                    continue
            await asyncio.sleep(poll_interval)
    except asyncio.CancelledError:
        return
