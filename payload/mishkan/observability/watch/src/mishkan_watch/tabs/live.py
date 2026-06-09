"""Tab 1 — Live. Default view. 4 panels per §7.3 of design doc.

Panels:
  - ACTIVE (top-left, 32%)     agent roster + workflow lines
  - FEED   (right, 68%)        rolling event stream (Phase 1+1.5 events)
  - WORKTREES (bottom-left)    compact list
  - KNOWLEDGE (bottom-right)   Cognee stores + MCP rollup
"""
from __future__ import annotations

from collections import deque
from typing import Any

from textual.app import ComposeResult
from textual.containers import Container, Horizontal, Vertical
from textual.widgets import RichLog, Static
from rich.text import Text

# Module-level cache for the alias→role lookup (org.json is static).
_ROLE_CACHE: dict[str, str | None] | None = None


def _role_for(alias: str) -> str | None:
    global _ROLE_CACHE
    if _ROLE_CACHE is None:
        try:
            from ..org_data import load_org
            org = load_org()
            cache: dict[str, str | None] = {}
            for grp in org.get("groups", []):
                for ag in grp.get("agents", []):
                    a = (ag.get("alias") or "").lower()
                    if a:
                        cache[a] = ag.get("short") or ag.get("role")
            _ROLE_CACHE = cache
        except Exception:
            _ROLE_CACHE = {}
    return _ROLE_CACHE.get((alias or "").lower())


MAX_FEED_LINES = 200


def _fmt_event_line(ev: dict[str, Any]) -> Text:
    """Render one bus event as a Rich Text line for the FEED."""
    ts = (ev.get("ts") or "")[11:19]  # HH:MM:SS
    etype = ev.get("type", "?")
    tool = ev.get("tool") or ""
    agent = ev.get("agent") or ""
    payload = ev.get("payload") or {}
    outcome = ev.get("outcome") or ""

    summary = _summary_for(etype, tool, agent, outcome, payload)

    line = Text()
    line.append(f"{ts}  ", style="dim")
    line.append(f"{etype:14}", style=_style_for_type(etype))
    line.append(" ")
    line.append(f"{agent:12}", style="bold" if agent else "dim")
    line.append(" ")
    line.append(summary, style=_style_for_outcome(outcome))
    return line


def _summary_for(etype: str, tool: str, agent: str, outcome: str,
                 payload: dict[str, Any]) -> str:
    if etype == "tool_call":
        return f"{tool} {outcome}".strip()
    if etype == "file_change":
        path = payload.get("path", "")
        la = payload.get("lines_added", 0)
        lr = payload.get("lines_removed", 0)
        return f"{tool} +{la}/-{lr}  {path}"
    if etype == "agent_spawn":
        return f"launched {payload.get('subagent_type', '?')}: {payload.get('description', '')[:60]}"
    if etype == "hook_fire":
        return f"{payload.get('hook', '?')} {payload.get('decision', '')}"
    if etype == "skill_invoke":
        return f"skill: {payload.get('skill', '?')}"
    if etype == "plan":
        return f"{payload.get('phase', '?')} approved={payload.get('approved')}"
    if etype == "web_query":
        return f"{payload.get('kind', '')} {payload.get('query', '') or payload.get('url', '')}"[:80]
    if etype == "cron_event":
        return f"{payload.get('action', '')} {payload.get('cron_id') or ''}"
    if etype == "error":
        return f"{payload.get('severity', '?')}: {payload.get('message', '')[:80]}"
    if etype == "token_usage":
        return f"in={payload.get('tokens_in', 0)} out={payload.get('tokens_out', 0)} ${payload.get('cost_estimate_usd', 0):.4f}"
    if etype == "permission":
        return f"{payload.get('tool', '')} {payload.get('decision', '')}"
    if etype == "compaction":
        return f"{payload.get('tokens_before', '?')} -> {payload.get('tokens_after', '?')}"
    if etype == "mcp_server":
        return f"{payload.get('server', '?')} {payload.get('status', '?')}"
    if etype == "worktree_change":
        return f"{payload.get('op', '?')} {payload.get('path', '')}"
    if etype == "inter_agent":
        return payload.get("summary", "")[:80]
    return str(payload)[:80]


def _style_for_type(etype: str) -> str:
    return {
        "tool_call": "white",
        "file_change": "cyan",
        "agent_spawn": "#00D4AA bold",
        "agent_complete": "#68D391",
        "hook_fire": "yellow",
        "skill_invoke": "magenta",
        "plan": "yellow",
        "web_query": "blue",
        "cron_event": "blue",
        "error": "#FC8181 bold",
        "token_usage": "#B794F4",
        "permission": "yellow",
        "compaction": "dim italic",
        "mcp_server": "#F687B3",
        "worktree_change": "white",
        "inter_agent": "cyan italic",
    }.get(etype, "white")


def _style_for_outcome(outcome: str) -> str:
    return {
        "completed": "white",
        "blocked": "#F6AD55",
        "errored": "#FC8181 bold",
    }.get(outcome, "white")


class LiveTab(Container):
    """Tab 1 — Live."""

    DEFAULT_CSS = ""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._state: dict[str, Any] = {}
        # Project filter — None means show all; a Path means filter to that project.
        # Toggled by the app via set_project_filter() in response to the 'p' key.
        self._project_filter: Any = None
        self._feed_buf: deque[Text] = deque(maxlen=MAX_FEED_LINES)

    def compose(self) -> ComposeResult:
        with Horizontal(id="live-row"):
            with Vertical(id="live-left"):
                yield Static("", id="live-active")
                yield Static("", id="live-worktrees")
                yield Static("", id="live-knowledge")
            yield RichLog(id="live-feed", highlight=False, markup=False, wrap=False)

    def on_mount(self) -> None:
        self._render_active({})
        self._render_worktrees({})
        self._render_knowledge({})

    # ----- snapshot / delta application --------------------------------------

    def apply_snapshot(self, state: dict[str, Any]) -> None:
        self._state = state
        self._render_active(state)
        self._render_worktrees(state)
        self._render_knowledge(state)

    def apply_event(self, ev: dict[str, Any]) -> None:
        # Feed: every event lands here. Cheap append, no rebuild.
        try:
            feed = self.query_one("#live-feed", RichLog)
            feed.write(_fmt_event_line(ev))
        except Exception:
            pass
        # Mirror essential daemon-state mutations so structural panels
        # reflect events that arrive AFTER the initial snapshot.
        self._mutate_state(ev)
        # Re-render structural panels ONLY on structural events. tool_call
        # and token_usage land 10-20/sec in bursts; rebuilding ACTIVE on
        # every one churned the main event loop. last_tool / last_activity
        # are nice-to-have but not worth the re-render cost; structural
        # changes (spawn/complete) are what the panel really shows.
        etype = ev.get("type")
        if etype in ("agent_spawn", "agent_complete", "session_start", "session_stop"):
            self._render_active(self._state)
        if etype == "worktree_change":
            self._render_worktrees(self._state)
        if etype in ("mcp_server", "cognee_op", "graphify_scan", "graphify_query"):
            self._render_knowledge(self._state)

    def _mutate_state(self, ev: dict[str, Any]) -> None:
        """Mirror the subset of daemon-side HarnessState.apply needed for
        the LIVE tab's structural panels. Idempotent on unknowns."""
        try:
            etype = ev.get("type")
            sid = ev.get("session")
            sessions = self._state.setdefault("sessions", {})
            if sid and sid not in sessions:
                sessions[sid] = {
                    "session_id": sid,
                    "project": ev.get("project") or "unknown",
                    "agents_active": {},
                    "workflows_active": {},
                }
            if etype == "agent_spawn" and sid:
                payload = ev.get("payload") or {}
                name = ev.get("agent") or payload.get("subagent_type")
                # Resolve the stable key: prefer tool_use_id from payload,
                # then top-level subagent_id (older hook schema), then name.
                key = payload.get("tool_use_id") or ev.get("subagent_id") or name
                if name and key:
                    agents = sessions[sid].setdefault("agents_active", {})
                    # Avoid a ghost duplicate: if an entry with the same .name
                    # already exists under a different key (key-scheme mismatch
                    # between snapshot and delta), remove the stale entry first.
                    stale = [k for k, ag in agents.items()
                             if ag.get("name") == name and k != key]
                    for k in stale:
                        del agents[k]
                    agents[key] = {
                        "name": name,
                        "started": ev.get("ts"),
                        "last_tool": ev.get("tool"),
                        "status": "running",
                    }
            elif etype == "agent_complete" and sid:
                payload = ev.get("payload") or {}
                key = payload.get("tool_use_id") or ev.get("subagent_id") or ev.get("agent")
                if key:
                    agents = sessions[sid].get("agents_active", {})
                    agents.pop(key, None)
                    # Also sweep any same-named ghost entries left by a prior
                    # key-scheme mismatch on spawn.
                    name = ev.get("agent") or (ev.get("payload") or {}).get("subagent_type")
                    if name:
                        for k in [k for k, ag in agents.items()
                                  if ag.get("name") == name]:
                            del agents[k]
            elif etype == "tool_call" and sid:
                name = ev.get("agent")
                if name:
                    # tool_call carries agent name, not tool_use_id; find by name
                    for ag in sessions[sid].get("agents_active", {}).values():
                        if ag.get("name") == name:
                            ag["last_tool"] = ev.get("tool")
                            ag["last_activity"] = ev.get("ts")
                            break
            elif etype == "worktree_change":
                p = ev.get("payload") or {}
                path = p.get("path")
                if path:
                    worktrees = self._state.setdefault("worktrees", {})
                    if p.get("op") == "remove":
                        worktrees.pop(path, None)
                    else:
                        worktrees[path] = {
                            "path": path,
                            "branch": p.get("branch") or "",
                            "owner_session": p.get("owner_session"),
                            "head": p.get("head"),
                        }
            elif etype == "mcp_server":
                p = ev.get("payload") or {}
                name = p.get("server") or ev.get("tool")
                if name:
                    mcps = self._state.setdefault("mcp_servers", {})
                    existing = mcps.get(name, {"name": name, "url": p.get("url") or ""})
                    existing["status"] = p.get("status") or existing.get("status", "?")
                    existing["last_event"] = ev.get("ts")
                    mcps[name] = existing
            elif etype == "cognee_op":
                p = ev.get("payload") or {}
                store = p.get("store")
                if store:
                    cognee = self._state.setdefault("cognee", {})
                    entry = cognee.setdefault(store, {})
                    entry["up"] = bool(p.get("up"))
                    entry["url"] = p.get("url") or entry.get("url", "")
                    if "nodes" in p:
                        entry["nodes"] = p.get("nodes")
                    entry["last_event"] = ev.get("ts")
            elif etype in ("graphify_scan", "graphify_query"):
                p = ev.get("payload") or {}
                g = self._state.setdefault("graphify", {})
                if etype == "graphify_scan":
                    g["nodes"] = p.get("nodes")
                    g["edges"] = p.get("edges")
                    g["communities"] = p.get("communities")
                    # stats_only probes update size display but are not real scans
                    if not p.get("stats_only"):
                        g["scans"] = (g.get("scans") or 0) + 1
                        g["last_scan_at"] = p.get("scanned_at") or ev.get("ts")
                else:
                    g["queries"] = (g.get("queries") or 0) + 1
                    g["last_query_at"] = ev.get("ts")
            elif etype == "session_stop" and sid:
                sessions.pop(sid, None)
        except Exception:
            return

    # ----- panel renderers ---------------------------------------------------

    def set_project_filter(self, project: Any) -> None:
        """Called by the app when the user toggles the project filter (key 'p')."""
        self._project_filter = project
        self._render_active(self._state)
        self._render_worktrees(self._state)

    def _session_matches_filter(self, sess: dict[str, Any]) -> bool:
        """Match a session to the active project filter, tolerating both
        absolute paths and Claude Code's encoded dir form.

        Claude Code stores sessions under ~/.claude/projects/<encoded>/...
        where <encoded> is the absolute project path with '/' replaced by
        '-' (e.g. -home-ogu-theY4NN-harness). The daemon's session.project
        field carries this encoded form. The filter target is an absolute
        Path. We compare both:
          - absolute  →  encoded     (replace '/' with '-')
          - encoded   →  basename match (last segment)
        """
        flt = getattr(self, "_project_filter", None)
        if not flt:
            return True
        proj = (sess.get("project") or "").rstrip("/")
        if not proj:
            return False
        target_abs = str(flt).rstrip("/")
        # Encoded form: leading dash + path with '/' → '-'.
        target_encoded = target_abs.replace("/", "-")
        if proj == target_abs or proj == target_encoded:
            return True
        # Last-segment fallback (covers both encoded and absolute forms).
        return proj.rsplit("-", 1)[-1] == target_abs.rsplit("/", 1)[-1]

    def _render_active(self, state: dict[str, Any]) -> None:
        try:
            panel = self.query_one("#live-active", Static)
        except Exception:
            return
        sessions = (state or {}).get("sessions") or {}
        text = Text()
        flt = getattr(self, "_project_filter", None)
        title = "ACTIVE" if not flt else f"ACTIVE  ·  {str(flt).split('/')[-1]} only (p to toggle)"
        text.append(title + "\n", style="bold dim")
        any_agent = False
        for sid, sess in sessions.items():
            if not self._session_matches_filter(sess):
                continue
            for _key, ag in (sess.get("agents_active") or {}).items():
                any_agent = True
                # Always use the stored name field — the key may be a tool_use_id
                # (from daemon snapshot) or a legacy name; the name field is always
                # the human-readable subagent_type.
                name = ag.get("name") or _key
                started = (ag.get("started") or "")[11:19]
                last_tool = ag.get("last_tool") or "-"
                status = ag.get("status") or "running"
                dot = {"running": "●", "idle": "○", "errored": "✗"}.get(status, "●")
                style = _style_for_type("agent_spawn") if status == "running" else "dim"
                text.append(f"{dot} ", style=style)
                text.append(f"{name:14}", style="bold")
                role = _role_for(name)
                if role:
                    text.append(f" · {role:18}", style="dim")
                text.append(f"  {started}  {last_tool}\n", style="dim")
        if not any_agent:
            text.append("(no active agents)\n", style="dim italic")
        text.append("\nWORKFLOWS\n", style="bold dim")
        any_wf = False
        for sid, sess in sessions.items():
            for wid, wf in (sess.get("workflows_active") or {}).items():
                any_wf = True
                total = wf.get("phases_total") or 0
                done = wf.get("phases_done") or 0
                phase = wf.get("phase") or "?"
                cost = wf.get("spend_usd") or 0.0
                text.append(f"║ {wf.get('name','?')[:18]:18}  {done}/{total}  {phase[:14]:14}  ${cost:.2f}\n",
                            style="#B794F4")
        if not any_wf:
            text.append("(none)\n", style="dim italic")
        panel.update(text)

    def _render_worktrees(self, state: dict[str, Any]) -> None:
        try:
            panel = self.query_one("#live-worktrees", Static)
        except Exception:
            return
        worktrees = (state or {}).get("worktrees") or {}
        text = Text()
        text.append("WORKTREES\n", style="bold dim")
        if not worktrees:
            text.append("(none)\n", style="dim italic")
        for path, wt in list(worktrees.items())[:6]:
            owner = wt.get("owner_session") or "-"
            branch = wt.get("branch") or "-"
            text.append(f"{path[-30:]:30} {branch[:14]:14}  {owner[:8]}\n", style="white")
        panel.update(text)

    def _render_knowledge(self, state: dict[str, Any]) -> None:
        try:
            panel = self.query_one("#live-knowledge", Static)
        except Exception:
            return
        text = Text()
        text.append("KNOWLEDGE\n", style="bold dim")
        cognee = (state or {}).get("cognee") or {}
        for name, s in cognee.items():
            up = "●" if s.get("up") else "✗"
            nodes = s.get("nodes", 0)
            text.append(f"{up} ", style="#00D4AA" if s.get("up") else "#FC8181")
            text.append(f"{name:12} ", style="bold")
            text.append(f"{nodes:>6} nodes\n", style="white")
        if not cognee:
            text.append("(cognee not yet probed)\n", style="dim italic")
        g = (state or {}).get("graphify") or {}
        if g:
            nodes = g.get("nodes")
            edges = g.get("edges")
            scans = g.get("scans") or 0
            queries = g.get("queries") or 0
            text.append("● ", style="#00D4AA")
            text.append(f"{'graphify':12} ", style="bold")
            if nodes is not None:
                text.append(f"{nodes:>6} nodes", style="white")
                if edges is not None:
                    text.append(f" / {edges:,} edges", style="dim")
                text.append("\n")
            text.append(f"  {scans} scans · {queries} queries\n", style="dim")
        mcp = (state or {}).get("mcp_servers") or {}
        if mcp:
            text.append("\nMCP\n", style="bold dim")
            for name, s in mcp.items():
                status = s.get("status", "?")
                dot = {"up": "●", "down": "✗", "stale": "⟳"}.get(status, "○")
                color = {"up": "#00D4AA", "down": "#FC8181", "stale": "#F6AD55"}.get(status, "dim")
                text.append(f"{dot} ", style=color)
                text.append(f"{name}\n", style="white")
        panel.update(text)
