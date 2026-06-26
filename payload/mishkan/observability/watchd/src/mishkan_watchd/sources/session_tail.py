"""Session JSONL tail — extract runtime events from active transcript files.

Tails active runtime JSONL files discovered by session_discover and synthesizes
events that hooks cannot observe directly:

  - Claude Code: inter_agent and compaction events.
  - Codex: tool_call, token_usage, and compaction events.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _iso(ts: float | None = None) -> str:
    t = datetime.fromtimestamp(ts or time.time(), tz=timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


class _SessionTailer:
    def __init__(self, session_id: str, jsonl_path: Path,
                 queue: asyncio.Queue[dict[str, Any]]) -> None:
        self.session_id = session_id
        self.path = jsonl_path
        self.queue = queue
        # Start at end of file — we only care about NEW assistant turns
        # going forward. Backfilling decades of history would flood the
        # bus with hundreds of inter_agent / compaction events per
        # session at daemon start.
        try:
            self.offset = jsonl_path.stat().st_size
        except OSError:
            self.offset = 0

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
        if self.session_id.startswith("codex:"):
            await self._scan_codex(obj)
            return

        otype = obj.get("type")
        # Compaction event: Claude Code logs these with type='summary' or
        # explicit type='compaction'. Cover both — fall back to a heuristic
        # if it ever changes shape.
        if otype in ("compaction", "summary"):
            await self.queue.put({
                "ts": _iso(),
                "session": self.session_id,
                "project": None,
                "type": "compaction",
                "tool": None,
                "outcome": "completed",
                "payload": {
                    "trigger": obj.get("trigger") or "auto",
                    "tokens_before": obj.get("tokens_before"),
                    "tokens_after": obj.get("tokens_after"),
                    "summary_excerpt": (obj.get("summary") or obj.get("text") or "")[:200],
                },
            })
            return
        # Inter-agent message: a tool_result entry of a Task call carrying
        # the subagent's final return text.
        if otype == "user":
            msg = obj.get("message") or {}
            content = msg.get("content") or []
            if isinstance(content, list):
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    if part.get("type") != "tool_result":
                        continue
                    tool_use_id = part.get("tool_use_id") or ""
                    result_content = part.get("content") or ""
                    if isinstance(result_content, list):
                        # Flatten {type:text, text:...} parts.
                        result_content = "\n".join(
                            p.get("text", "") for p in result_content
                            if isinstance(p, dict) and p.get("type") == "text"
                        )
                    text = str(result_content)
                    if not text.strip():
                        continue
                    await self.queue.put({
                        "ts": _iso(),
                        "session": self.session_id,
                        "project": None,
                        "type": "inter_agent",
                        "tool": "Task",
                        "outcome": "completed",
                        "payload": {
                            "tool_use_id": tool_use_id,
                            "summary": text[:500],
                        },
                    })

    async def _scan_codex(self, obj: dict[str, Any]) -> None:
        """Parse the Codex CLI JSONL shape observed in ~/.codex/sessions.

        The current Codex transcript stores records as top-level types such as
        session_meta, event_msg, response_item, turn_context, and compacted.
        The payload carries the actionable sub-type.
        """
        otype = obj.get("type")
        payload = obj.get("payload") or {}
        ptype = payload.get("type")
        ts = obj.get("timestamp") or _iso()

        if otype == "session_meta":
            return

        if otype == "compacted" or ptype == "context_compacted":
            await self.queue.put({
                "ts": ts,
                "session": self.session_id,
                "project": None,
                "runtime": "codex",
                "type": "compaction",
                "tool": None,
                "outcome": "completed",
                "payload": {"runtime": "codex", "trigger": "context_compacted"},
            })
            return

        if otype == "response_item" and ptype in ("function_call", "custom_tool_call"):
            name = payload.get("name") or payload.get("call_name") or payload.get("tool")
            if not name:
                return
            await self.queue.put({
                "ts": ts,
                "session": self.session_id,
                "project": None,
                "runtime": "codex",
                "type": "tool_call",
                "tool": str(name),
                "outcome": "started",
                "payload": {
                    "runtime": "codex",
                    "call_id": payload.get("call_id") or payload.get("id"),
                    "kind": ptype,
                },
            })
            return

        if otype == "event_msg" and ptype == "token_count":
            info = payload.get("info") or {}
            usage = info.get("last_token_usage") or {}
            await self.queue.put({
                "ts": ts,
                "session": self.session_id,
                "project": None,
                "runtime": "codex",
                "type": "token_usage",
                "tool": None,
                "outcome": "completed",
                "payload": {
                    "runtime": "codex",
                    "tokens_in": int(usage.get("input_tokens") or 0),
                    "tokens_out": int(usage.get("output_tokens") or 0),
                    "cache_read": int(usage.get("cached_input_tokens") or 0),
                    "cache_write": 0,
                    "reasoning_output_tokens": int(usage.get("reasoning_output_tokens") or 0),
                    "model_context_window": info.get("model_context_window"),
                },
            })


async def run(queue: asyncio.Queue[dict[str, Any]],
              active_sessions_provider, poll_interval: float = 3.0) -> None:
    """Tail JSONL of every active session returned by the provider.

    active_sessions_provider is a callable returning dict[session_id, Path]
    of currently-active session JSONLs.
    """
    tailers: dict[str, _SessionTailer] = {}
    try:
        while True:
            try:
                active = active_sessions_provider() or {}
            except Exception:
                active = {}
            # Add new tailers; prune gone sessions.
            for sid, path in active.items():
                if sid not in tailers:
                    tailers[sid] = _SessionTailer(sid, Path(path), queue)
            for sid in list(tailers.keys()):
                if sid not in active:
                    tailers.pop(sid, None)
            # Step each tailer.
            for t in list(tailers.values()):
                try:
                    await t.step()
                except Exception:
                    continue
            await asyncio.sleep(poll_interval)
    except asyncio.CancelledError:
        return
