"""HarnessState — in-memory snapshot of the MISHKAN cross-session world.

A single source of truth that all sources push events into and clients
read snapshots + deltas from. Nothing persisted; daemon restart rebuilds
from scratch by replaying the current filesystem state.

Event flow:

    source -> Event -> dispatcher.apply(event) -> HarnessState
                                              -> broadcast to clients

Every change to HarnessState produces a delta the dispatcher forwards to
subscribed clients. The delta format is the bus event itself — sources
emit bus-format events and the same shape reaches the wire.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional


def _now() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{datetime.now(tz=timezone.utc).microsecond // 1000:03d}Z"


@dataclass
class AgentState:
    name: str
    started: str
    last_tool: Optional[str] = None
    last_activity: Optional[str] = None
    status: str = "running"  # running | idle | errored
    tokens_in: int = 0
    tokens_out: int = 0
    cost_estimate_usd: float = 0.0


@dataclass
class WorkflowState:
    name: str
    run_id: str
    phase: str = "starting"
    phases_total: int = 0
    phases_done: int = 0
    spend_usd: float = 0.0
    tokens_total: int = 0
    started: str = ""


@dataclass
class SessionState:
    session_id: str
    project: str
    started: str
    agents_active: dict[str, AgentState] = field(default_factory=dict)
    workflows_active: dict[str, WorkflowState] = field(default_factory=dict)
    recent_events: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=200))
    tokens_in: int = 0
    tokens_out: int = 0
    cache_read: int = 0
    cache_write: int = 0
    cost_estimate_usd: float = 0.0


@dataclass
class WorktreeState:
    path: str
    branch: str
    owner_session: Optional[str] = None
    head: Optional[str] = None


@dataclass
class MCPServerState:
    name: str
    url: str
    status: str = "unknown"   # up | down | stale | unknown
    since: str = ""
    last_event: Optional[str] = None
    last_probe: Optional[str] = None


@dataclass
class CogneeStoreState:
    name: str
    url: str
    up: bool = False
    nodes: int = 0
    last_ingest: Optional[str] = None
    last_probe: Optional[str] = None


@dataclass
class HarnessState:
    sessions: dict[str, SessionState] = field(default_factory=dict)
    worktrees: dict[str, WorktreeState] = field(default_factory=dict)
    mcp_servers: dict[str, MCPServerState] = field(default_factory=dict)
    cognee: dict[str, CogneeStoreState] = field(default_factory=dict)
    recent_hooks: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=50))
    started: str = field(default_factory=_now)

    # ----- event application -------------------------------------------------

    def apply(self, event: dict[str, Any]) -> None:
        """Apply a bus-format event to the state. Idempotent on unknowns."""
        try:
            etype = event.get("type")
            session_id = event.get("session")
            if session_id:
                self._ensure_session(session_id, event.get("project") or "unknown")

            if etype == "agent_spawn":
                self._on_agent_spawn(session_id, event)
            elif etype == "agent_complete":
                self._on_agent_complete(session_id, event)
            elif etype == "tool_call":
                self._on_tool_call(session_id, event)
            elif etype == "token_usage":
                self._on_token_usage(session_id, event)
            elif etype == "hook_fire":
                self.recent_hooks.append(event)
            elif etype == "worktree_change":
                self._on_worktree(event)
            elif etype == "mcp_server":
                self._on_mcp(event)
            elif etype == "cognee_op":
                self._on_cognee_op(event)
            elif etype == "session_start":
                pass  # ensured above
            elif etype == "session_stop":
                self.sessions.pop(session_id, None) if session_id else None

            if session_id and session_id in self.sessions:
                self.sessions[session_id].recent_events.append(event)
        except Exception:
            return  # fail-open on any state error

    # ----- snapshot for new clients ------------------------------------------

    def to_snapshot(self) -> dict[str, Any]:
        return {
            "started": self.started,
            "sessions": {
                sid: _session_dict(s) for sid, s in self.sessions.items()
            },
            "worktrees": {p: _dc_to_dict(w) for p, w in self.worktrees.items()},
            "mcp_servers": {n: _dc_to_dict(s) for n, s in self.mcp_servers.items()},
            "cognee": {n: _dc_to_dict(s) for n, s in self.cognee.items()},
            "recent_hooks": list(self.recent_hooks),
        }

    # ----- internal helpers --------------------------------------------------

    def _ensure_session(self, sid: str, project: str) -> SessionState:
        s = self.sessions.get(sid)
        if s is None:
            s = SessionState(session_id=sid, project=project or "unknown",
                             started=_now())
            self.sessions[sid] = s
            return s
        # If we already have the session but the recorded project is the
        # "unknown" placeholder (set when the first event we saw lacked a
        # project field — typical for the bus_tail backfill of old
        # events), upgrade it as soon as a real project value arrives
        # (e.g. from session_discover's session_start event).
        if (s.project in ("", "unknown", None)) and project and project not in ("", "unknown"):
            s.project = project
        return s

    def _on_agent_spawn(self, sid: Optional[str], event: dict[str, Any]) -> None:
        if not sid:
            return
        sess = self.sessions[sid]
        agent_name = event.get("agent") or (event.get("payload") or {}).get("subagent_type")
        if not agent_name:
            return
        sess.agents_active[agent_name] = AgentState(
            name=agent_name,
            started=event.get("ts") or _now(),
            last_tool=event.get("tool"),
            status="running",
        )

    def _on_agent_complete(self, sid: Optional[str], event: dict[str, Any]) -> None:
        if not sid:
            return
        sess = self.sessions.get(sid)
        if not sess:
            return
        agent_name = event.get("agent")
        if not agent_name:
            return
        sess.agents_active.pop(agent_name, None)

    def _on_tool_call(self, sid: Optional[str], event: dict[str, Any]) -> None:
        if not sid:
            return
        sess = self.sessions[sid]
        agent = event.get("agent")
        if agent and agent in sess.agents_active:
            sess.agents_active[agent].last_tool = event.get("tool")
            sess.agents_active[agent].last_activity = event.get("ts")

    def _on_token_usage(self, sid: Optional[str], event: dict[str, Any]) -> None:
        if not sid:
            return
        sess = self.sessions[sid]
        p = event.get("payload") or {}
        sess.tokens_in += int(p.get("tokens_in") or 0)
        sess.tokens_out += int(p.get("tokens_out") or 0)
        sess.cache_read += int(p.get("cache_read") or 0)
        sess.cache_write += int(p.get("cache_write") or 0)
        sess.cost_estimate_usd += float(p.get("cost_estimate_usd") or 0.0)

    def _on_worktree(self, event: dict[str, Any]) -> None:
        p = event.get("payload") or {}
        path = p.get("path")
        if not path:
            return
        op = p.get("op")
        if op == "remove":
            self.worktrees.pop(path, None)
        else:
            self.worktrees[path] = WorktreeState(
                path=path,
                branch=p.get("branch") or "",
                owner_session=p.get("owner_session"),
                head=p.get("head"),
            )

    def _on_mcp(self, event: dict[str, Any]) -> None:
        p = event.get("payload") or {}
        name = p.get("server") or event.get("tool")
        if not name:
            return
        s = self.mcp_servers.get(name) or MCPServerState(name=name, url=p.get("url") or "")
        s.status = p.get("status") or s.status
        s.last_probe = event.get("ts")
        if p.get("status_changed"):
            s.since = event.get("ts") or s.since
        if event.get("ts"):
            s.last_event = event.get("ts")
        self.mcp_servers[name] = s

    def _on_cognee_op(self, event: dict[str, Any]) -> None:
        p = event.get("payload") or {}
        store = p.get("store")
        if not store:
            return
        s = self.cognee.get(store) or CogneeStoreState(name=store, url=p.get("url") or "")
        if "nodes" in p:
            s.nodes = int(p["nodes"])
        if "up" in p:
            s.up = bool(p["up"])
        if p.get("op") == "add" or p.get("op") == "cognify":
            s.last_ingest = event.get("ts")
        s.last_probe = event.get("ts")
        self.cognee[store] = s


def _dc_to_dict(dc) -> dict[str, Any]:
    return {k: v for k, v in dc.__dict__.items()}


def _session_dict(s: SessionState) -> dict[str, Any]:
    # Truncate recent_events for the snapshot frame so the daemon doesn't
    # send 200 events × N sessions on connect — that easily exceeds the
    # client's readline buffer. Per-session ring buffer stays at 200 for
    # delta-driven views; the snapshot just shows the last 30.
    recent = list(s.recent_events)
    if len(recent) > 30:
        recent = recent[-30:]
    return {
        "session_id": s.session_id,
        "project": s.project,
        "started": s.started,
        "agents_active": {k: _dc_to_dict(v) for k, v in s.agents_active.items()},
        "workflows_active": {k: _dc_to_dict(v) for k, v in s.workflows_active.items()},
        "recent_events": recent,
        "tokens_in": s.tokens_in,
        "tokens_out": s.tokens_out,
        "cache_read": s.cache_read,
        "cache_write": s.cache_write,
        "cost_estimate_usd": s.cost_estimate_usd,
    }
