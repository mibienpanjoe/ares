"""Smoke tests for HarnessState event application."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from mishkan_watchd.state import HarnessState


def test_agent_spawn_creates_session_and_agent():
    s = HarnessState()
    s.apply({
        "ts": "2026-06-05T12:00:00.000Z",
        "session": "sess-1",
        "project": "/tmp/proj",
        "type": "agent_spawn",
        "tool": "Task",
        "agent": "bezalel",
        "payload": {"subagent_type": "bezalel"},
    })
    assert "sess-1" in s.sessions
    assert "bezalel" in s.sessions["sess-1"].agents_active
    assert s.sessions["sess-1"].agents_active["bezalel"].status == "running"


def test_token_usage_accumulates_per_session():
    s = HarnessState()
    for tin, tout in [(100, 20), (200, 40), (50, 10)]:
        s.apply({
            "ts": "2026-06-05T12:00:00.000Z",
            "session": "sess-tok",
            "type": "token_usage",
            "payload": {"tokens_in": tin, "tokens_out": tout, "cost_estimate_usd": 0.01},
        })
    sess = s.sessions["sess-tok"]
    assert sess.tokens_in == 350
    assert sess.tokens_out == 70
    assert abs(sess.cost_estimate_usd - 0.03) < 1e-9


def test_session_stop_removes_session():
    s = HarnessState()
    s.apply({"ts": "x", "session": "drop-me", "type": "session_start", "project": "/p"})
    assert "drop-me" in s.sessions
    s.apply({"ts": "y", "session": "drop-me", "type": "session_stop"})
    assert "drop-me" not in s.sessions


def test_snapshot_serializes_cleanly():
    import json
    s = HarnessState()
    s.apply({
        "ts": "x", "session": "snap", "project": "/p",
        "type": "agent_spawn", "tool": "Task", "agent": "caleb",
        "payload": {"subagent_type": "caleb"},
    })
    snap = s.to_snapshot()
    # Round-trips through JSON without error.
    json.dumps(snap, default=str)


def test_unknown_event_type_is_ignored_gracefully():
    s = HarnessState()
    s.apply({"ts": "x", "session": "weird", "type": "completely_unknown_type"})
    # Session is created but no specific state mutation; no exception.
    assert "weird" in s.sessions


if __name__ == "__main__":
    test_agent_spawn_creates_session_and_agent()
    test_token_usage_accumulates_per_session()
    test_session_stop_removes_session()
    test_snapshot_serializes_cleanly()
    test_unknown_event_type_is_ignored_gracefully()
    print("all state tests passed")
