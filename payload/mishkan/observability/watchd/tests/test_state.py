"""Smoke tests for HarnessState event application."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from mishkan_watchd.state import HarnessState


def test_agent_spawn_creates_session_and_agent():
    """tool_use_id is the key; display name is preserved in AgentState.name."""
    s = HarnessState()
    s.apply({"ts": "x", "session": "sess-1", "type": "session_start", "project": "/tmp/proj"})
    s.apply({
        "ts": "2026-06-05T12:00:00.000Z",
        "session": "sess-1",
        "project": "/tmp/proj",
        "type": "agent_spawn",
        "tool": "Task",
        "agent": "bezalel",
        "payload": {"subagent_type": "bezalel", "tool_use_id": "toolu_abc123"},
    })
    assert "sess-1" in s.sessions
    agents = s.sessions["sess-1"].agents_active
    # Keyed by tool_use_id, not bare agent name.
    assert "toolu_abc123" in agents
    assert agents["toolu_abc123"].name == "bezalel"
    assert agents["toolu_abc123"].status == "running"


def test_agent_spawn_complete_pair_by_tool_use_id():
    """spawn + complete keyed by tool_use_id correctly decrements active count."""
    s = HarnessState()
    s.apply({"ts": "x", "session": "s", "type": "session_start", "project": "/p"})
    # Spawn two concurrent agents with the same subagent_type.
    for tid in ("tid-1", "tid-2"):
        s.apply({
            "ts": "x", "session": "s", "type": "agent_spawn", "tool": "Task",
            "agent": "bezalel",
            "payload": {"subagent_type": "bezalel", "tool_use_id": tid},
        })
    assert len(s.sessions["s"].agents_active) == 2
    # Complete the first one.
    s.apply({
        "ts": "y", "session": "s", "type": "agent_complete", "tool": "Task",
        "agent": "bezalel",
        "payload": {"subagent_type": "bezalel", "tool_use_id": "tid-1"},
    })
    agents = s.sessions["s"].agents_active
    assert "tid-1" not in agents
    assert "tid-2" in agents
    assert len(agents) == 1


def test_agent_spawn_legacy_fallback_no_tool_use_id():
    """Legacy events without tool_use_id still key by agent name."""
    s = HarnessState()
    s.apply({"ts": "x", "session": "s", "type": "session_start", "project": "/p"})
    s.apply({
        "ts": "x", "session": "s", "type": "agent_spawn", "tool": "Task",
        "agent": "caleb",
        "payload": {"subagent_type": "caleb"},
    })
    assert "caleb" in s.sessions["s"].agents_active


def test_token_usage_accumulates_per_session():
    s = HarnessState()
    s.apply({"ts": "x", "session": "sess-tok", "type": "session_start", "project": "/p"})
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
    s.apply({"ts": "x", "session": "snap", "type": "session_start", "project": "/p"})
    s.apply({
        "ts": "x", "session": "snap", "project": "/p",
        "type": "agent_spawn", "tool": "Task", "agent": "caleb",
        "payload": {"subagent_type": "caleb", "tool_use_id": "toolu_snap1"},
    })
    snap = s.to_snapshot()
    # Agent is present and keyed by tool_use_id.
    assert "toolu_snap1" in snap["sessions"]["snap"]["agents_active"]
    # Round-trips through JSON without error.
    json.dumps(snap, default=str)


def test_graphify_hook_event_increments_scan_count():
    """graphify_scan from the Bash hook (no stats_only) increments scans."""
    s = HarnessState()
    assert s.graphify.scans == 0
    s.apply({
        "ts": "x", "session": None, "type": "graphify_scan",
        "payload": {"project": "/p", "nodes": 100, "edges": 200},
    })
    assert s.graphify.scans == 1
    assert s.graphify.nodes == 100
    assert s.graphify.edges == 200


def test_graphify_tail_stats_only_does_not_increment_scan_count():
    """graphify_scan with stats_only=True updates sizes but not the counter."""
    s = HarnessState()
    s.apply({
        "ts": "x", "session": None, "type": "graphify_scan",
        "payload": {
            "project": "/p", "nodes": 2798, "edges": 3102,
            "stats_only": True,
        },
    })
    assert s.graphify.scans == 0
    assert s.graphify.nodes == 2798
    assert s.graphify.edges == 3102


def test_graphify_query_hook_event_increments_query_count():
    """graphify_query from the Bash hook increments queries."""
    s = HarnessState()
    s.apply({"ts": "x", "session": "sq", "type": "session_start", "project": "/p"})
    s.apply({
        "ts": "x", "session": "sq", "type": "graphify_query",
        "payload": {"project": "/p", "question": "who calls process_payment"},
    })
    assert s.graphify.queries == 1
    assert s.graphify.last_query_text == "who calls process_payment"


def test_unknown_event_type_is_ignored_gracefully():
    s = HarnessState()
    s.apply({"ts": "x", "session": "weird", "type": "session_start", "project": "/p"})
    s.apply({"ts": "y", "session": "weird", "type": "completely_unknown_type"})
    # Session exists from session_start; unknown type triggers no exception.
    assert "weird" in s.sessions


if __name__ == "__main__":
    test_agent_spawn_creates_session_and_agent()
    test_agent_spawn_complete_pair_by_tool_use_id()
    test_agent_spawn_legacy_fallback_no_tool_use_id()
    test_token_usage_accumulates_per_session()
    test_session_stop_removes_session()
    test_snapshot_serializes_cleanly()
    test_graphify_hook_event_increments_scan_count()
    test_graphify_tail_stats_only_does_not_increment_scan_count()
    test_graphify_query_hook_event_increments_query_count()
    test_unknown_event_type_is_ignored_gracefully()
    print("all state tests passed")
