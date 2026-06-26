"""Smoke tests for HarnessState event application."""
from __future__ import annotations

import sys
from pathlib import Path
import asyncio
import json
import tempfile

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from mishkan_watchd.state import HarnessState
from mishkan_watchd.sources.opencode_storage import (
    _existing_message_and_part_paths,
    _message_events,
    _part_event,
)
from mishkan_watchd.sources.session_tail import _SessionTailer


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
    """An idle session (no agents, last_event_mono expired) is cleaned up on session_stop."""
    import mishkan_watchd.state as state_mod
    from time import monotonic

    s = HarnessState()
    s.apply({"ts": "x", "session": "drop-me", "type": "session_start", "project": "/p"})
    assert "drop-me" in s.sessions
    # Simulate idleness: backdate last_event_mono past the keepalive window.
    s.sessions["drop-me"].last_event_mono = monotonic() - (state_mod.SESSION_KEEPALIVE_S + 10)
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


# ---------------------------------------------------------------------------
# Fix A — last_context_tokens
# ---------------------------------------------------------------------------

def test_last_context_tokens_set_not_accumulated():
    """last_context_tokens reflects the MOST RECENT turn, not a running sum."""
    s = HarnessState()
    s.apply({"ts": "x", "session": "ctx", "type": "session_start", "project": "/p"})
    # Turn 1: small uncached input with large cache_read (typical caching profile).
    s.apply({
        "ts": "x", "session": "ctx", "type": "token_usage",
        "payload": {
            "tokens_in": 2, "tokens_out": 100,
            "cache_read": 558453, "cache_write": 5141,
            "cost_estimate_usd": 1.21,
        },
    })
    sess = s.sessions["ctx"]
    # last_context_tokens = cache_read + cache_write + tokens_in of THIS turn.
    assert sess.last_context_tokens == 558453 + 5141 + 2
    # Cumulative fields are unchanged.
    assert sess.tokens_in == 2
    assert sess.cache_read == 558453

    # Turn 2: a different footprint — last_context_tokens is replaced, not added.
    s.apply({
        "ts": "y", "session": "ctx", "type": "token_usage",
        "payload": {
            "tokens_in": 5, "tokens_out": 200,
            "cache_read": 600000, "cache_write": 0,
            "cost_estimate_usd": 0.5,
        },
    })
    assert sess.last_context_tokens == 600000 + 0 + 5
    # Cumulative tokens_in did accumulate across both turns.
    assert sess.tokens_in == 7


def test_last_context_tokens_in_snapshot():
    """last_context_tokens is present in the per-session snapshot dict."""
    import json
    s = HarnessState()
    s.apply({"ts": "x", "session": "ctx2", "type": "session_start", "project": "/p"})
    s.apply({
        "ts": "x", "session": "ctx2", "type": "token_usage",
        "payload": {"tokens_in": 2, "tokens_out": 50,
                    "cache_read": 558453, "cache_write": 5141,
                    "cost_estimate_usd": 0.1},
    })
    snap = s.to_snapshot()
    sess_snap = snap["sessions"]["ctx2"]
    assert "last_context_tokens" in sess_snap
    assert sess_snap["last_context_tokens"] == 558453 + 5141 + 2
    # Verify it round-trips cleanly.
    json.dumps(snap, default=str)


def test_last_context_tokens_zero_on_fresh_session():
    """A session with no token_usage events has last_context_tokens == 0."""
    s = HarnessState()
    s.apply({"ts": "x", "session": "fresh", "type": "session_start", "project": "/p"})
    snap = s.to_snapshot()
    assert snap["sessions"]["fresh"]["last_context_tokens"] == 0


def test_session_start_preserves_runtime_and_jsonl_path_in_snapshot():
    """Multi-runtime discovery annotates sessions with runtime + source path."""
    s = HarnessState()
    s.apply({
        "ts": "x",
        "session": "codex:abc123",
        "type": "session_start",
        "project": "threads",
        "runtime": "codex",
        "payload": {
            "runtime": "codex",
            "raw_session_id": "abc123",
            "jsonl_path": "/tmp/codex/threads/abc123.jsonl",
        },
    })
    snap = s.to_snapshot()
    sess = snap["sessions"]["codex:abc123"]
    assert sess["runtime"] == "codex"
    assert sess["jsonl_path"] == "/tmp/codex/threads/abc123.jsonl"


# ---------------------------------------------------------------------------
# Fix B — workflow stale sweep
# ---------------------------------------------------------------------------

def test_workflow_start_creates_run_in_session():
    """workflow_start populates workflows_active with phase 'running'."""
    s = HarnessState()
    s.apply({"ts": "x", "session": "wf1", "type": "session_start", "project": "/p"})
    s.apply({
        "ts": "x", "session": "wf1", "type": "workflow_start",
        "payload": {"name": "my-flow", "run_id": "run-abc", "scriptPath": "flow.yaml"},
    })
    wf = s.sessions["wf1"].workflows_active.get("run-abc")
    assert wf is not None
    assert wf.name == "my-flow"
    assert wf.phase == "running"


def test_workflow_stale_sweep_in_snapshot():
    """A workflow whose last_activity_mono is > TTL shows phase='stale' in snapshot."""
    import mishkan_watchd.state as state_mod
    from time import monotonic

    s = HarnessState()
    s.apply({"ts": "x", "session": "wf2", "type": "session_start", "project": "/p"})
    s.apply({
        "ts": "x", "session": "wf2", "type": "workflow_start",
        "payload": {"name": "old-flow", "run_id": "run-old"},
    })
    # Backdate last_activity_mono to simulate a run that started long ago.
    wf = s.sessions["wf2"].workflows_active["run-old"]
    wf.last_activity_mono = monotonic() - (state_mod.WORKFLOW_STALE_TTL_S + 1)

    snap = s.to_snapshot()
    wf_snap = snap["sessions"]["wf2"]["workflows_active"]["run-old"]
    assert wf_snap["phase"] == "stale"
    # The live WorkflowState is NOT mutated — only the snapshot output changes.
    assert wf.phase == "running"


def test_workflow_fresh_run_not_staled():
    """A recently-started workflow is NOT staled in the snapshot."""
    s = HarnessState()
    s.apply({"ts": "x", "session": "wf3", "type": "session_start", "project": "/p"})
    s.apply({
        "ts": "x", "session": "wf3", "type": "workflow_start",
        "payload": {"name": "new-flow", "run_id": "run-new"},
    })
    snap = s.to_snapshot()
    wf_snap = snap["sessions"]["wf3"]["workflows_active"]["run-new"]
    assert wf_snap["phase"] == "running"


def test_workflow_stale_field_not_in_snapshot():
    """last_activity_mono (internal float) is stripped from the snapshot wire shape."""
    s = HarnessState()
    s.apply({"ts": "x", "session": "wf4", "type": "session_start", "project": "/p"})
    s.apply({
        "ts": "x", "session": "wf4", "type": "workflow_start",
        "payload": {"name": "flow", "run_id": "run-x"},
    })
    snap = s.to_snapshot()
    wf_snap = snap["sessions"]["wf4"]["workflows_active"]["run-x"]
    assert "last_activity_mono" not in wf_snap


def test_cold_start_has_no_workflows():
    """A fresh daemon with no workflow events shows an empty workflows_active."""
    s = HarnessState()
    s.apply({"ts": "x", "session": "cold", "type": "session_start", "project": "/p"})
    snap = s.to_snapshot()
    assert snap["sessions"]["cold"]["workflows_active"] == {}


# ---------------------------------------------------------------------------
# Fix C — session_stop busy-guard (liveness via bus activity)
# ---------------------------------------------------------------------------

def test_session_stop_ignored_when_agent_active():
    """A session with a running agent survives session_stop from session_discover."""
    s = HarnessState()
    s.apply({"ts": "x", "session": "busy-1", "type": "session_start", "project": "/p"})
    s.apply({
        "ts": "x", "session": "busy-1", "type": "agent_spawn", "tool": "Task",
        "agent": "bezalel",
        "payload": {"subagent_type": "bezalel", "tool_use_id": "toolu_busy1"},
    })
    # Transcript goes quiet — session_discover emits session_stop.
    s.apply({"ts": "y", "session": "busy-1", "type": "session_stop"})
    # Session must still be present and agent still visible.
    assert "busy-1" in s.sessions
    assert "toolu_busy1" in s.sessions["busy-1"].agents_active


def test_session_stop_ignored_when_recent_bus_event():
    """A session whose last bus event is within SESSION_KEEPALIVE_S survives session_stop."""
    import mishkan_watchd.state as state_mod

    s = HarnessState()
    s.apply({"ts": "x", "session": "busy-2", "type": "session_start", "project": "/p"})
    # A recent token_usage event stamps last_event_mono close to now.
    s.apply({
        "ts": "x", "session": "busy-2", "type": "token_usage",
        "payload": {"tokens_in": 10, "tokens_out": 5, "cost_estimate_usd": 0.001},
    })
    # Confirm last_event_mono is within keepalive window.
    from time import monotonic
    assert (monotonic() - s.sessions["busy-2"].last_event_mono) < state_mod.SESSION_KEEPALIVE_S

    s.apply({"ts": "y", "session": "busy-2", "type": "session_stop"})
    assert "busy-2" in s.sessions


def test_session_stop_drops_genuinely_idle_session():
    """A session with no active agents and an old last_event_mono is cleaned up normally."""
    import mishkan_watchd.state as state_mod
    from time import monotonic

    s = HarnessState()
    s.apply({"ts": "x", "session": "idle-1", "type": "session_start", "project": "/p"})
    # Backdate last_event_mono to simulate a long-idle session.
    sess = s.sessions["idle-1"]
    sess.last_event_mono = monotonic() - (state_mod.SESSION_KEEPALIVE_S + 10)
    # No agents_active (default empty dict).
    s.apply({"ts": "y", "session": "idle-1", "type": "session_stop"})
    assert "idle-1" not in s.sessions
    assert "idle-1" in s._stopped_recently


def test_live_event_after_idle_stop_resurrects_session():
    """A live bus event for a tombstoned-but-spuriously-stopped session
    un-tombstones and re-confirms the session (Fix E).

    agent_complete for a session with no spawned agents is a harmless
    fall-through: the session exists but agents_active stays empty. This
    is correct — the event was genuine activity, not a phantom replay.
    """
    import mishkan_watchd.state as state_mod
    from time import monotonic

    s = HarnessState()
    s.apply({"ts": "x", "session": "gone-1", "type": "session_start", "project": "/p"})
    sess = s.sessions["gone-1"]
    sess.last_event_mono = monotonic() - (state_mod.SESSION_KEEPALIVE_S + 10)
    s.apply({"ts": "y", "session": "gone-1", "type": "session_stop"})
    assert "gone-1" not in s.sessions
    assert "gone-1" in s._stopped_recently

    # A live agent_complete arrives — session is resurrected (no agent to pop,
    # but the session itself is re-confirmed and alive).
    s.apply({
        "ts": "z", "session": "gone-1", "type": "agent_complete",
        "payload": {"tool_use_id": "toolu_late"},
    })
    assert "gone-1" in s.sessions
    assert "gone-1" in s._confirmed_alive
    assert "gone-1" not in s._stopped_recently
    # No agent was ever spawned, so agents_active is empty — not an error.
    assert s.sessions["gone-1"].agents_active == {}


# ---------------------------------------------------------------------------
# Fix D — live-event confirm (agent-only session, no prior session_start)
# ---------------------------------------------------------------------------

def test_agent_spawn_alone_confirms_session_and_populates_agents_active():
    """Core regression: agent_spawn for a never-seen session (no session_start)
    must create+confirm the session and populate agents_active immediately.

    This is the agent-only-session blindspot: the parent transcript is quiet
    during an agent run, so session_discover never fires session_start; but
    bus events stream in live and tier-2 confirmation must pick them up.
    """
    s = HarnessState()
    s.apply({
        "ts": "2026-06-09T10:00:00.000Z",
        "session": "agent-only-sess",
        "project": "/tmp/wisemoney",
        "type": "agent_spawn",
        "tool": "Task",
        "agent": "bezalel",
        "payload": {"subagent_type": "bezalel", "tool_use_id": "toolu_live01"},
    })
    # Session must exist — created by tier-2 confirm.
    assert "agent-only-sess" in s.sessions
    # Agent must be visible immediately — event fell through to dispatch.
    agents = s.sessions["agent-only-sess"].agents_active
    assert "toolu_live01" in agents
    assert agents["toolu_live01"].name == "bezalel"
    assert agents["toolu_live01"].status == "running"
    # Session is now confirmed.
    assert "agent-only-sess" in s._confirmed_alive


def test_token_usage_alone_confirms_session_and_applies_tokens():
    """token_usage for a never-seen session creates the session and lands tokens."""
    s = HarnessState()
    s.apply({
        "ts": "2026-06-09T10:00:01.000Z",
        "session": "tok-only-sess",
        "type": "token_usage",
        "payload": {"tokens_in": 42, "tokens_out": 7, "cost_estimate_usd": 0.005},
    })
    assert "tok-only-sess" in s.sessions
    sess = s.sessions["tok-only-sess"]
    assert sess.tokens_in == 42
    assert sess.tokens_out == 7
    assert "tok-only-sess" in s._confirmed_alive


def test_tombstoned_session_untombstoned_on_live_agent_spawn():
    """Core regression — Fix E: a tombstoned session that receives a live
    agent_spawn is un-tombstoned, re-confirmed, and the agent appears in
    agents_active immediately.

    Scenario: session went quiet (parent transcript stale >60 s during an
    agent run), session_discover spuriously emitted session_stop, session was
    tombstoned. A fresh agent_spawn then arrives on the bus. With the fix the
    session must come back alive and the agent must be visible.
    """
    import mishkan_watchd.state as state_mod
    from time import monotonic

    s = HarnessState()
    # Start and let it go idle so the stop is accepted (not busy-guarded).
    s.apply({"ts": "x", "session": "quiet-sess", "type": "session_start", "project": "/p"})
    s.sessions["quiet-sess"].last_event_mono = monotonic() - (state_mod.SESSION_KEEPALIVE_S + 10)
    s.apply({"ts": "y", "session": "quiet-sess", "type": "session_stop"})
    assert "quiet-sess" not in s.sessions
    assert "quiet-sess" in s._stopped_recently

    # Live agent_spawn arrives — session must be resurrected.
    s.apply({
        "ts": "z", "session": "quiet-sess",
        "type": "agent_spawn", "tool": "Task", "agent": "bezalel",
        "payload": {"subagent_type": "bezalel", "tool_use_id": "toolu_reborn"},
    })
    assert "quiet-sess" in s.sessions, "session must be un-tombstoned and re-confirmed"
    assert "quiet-sess" in s._confirmed_alive
    assert "quiet-sess" not in s._stopped_recently
    agents = s.sessions["quiet-sess"].agents_active
    assert "toolu_reborn" in agents, "agent must appear in agents_active after resurrection"
    assert agents["toolu_reborn"].name == "bezalel"
    assert agents["toolu_reborn"].status == "running"


def test_tombstoned_session_subsequent_agent_complete_works_normally():
    """After resurrection via agent_spawn a following agent_complete removes
    the agent normally — the un-tombstoned session behaves like any live session.
    """
    import mishkan_watchd.state as state_mod
    from time import monotonic

    s = HarnessState()
    s.apply({"ts": "x", "session": "revived", "type": "session_start", "project": "/p"})
    s.sessions["revived"].last_event_mono = monotonic() - (state_mod.SESSION_KEEPALIVE_S + 10)
    s.apply({"ts": "y", "session": "revived", "type": "session_stop"})
    assert "revived" in s._stopped_recently

    # Resurrect via spawn.
    s.apply({
        "ts": "z", "session": "revived",
        "type": "agent_spawn", "tool": "Task", "agent": "caleb",
        "payload": {"subagent_type": "caleb", "tool_use_id": "toolu_rev1"},
    })
    assert "toolu_rev1" in s.sessions["revived"].agents_active

    # Complete the agent — must be removed cleanly.
    s.apply({
        "ts": "w", "session": "revived",
        "type": "agent_complete", "tool": "Task", "agent": "caleb",
        "payload": {"subagent_type": "caleb", "tool_use_id": "toolu_rev1"},
    })
    assert "toolu_rev1" not in s.sessions["revived"].agents_active
    assert len(s.sessions["revived"].agents_active) == 0


def test_tombstoned_session_with_no_further_events_stays_gone():
    """A session that is tombstoned and receives no further events is never
    resurrected — tombstone stays in place indefinitely.
    """
    import mishkan_watchd.state as state_mod
    from time import monotonic

    s = HarnessState()
    s.apply({"ts": "x", "session": "truly-dead", "type": "session_start", "project": "/p"})
    s.sessions["truly-dead"].last_event_mono = monotonic() - (state_mod.SESSION_KEEPALIVE_S + 10)
    s.apply({"ts": "y", "session": "truly-dead", "type": "session_stop"})

    # No further events arrive for this session. It must remain absent.
    assert "truly-dead" not in s.sessions
    assert "truly-dead" in s._stopped_recently
    assert "truly-dead" not in s._confirmed_alive


def test_session_start_after_live_confirm_is_harmless_reconfirm():
    """session_start arriving after tier-2 already confirmed the session is a
    harmless re-confirm: no duplicate session created, project upgraded if needed.
    """
    s = HarnessState()
    # Tier-2 confirm via agent_spawn (project unknown at this point).
    s.apply({
        "ts": "a", "session": "reconfirm-sess",
        "type": "agent_spawn", "tool": "Task", "agent": "bezalel",
        "payload": {"subagent_type": "bezalel", "tool_use_id": "toolu_rc1"},
    })
    assert "reconfirm-sess" in s.sessions
    assert s.sessions["reconfirm-sess"].project == "unknown"

    # session_discover fires session_start with the real project path.
    s.apply({
        "ts": "b", "session": "reconfirm-sess",
        "type": "session_start", "project": "/real/project",
    })
    # Only one session entry — not duplicated.
    assert len([sid for sid in s.sessions if sid == "reconfirm-sess"]) == 1
    # Project upgraded from "unknown" to the real path.
    assert s.sessions["reconfirm-sess"].project == "/real/project"
    # Agent still present.
    assert "toolu_rc1" in s.sessions["reconfirm-sess"].agents_active


def test_codex_session_tail_extracts_tool_tokens_and_compaction():
    """Codex JSONL records map to normalized ARES bus events."""
    async def _run():
        q = asyncio.Queue()
        tailer = _SessionTailer("codex:abc123", Path("/tmp/missing.jsonl"), q)
        await tailer._scan({
            "timestamp": "2026-06-18T10:00:00.000Z",
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "call_id": "call_1",
            },
        })
        await tailer._scan({
            "timestamp": "2026-06-18T10:00:01.000Z",
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": 100,
                        "cached_input_tokens": 80,
                        "output_tokens": 20,
                        "reasoning_output_tokens": 5,
                    },
                    "model_context_window": 258400,
                },
            },
        })
        await tailer._scan({
            "timestamp": "2026-06-18T10:00:02.000Z",
            "type": "event_msg",
            "payload": {"type": "context_compacted"},
        })
        return [await q.get(), await q.get(), await q.get()]

    tool, usage, compaction = asyncio.run(_run())
    assert tool["runtime"] == "codex"
    assert tool["type"] == "tool_call"
    assert tool["tool"] == "exec_command"
    assert usage["type"] == "token_usage"
    assert usage["payload"]["tokens_in"] == 100
    assert usage["payload"]["cache_read"] == 80
    assert usage["payload"]["tokens_out"] == 20
    assert compaction["type"] == "compaction"


def test_opencode_storage_extracts_message_tokens_and_tool_part():
    """OpenCode storage message/part records map to normalized ARES bus events."""
    events = _message_events({
        "id": "msg_1",
        "sessionID": "ses_1",
        "role": "assistant",
        "time": {"completed": 1770823140574},
        "agent": "build",
        "modelID": "gpt-5.3-codex",
        "providerID": "openai",
        "path": {"cwd": "/tmp/project"},
        "cost": 0.01,
        "tokens": {
            "input": 598,
            "output": 90,
            "reasoning": 36,
            "cache": {"read": 61312, "write": 0},
        },
    })
    assert len(events) == 1
    usage = events[0]
    assert usage["session"] == "opencode:ses_1"
    assert usage["runtime"] == "opencode"
    assert usage["type"] == "token_usage"
    assert usage["payload"]["tokens_in"] == 598
    assert usage["payload"]["cache_read"] == 61312
    assert usage["payload"]["tokens_out"] == 90

    tool = _part_event({
        "id": "prt_1",
        "sessionID": "ses_1",
        "messageID": "msg_1",
        "type": "tool",
        "callID": "call_1",
        "tool": "grep",
        "state": {
            "status": "completed",
            "time": {"start": 1770823140559, "end": 1770823140564},
        },
    })
    assert tool is not None
    assert tool["session"] == "opencode:ses_1"
    assert tool["runtime"] == "opencode"
    assert tool["type"] == "tool_call"
    assert tool["tool"] == "grep"
    assert tool["outcome"] == "completed"


def test_opencode_startup_marks_existing_messages_and_parts_seen():
    """OpenCode source starts at current storage state instead of backfilling."""
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "storage"
        msg_dir = root / "message" / "ses_1"
        part_dir = root / "part" / "msg_1"
        msg_dir.mkdir(parents=True)
        part_dir.mkdir(parents=True)
        msg_path = msg_dir / "msg_1.json"
        part_path = part_dir / "prt_1.json"
        msg_path.write_text(json.dumps({"id": "msg_1", "sessionID": "ses_1"}))
        part_path.write_text(json.dumps({
            "id": "prt_1",
            "messageID": "msg_1",
            "sessionID": "ses_1",
            "type": "tool",
        }))

        messages, parts = _existing_message_and_part_paths(Path(td), "ses_1")

    assert msg_path in messages
    assert part_path in parts


if __name__ == "__main__":
    for _name, _fn in sorted(globals().items()):
        if _name.startswith("test_") and callable(_fn):
            _fn()
    print("test_state ok")
    test_last_context_tokens_set_not_accumulated()
    test_last_context_tokens_in_snapshot()
    test_last_context_tokens_zero_on_fresh_session()
    test_workflow_start_creates_run_in_session()
    test_workflow_stale_sweep_in_snapshot()
    test_workflow_fresh_run_not_staled()
    test_workflow_stale_field_not_in_snapshot()
    test_cold_start_has_no_workflows()
    test_session_stop_ignored_when_agent_active()
    test_session_stop_ignored_when_recent_bus_event()
    test_session_stop_drops_genuinely_idle_session()
    test_live_event_after_idle_stop_resurrects_session()
    test_agent_spawn_alone_confirms_session_and_populates_agents_active()
    test_token_usage_alone_confirms_session_and_applies_tokens()
    test_tombstoned_session_untombstoned_on_live_agent_spawn()
    test_tombstoned_session_subsequent_agent_complete_works_normally()
    test_tombstoned_session_with_no_further_events_stays_gone()
    test_session_start_after_live_confirm_is_harmless_reconfirm()
    print("all state tests passed")
