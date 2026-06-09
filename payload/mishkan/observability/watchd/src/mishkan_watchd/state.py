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
from time import monotonic
from typing import Any, Optional


def _now() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{datetime.now(tz=timezone.utc).microsecond // 1000:03d}Z"


# How long an event for an unconfirmed session is buffered before being
# dropped. session_discover polls every 10s, so 15s covers the case where
# a hook fires for a brand-new session before its first JSONL flush.
_PENDING_TTL_S = 15.0

# A workflow run that has received no workflow_* event for this many seconds
# is transitioned to "stale" in the snapshot. The Workflow tool returns
# immediately and reports completion via task-notification (not a tool call),
# so workflow_complete is never emitted by any hook — a TTL is the only
# durable way to clear lingering "running" entries.
WORKFLOW_STALE_TTL_S = 900

# A session_stop from session_discover is ignored when the session is "busy":
# either it still has active agents, or a real bus event was applied within
# this window. Chosen comfortably above session_discover's 60 s active_window
# so a session whose transcript goes quiet while a subagent is writing to its
# own nested JSONL is not torn down mid-run.
SESSION_KEEPALIVE_S = 90.0


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
    # Claude tier this agent runs on (opus / sonnet / haiku). Lifted from
    # post-tool-observe.sh's `agent_spawn` payload, which already carries the
    # model field that model-route.py injected. Consumed by the Usage tab to
    # pick the per-agent context window (Sonnet 4.6 = 1M, Opus 4.x = 1M,
    # Haiku 4.5 = 200k) instead of pinning the bar at a single fleet-wide
    # default. Empty string when the spawner didn't surface a model.
    model: str = ""


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
    # Monotonic timestamp of the last workflow_* event for this run. Used by
    # the stale-sweep in to_snapshot() to transition runs that have received
    # no activity for WORKFLOW_STALE_TTL_S to status "stale".
    last_activity_mono: float = field(default_factory=monotonic)


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
    # Most-recent turn's input footprint (SET, not accumulated). Equals
    # cache_read + cache_write + tokens_in from the last token_usage event.
    # This is what the TUI Usage gauge should divide by the context window to
    # get a meaningful fill fraction; the cumulative tokens_in alone reads ~0%
    # under prompt caching because cache_read tokens are not billed as input.
    last_context_tokens: int = 0
    # Monotonic timestamp of the last bus event applied to this session.
    # Used by the session_stop guard to keep a busy session (active agents or
    # recent activity) alive when session_discover declares it stale because
    # its parent transcript has not been written to (subagent writes go to
    # nested subagents/agent-*.jsonl, leaving the parent file quiet).
    last_event_mono: float = 0.0


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
class GraphifyState:
    """Aggregated Graphify state across all watched projects.

    graphify_tail emits scan events whose payload carries the latest
    nodes/edges for a single project; we keep the most recent per-project
    rollup so the snapshot served to a new TUI client carries the current
    state even if the scan event itself fired before the client connected.
    """
    nodes: int = 0
    edges: int = 0
    communities: int = 0
    scans: int = 0
    queries: int = 0
    last_scan_project: Optional[str] = None
    last_scan_at: Optional[str] = None
    last_query_project: Optional[str] = None
    last_query_at: Optional[str] = None
    last_query_text: Optional[str] = None


@dataclass
class HarnessState:
    sessions: dict[str, SessionState] = field(default_factory=dict)
    worktrees: dict[str, WorktreeState] = field(default_factory=dict)
    mcp_servers: dict[str, MCPServerState] = field(default_factory=dict)
    cognee: dict[str, CogneeStoreState] = field(default_factory=dict)
    graphify: GraphifyState = field(default_factory=GraphifyState)
    recent_hooks: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=50))
    started: str = field(default_factory=_now)
    # Bounded ring of recently-stopped session ids. Any event for an id
    # in this ring is dropped silently — prevents background-hook events
    # (e.g. CLAUDE_PROJECT_DIR leaking from a stale shell env) from
    # resurrecting a stopped session via _ensure_session. Capacity 256 is
    # ~256 × poll_interval = several minutes of memory; cheap.
    _stopped_recently: deque[str] = field(default_factory=lambda: deque(maxlen=256))

    # Sessions confirmed alive by session_discover. Only sessions in this
    # set are eligible to have non-session_start events applied to state.
    # session_discover emits session_start when it observes an active
    # JSONL; that adds to this set. session_stop removes from it.
    _confirmed_alive: set[str] = field(default_factory=set)

    # Per-session buffer of events that arrived before the session_id was
    # confirmed alive by session_discover. Each entry: (monotonic ts, event).
    # On session_start the buffer for that sid is flushed in order. Entries
    # older than _PENDING_TTL_S are dropped during apply() sweep — bounds
    # memory for sids that session_discover never confirms (typically
    # hooks firing for already-gone sessions).
    _pending: dict[str, deque] = field(default_factory=dict)

    # ----- event application -------------------------------------------------

    def apply(self, event: dict[str, Any]) -> None:
        """Apply a bus-format event to the state.

        Authority gate: session_discover is the source of truth for alive
        sessions. Only sessions confirmed by session_discover (via
        session_start) are eligible to have events applied. Events for
        unknown session_ids are buffered briefly (_PENDING_TTL_S) and
        flushed if confirmation arrives; otherwise dropped.

        This kills the phantom-session bug at its root: bus_tail can no
        longer resurrect stopped or never-alive sessions, no matter what
        old hook events surface from disk.

        Liveness is now refreshed by bus activity (last_event_mono), not
        transcript mtime alone. bus_tail seeks to EOF on startup so no
        historical replay can resurrect a dead session via this path.
        A session_stop from session_discover is ignored when the session
        is busy (agents_active non-empty OR last_event_mono within
        SESSION_KEEPALIVE_S); session_discover re-polls and re-emits
        session_stop, so idle sessions are still cleaned up normally.
        """
        try:
            self._sweep_pending()
            etype = event.get("type")
            session_id = event.get("session")

            if session_id:
                if etype == "session_start":
                    # session_discover has just confirmed this session is alive.
                    self._confirmed_alive.add(session_id)
                    self._ensure_session(session_id, event.get("project") or "unknown")
                    self._flush_pending(session_id)
                elif etype == "session_stop":
                    # Busy-guard handled below; fall through.
                    pass
                elif session_id in self._stopped_recently:
                    # Stopped session — drop silently. Tombstone window handles
                    # lagging hook events for sessions whose stop just propagated.
                    return
                elif session_id not in self._confirmed_alive:
                    # Unknown session. Buffer with TTL — if session_discover
                    # confirms within _PENDING_TTL_S we replay in order;
                    # otherwise the sweep drops it.
                    buf = self._pending.setdefault(session_id, deque(maxlen=200))
                    buf.append((monotonic(), event))
                    return

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
            elif etype in ("graphify_scan", "graphify_query"):
                self._on_graphify(event)
            elif etype in ("workflow_start", "workflow_update"):
                self._on_workflow_event(session_id, event)
            elif etype == "session_start":
                pass  # ensured above
            elif etype == "session_stop":
                if session_id:
                    sess = self.sessions.get(session_id)
                    busy = (
                        sess is not None
                        and (
                            bool(sess.agents_active)
                            or (monotonic() - sess.last_event_mono) < SESSION_KEEPALIVE_S
                        )
                    )
                    if busy:
                        # Session still has running agents or received a real
                        # bus event recently — transcript staleness from
                        # session_discover does not reflect true liveness here
                        # (subagent writes go to nested JSONL files). Ignore
                        # this stop; session_discover will re-emit on the next
                        # poll cycle and the guard re-evaluates then.
                        return
                    # Genuinely idle: no active agents and no recent bus events.
                    self.sessions.pop(session_id, None)
                    self._confirmed_alive.discard(session_id)
                    self._pending.pop(session_id, None)
                    # Tombstone so lagging hook events for this session
                    # don't resurrect it. Bounded ring — old tombstones age out.
                    self._stopped_recently.append(session_id)

            if session_id and session_id in self.sessions:
                self.sessions[session_id].recent_events.append(event)
                # Stamp liveness so the session_stop busy-guard has a fresh
                # monotonic reference. Any real bus event refreshes the window,
                # keeping a session alive through a transcript-quiet subagent run.
                self.sessions[session_id].last_event_mono = monotonic()
        except Exception:
            return  # fail-open on any state error

    # ----- pending buffer (confirmed-alive gate) -----------------------------

    def _sweep_pending(self) -> None:
        """Drop pending events older than _PENDING_TTL_S.

        Called at the head of every apply() — bounded O(buffered sids)
        which stays small in practice (only sids session_discover hasn't
        confirmed yet, mostly transient).
        """
        if not self._pending:
            return
        now = monotonic()
        for sid in list(self._pending.keys()):
            buf = self._pending[sid]
            while buf and (now - buf[0][0]) > _PENDING_TTL_S:
                buf.popleft()
            if not buf:
                del self._pending[sid]

    def _flush_pending(self, session_id: str) -> None:
        """Replay all buffered events for a now-confirmed session, in order."""
        buf = self._pending.pop(session_id, None)
        if not buf:
            return
        for _, ev in list(buf):
            # Re-enter apply(); the sid is now in _confirmed_alive so the
            # gate above accepts.
            self.apply(ev)

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
            "graphify": _dc_to_dict(self.graphify),
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
        payload = event.get("payload") or {}
        # Key by tool_use_id so two concurrent agents of the same subagent_type
        # do not collide. Fall back to agent_name when tool_use_id is absent
        # (e.g. replayed legacy events that predate the new schema).
        key = payload.get("tool_use_id") or event.get("agent") or payload.get("subagent_type")
        if not key:
            return
        agent_name = (event.get("agent") or payload.get("subagent_type") or key)
        sess.agents_active[key] = AgentState(
            name=agent_name,
            started=event.get("ts") or _now(),
            last_tool=event.get("tool"),
            status="running",
            model=str(payload.get("model") or ""),
        )

    def _on_agent_complete(self, sid: Optional[str], event: dict[str, Any]) -> None:
        if not sid:
            return
        sess = self.sessions.get(sid)
        if not sess:
            return
        payload = event.get("payload") or {}
        # Mirror _on_agent_spawn: pop by tool_use_id first, fall back to
        # agent field for legacy events.
        key = payload.get("tool_use_id") or event.get("agent")
        if not key:
            return
        sess.agents_active.pop(key, None)

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
        # SET (do not accumulate): the per-turn context footprint that the
        # Usage gauge should display. Under prompt caching the vast majority
        # of the context lives in cache_read, not tokens_in, so cumulative
        # tokens_in alone would read ~0% of the context window.
        sess.last_context_tokens = (
            int(p.get("cache_read") or 0)
            + int(p.get("cache_write") or 0)
            + int(p.get("tokens_in") or 0)
        )

    def _on_workflow_event(self, sid: Optional[str], event: dict[str, Any]) -> None:
        """Record a workflow_start or workflow_update into the owning session.

        Stamps last_activity_mono on every call so the stale-sweep in
        to_snapshot() has a fresh monotonic reference to work from.
        workflow_complete is never emitted (the Workflow tool is fire-and-forget
        from the hook's perspective); TTL-based staling in to_snapshot() is the
        durable path to clearing "running" entries.
        """
        if not sid:
            return
        sess = self.sessions.get(sid)
        if not sess:
            return
        p = event.get("payload") or {}
        run_id = p.get("run_id") or p.get("workflow_id")
        if not run_id:
            return
        etype = event.get("type")
        if etype == "workflow_start":
            sess.workflows_active[run_id] = WorkflowState(
                name=p.get("name") or p.get("scriptPath") or run_id,
                run_id=run_id,
                phase="running",
                started=event.get("ts") or _now(),
                last_activity_mono=monotonic(),
            )
        elif etype == "workflow_update":
            wf = sess.workflows_active.get(run_id)
            if wf:
                wf.phase = p.get("phase") or wf.phase
                wf.phases_total = int(p.get("phases_total") or wf.phases_total)
                wf.phases_done = int(p.get("phases_done") or wf.phases_done)
                wf.spend_usd = float(p.get("spend_usd") or wf.spend_usd)
                wf.tokens_total = int(p.get("tokens_total") or wf.tokens_total)
                wf.last_activity_mono = monotonic()

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

    def _on_graphify(self, event: dict[str, Any]) -> None:
        """Aggregate Graphify scan/query events into a single rollup.

        Event source split (as of Fix ③):
        - graphify_scan / graphify_query COUNTS come from the Bash hook
          (post-tool-observe.sh), which detects real CLI invocations.
          These events carry session_id so they also appear in session
          recent_events correctly.
        - graphify_tail is STATS-ONLY: it reads graph.json node/edge counts
          and emits graphify_scan events that carry nodes/edges/communities
          but whose 'stats_only' flag is set. Those update the size stats
          WITHOUT incrementing the scan counter. This prevents double-counting
          and eliminates the phantom-scan-on-restart from the old mtime=0 init.

        The snapshot serializer flattens this to a dict for the TUI
        Knowledge tab to read directly.
        """
        p = event.get("payload") or {}
        etype = event.get("type")
        g = self.graphify
        if etype == "graphify_scan":
            # Always update node/edge/community stats when present —
            # both hook events and graphify_tail stats events carry these.
            if p.get("nodes") is not None:
                g.nodes = int(p["nodes"])
            if p.get("edges") is not None:
                g.edges = int(p["edges"])
            if p.get("communities") is not None:
                g.communities = int(p["communities"])
            # Only increment the scan counter for real invocations (hook events).
            # graphify_tail stats events set stats_only=True to signal they are
            # size refreshes, not new scan invocations.
            if not p.get("stats_only"):
                g.scans += 1
                g.last_scan_project = p.get("project")
                g.last_scan_at = p.get("scanned_at") or event.get("ts")
        elif etype == "graphify_query":
            g.queries += 1
            g.last_query_project = p.get("project")
            g.last_query_at = event.get("ts")
            g.last_query_text = p.get("question") or p.get("file")


def _dc_to_dict(dc) -> dict[str, Any]:
    return {k: v for k, v in dc.__dict__.items()}


def _workflow_dict(wf: WorkflowState) -> dict[str, Any]:
    """Serialise a WorkflowState, substituting "stale" for any non-terminal
    status whose last_activity_mono is older than WORKFLOW_STALE_TTL_S.

    The live WorkflowState object is never mutated here — the substitution is
    snapshot-only so the in-memory record stays authoritative if a late event
    arrives for the same run_id.
    """
    d = _dc_to_dict(wf)
    # last_activity_mono is an internal float; strip it from the wire shape.
    d.pop("last_activity_mono", None)
    terminal = {"stale", "completed", "failed", "cancelled"}
    if d.get("phase") not in terminal:
        age = monotonic() - wf.last_activity_mono
        if age > WORKFLOW_STALE_TTL_S:
            d["phase"] = "stale"
    return d


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
        "workflows_active": {k: _workflow_dict(v) for k, v in s.workflows_active.items()},
        "recent_events": recent,
        "tokens_in": s.tokens_in,
        "tokens_out": s.tokens_out,
        "cache_read": s.cache_read,
        "cache_write": s.cache_write,
        "cost_estimate_usd": s.cost_estimate_usd,
        "last_context_tokens": s.last_context_tokens,
    }
