#!/usr/bin/env python3
"""MISHKAN observability — Phase 1.5 token usage parser.

Parses the Claude Code session JSONL `usage` blocks per assistant turn and
emits one `token_usage` event into the MISHKAN bus per new turn. Tracks
per-session byte offset so each turn is emitted exactly once.

Invoked best-effort from post-tool-observe.sh after the canonical tool_call
event. Fails open on any error path — observability never breaks a tool call.

Usage:
    python3 usage_parser.py <session_id>

Session JSONL is discovered at ~/.claude/projects/<encoded-cwd>/<session>.jsonl
(globbed across all projects, since the encoding scheme is brittle).

Pricing table is baked in (updated 2026-Q2 published rates); the daemon /
TUI status bar reads these `token_usage` events to compute the running cost
estimate shown in §7.4 of the observability design doc. Inaccurate model
pricing degrades the $-estimate gracefully — it never blocks the event.
"""
from __future__ import annotations

import json
import os
import sys
from glob import glob
from pathlib import Path
from typing import Any, Optional

# Make the bus emitter importable from this file's directory.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
try:
    from bus import emit as _bus_emit  # type: ignore
except Exception:
    def _bus_emit(*_a, **_k):  # noqa: ANN001
        return None


# Per-million-token prices in USD. Conservative defaults; update as needed.
# Cache read priced at 1/10 of input; cache creation at 1.25x input.
_MODEL_PRICES = {
    # Claude 4.x family
    "claude-fable-5": (10.0, 50.0),   # D-002 amend: Migdal+Mishmar specialists tier
    "claude-opus-4": (15.0, 75.0),
    "claude-sonnet-4": (3.0, 15.0),
    "claude-haiku-4": (0.80, 4.0),
    # 3.x family (commonly still appears in older sessions)
    "claude-3-5-sonnet": (3.0, 15.0),
    "claude-3-5-haiku": (0.80, 4.0),
    "claude-3-opus": (15.0, 75.0),
}


def _state_path(session: str) -> Path:
    state_dir = Path(
        os.environ.get("MISHKAN_STATE_DIR")
        or os.path.expanduser("~/.claude/mishkan/state")
    )
    state_dir.mkdir(parents=True, exist_ok=True)
    return state_dir / f"usage-offset-{session}.txt"


def _last_offset(session: str) -> int:
    p = _state_path(session)
    try:
        return int(p.read_text().strip())
    except Exception:
        return 0


def _write_offset(session: str, off: int) -> None:
    try:
        _state_path(session).write_text(str(off))
    except Exception:
        return


def _find_session_jsonl(session: str) -> Optional[Path]:
    """Discover the active session's JSONL across all projects."""
    base = os.path.expanduser("~/.claude/projects")
    candidates = glob(os.path.join(base, "*", f"{session}.jsonl"))
    if not candidates:
        return None
    # If somehow multiple, pick the most recently modified.
    candidates.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return Path(candidates[0])


def _model_rate(model: str) -> tuple[float, float]:
    """Look up (input_rate, output_rate) per-million-token USD for a model id."""
    m = (model or "").lower()
    # Match longest prefix first to handle versioned ids like
    # claude-opus-4-7-20260101 -> claude-opus-4
    for key in sorted(_MODEL_PRICES.keys(), key=len, reverse=True):
        if m.startswith(key):
            return _MODEL_PRICES[key]
    return (0.0, 0.0)  # unknown model -> cost stays 0


def _cost(model: str, tokens_in: int, tokens_out: int,
          cache_read: int, cache_write: int) -> float:
    """Compute USD cost estimate. Cache read = 1/10 input, write = 1.25x input."""
    in_rate, out_rate = _model_rate(model)
    if in_rate == 0.0 and out_rate == 0.0:
        return 0.0
    cache_read_rate = in_rate * 0.10
    cache_write_rate = in_rate * 1.25
    total = (
        tokens_in * in_rate
        + tokens_out * out_rate
        + cache_read * cache_read_rate
        + cache_write * cache_write_rate
    )
    return total / 1_000_000.0


def parse_and_emit(session: str) -> int:
    """Read new lines since last offset, emit token_usage events. Returns count emitted."""
    if not session or session == "unknown":
        return 0

    src = _find_session_jsonl(session)
    if src is None or not src.exists():
        return 0

    try:
        size = src.stat().st_size
    except OSError:
        return 0

    off = _last_offset(session)
    if off > size:
        # File was truncated / rotated; reset to start.
        off = 0
    if off == size:
        return 0

    emitted = 0
    try:
        with open(src, "rb") as fh:
            fh.seek(off)
            new_bytes = fh.read()
        new_off = off + len(new_bytes)
        # Walk lines; tolerate partial final line by tracking last newline.
        text = new_bytes.decode("utf-8", errors="replace")
        last_nl = text.rfind("\n")
        if last_nl == -1:
            return 0  # no complete line yet
        complete = text[: last_nl + 1]
        # Adjust offset back to end of the last complete line.
        partial_len = len(new_bytes) - len(complete.encode("utf-8", errors="replace"))
        new_off -= partial_len

        for raw_line in complete.splitlines():
            if not raw_line.strip():
                continue
            try:
                obj = json.loads(raw_line)
            except Exception:
                continue
            if not isinstance(obj, dict):
                continue
            if obj.get("type") != "assistant":
                continue
            msg = obj.get("message")
            if not isinstance(msg, dict):
                continue
            usage = msg.get("usage")
            if not isinstance(usage, dict):
                continue
            model = msg.get("model") or "unknown"
            tokens_in = int(usage.get("input_tokens") or 0)
            tokens_out = int(usage.get("output_tokens") or 0)
            cache_read = int(usage.get("cache_read_input_tokens") or 0)
            cache_write = int(usage.get("cache_creation_input_tokens") or 0)
            cost = _cost(model, tokens_in, tokens_out, cache_read, cache_write)
            _bus_emit(
                session,
                "token_usage",
                tool=None,
                outcome="completed",
                payload={
                    "model": model,
                    "tokens_in": tokens_in,
                    "tokens_out": tokens_out,
                    "cache_read": cache_read,
                    "cache_write": cache_write,
                    "cost_estimate_usd": round(cost, 6),
                },
            )
            emitted += 1

        _write_offset(session, new_off)
    except Exception:
        return emitted

    return emitted


def main() -> None:
    session = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CLAUDE_SESSION_ID", "")
    try:
        parse_and_emit(session)
    except Exception:
        return


if __name__ == "__main__":
    main()
