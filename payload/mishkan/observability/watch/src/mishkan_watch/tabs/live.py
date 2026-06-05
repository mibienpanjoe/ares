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
        if etype in ("mcp_server", "cognee_op"):
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
                name = ev.get("agent") or (ev.get("payload") or {}).get("subagent_type")
                if name:
                    sessions[sid].setdefault("agents_active", {})[name] = {
                        "name": name,
                        "started": ev.get("ts"),
                        "last_tool": ev.get("tool"),
                        "status": "running",
                    }
            elif etype == "agent_complete" and sid:
                name = ev.get("agent")
                if name:
                    sessions[sid].get("agents_active", {}).pop(name, None)
            elif etype == "tool_call" and sid:
                name = ev.get("agent")
                if name:
                    ag = sessions[sid].get("agents_active", {}).get(name)
                    if ag:
                        ag["last_tool"] = ev.get("tool")
                        ag["last_activity"] = ev.get("ts")
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
            elif etype == "session_stop" and sid:
                sessions.pop(sid, None)
        except Exception:
            return

    # ----- panel renderers ---------------------------------------------------

    def _render_active(self, state: dict[str, Any]) -> None:
        try:
            panel = self.query_one("#live-active", Static)
        except Exception:
            return
        sessions = (state or {}).get("sessions") or {}
        text = Text()
        text.append("ACTIVE\n", style="bold dim")
        any_agent = False
        for sid, sess in sessions.items():
            for name, ag in (sess.get("agents_active") or {}).items():
                any_agent = True
                started = (ag.get("started") or "")[11:19]
                last_tool = ag.get("last_tool") or "-"
                status = ag.get("status") or "running"
                dot = {"running": "●", "idle": "○", "errored": "✗"}.get(status, "●")
                style = _style_for_type("agent_spawn") if status == "running" else "dim"
                text.append(f"{dot} ", style=style)
                text.append(f"{name:14}", style="bold")
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
