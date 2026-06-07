"""Tab 2 — Agents.

3-column layout per §7.3:
  - SESSIONS Tree (left, 22%)       — sessions × agents
  - AGENT HISTORY DataTable (center, 53%) — events for the selected agent
  - ERRORS ListView (right, 25%)    — errors per agent

Selection in the Tree drives the DataTable. Errors are filtered from
recent_events of all sessions.
"""
from __future__ import annotations

from collections import deque
from typing import Any, Optional

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Container, Horizontal
from textual.widgets import DataTable, Static, Tree
from textual.widgets.tree import TreeNode


def _pretty_project(project: Optional[str]) -> str:
    """Decode Claude Code's encoded project dir name into a real path.

    ~/.claude/projects encodes each working directory as its absolute
    path with '/' replaced by '-'. Reverse it for display so the user
    sees /home/ogu/theY4NN/harness instead of
    -home-ogu-theY4NN-harness. If the input doesn't look encoded
    (starts with '/' already, or is empty/unknown), pass through.
    """
    if not project or project in ("unknown", "?"):
        return "?"
    if project.startswith("/"):
        # Already a real path (post-tool-observe.sh sets pwd).
        return project
    if project.startswith("-"):
        # Encoded form: leading "-" maps to "/", subsequent "-" likely
        # also "/". This loses information when a real dir name
        # contains "-", but covers the common case.
        return project.replace("-", "/")
    return project


class AgentsTab(Container):
    DEFAULT_CSS = ""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._state: dict[str, Any] = {}
        # Per-(session, agent) deque of recent events
        self._history: dict[tuple[str, str], deque[dict[str, Any]]] = {}
        self._errors: deque[dict[str, Any]] = deque(maxlen=50)
        self._selected: Optional[tuple[str, str]] = None  # (session, agent) | None
        # Per-session current active subagent. None == main. Set on
        # agent_spawn, cleared on agent_complete. Bus events that carry
        # agent: null are attributed to this agent so the per-agent view
        # actually contains the work done while that subagent was alive.
        self._current_agent: dict[str, Optional[str]] = {}

    def compose(self) -> ComposeResult:
        with Horizontal(id="agents-row"):
            yield Tree("Sessions", id="agents-tree")
            with Container(id="agents-center"):
                yield Static("AGENT HISTORY", classes="panel-title")
                yield DataTable(id="agents-table", cursor_type="row",
                                zebra_stripes=False)
            with Container(id="agents-errors"):
                yield Static("ERRORS", classes="panel-title")
                yield Static("(no errors)", id="agents-errors-list")

    def on_mount(self) -> None:
        try:
            table = self.query_one("#agents-table", DataTable)
            table.add_columns("time", "type", "tool", "outcome", "ms")
        except Exception:
            pass
        self._rebuild_tree()

    # ----- snapshot / event application --------------------------------------

    def apply_snapshot(self, state: dict[str, Any]) -> None:
        self._state = state
        # Build history from snapshot's recent_events. Walk events in ts
        # order across all sessions so the per-session current_agent stack
        # is rebuilt in the order events actually occurred.
        self._history.clear()
        self._errors.clear()
        self._current_agent.clear()
        all_events: list[dict[str, Any]] = []
        for sid, sess in (state.get("sessions") or {}).items():
            for ev in (sess.get("recent_events") or []):
                all_events.append(ev)
        all_events.sort(key=lambda e: e.get("ts") or "")
        for ev in all_events:
            self._ingest_event(ev)
        self._rebuild_tree()
        self._render_errors()
        if self._selected:
            self._render_history(*self._selected)

    def apply_event(self, ev: dict[str, Any]) -> None:
        self._mutate_state(ev)
        self._ingest_event(ev)
        etype = ev.get("type")
        if etype in ("agent_spawn", "agent_complete", "session_start", "session_stop"):
            self._rebuild_tree()
        if etype == "error":
            self._render_errors()
        if self._selected:
            sid, agent = self._selected
            if ev.get("session") == sid:
                # An event is "for" the selected agent if it was attributed
                # to that agent by _ingest_event. Re-derive: explicit agent
                # tag wins, else the session's current_agent at the moment
                # this event was processed (already applied just above).
                explicit = ev.get("agent")
                effective = explicit or self._current_agent.get(sid) or "(main)"
                if effective == agent:
                    # Append-only update — no DataTable.clear + re-fill
                    # per event. Vastly cheaper for tool-call bursts.
                    self._append_history_row(ev)

    def _mutate_state(self, ev: dict[str, Any]) -> None:
        try:
            sid = ev.get("session")
            etype = ev.get("type")
            sessions = self._state.setdefault("sessions", {})
            if sid and sid not in sessions:
                sessions[sid] = {
                    "session_id": sid,
                    "project": ev.get("project") or "unknown",
                    "agents_active": {},
                }
            if etype == "agent_spawn" and sid:
                name = ev.get("agent") or (ev.get("payload") or {}).get("subagent_type")
                if name:
                    sessions[sid].setdefault("agents_active", {})[name] = {
                        "name": name,
                        "started": ev.get("ts"),
                        "status": "running",
                    }
            elif etype == "agent_complete" and sid:
                name = ev.get("agent")
                if name:
                    sessions[sid].get("agents_active", {}).pop(name, None)
        except Exception:
            return

    def _ingest_event(self, ev: dict[str, Any]) -> None:
        try:
            sid = ev.get("session")
            if not sid:
                return
            etype = ev.get("type")
            explicit = ev.get("agent")
            # Maintain per-session current_agent so subsequent agent: null
            # events are attributed correctly. Subagents in Claude Code run
            # one-at-a-time per parent session in practice, so a flat
            # "current agent" tracks the common case cleanly.
            if etype == "agent_spawn":
                name = explicit or (ev.get("payload") or {}).get("subagent_type")
                if name:
                    self._current_agent[sid] = name
                    tag = name
                else:
                    tag = "(main)"
            elif etype == "agent_complete":
                self._current_agent.pop(sid, None)
                tag = explicit or "(main)"
            else:
                tag = explicit or self._current_agent.get(sid) or "(main)"
            key = (sid, tag)
            buf = self._history.setdefault(key, deque(maxlen=50))
            buf.append(ev)
            if etype == "error":
                self._errors.append(ev)
        except Exception:
            return

    # ----- tree / table / errors renderers -----------------------------------

    def _rebuild_tree(self) -> None:
        try:
            tree = self.query_one("#agents-tree", Tree)
        except Exception:
            return
        tree.clear()
        root = tree.root
        root.expand()
        sessions = (self._state.get("sessions") or {})
        # Daemon-side confirmed-alive gate (state.py) is the source of
        # truth for what counts as a real session. Any session reaching
        # us here is confirmed by session_discover. A residual project=""
        # entry would be a daemon bug — surface it visually as "?" so we
        # notice rather than silently hiding it.
        for sid, sess in sessions.items():
            label = Text()
            label.append(sid[:8] + "… ", style="cyan")
            label.append(_pretty_project(sess.get("project"))[:30], style="dim")
            sess_node = root.add(label, data={"kind": "session", "sid": sid})
            sess_node.expand()
            agents = sess.get("agents_active") or {}
            if not agents:
                sess_node.add_leaf(Text("(main only)", style="dim italic"),
                                   data={"kind": "agent", "sid": sid, "agent": "(main)"})
            else:
                for name, ag in agents.items():
                    al = Text()
                    al.append("● ", style="#00D4AA")
                    al.append(name, style="bold")
                    role = _role_for(name)
                    if role:
                        al.append(f"  · {role}", style="dim")
                    sess_node.add_leaf(al, data={"kind": "agent", "sid": sid, "agent": name})

    def on_tree_node_selected(self, event: Tree.NodeSelected) -> None:
        data = event.node.data or {}
        if data.get("kind") != "agent":
            return
        sid = data.get("sid")
        agent = data.get("agent")
        if sid and agent:
            self._selected = (sid, agent)
            self._render_history(sid, agent)

    def _render_history(self, sid: str, agent: str) -> None:
        """Full rebuild — used on selection change and on snapshot."""
        try:
            table = self.query_one("#agents-table", DataTable)
        except Exception:
            return
        table.clear()
        events = self._history.get((sid, agent), deque())
        for ev in list(events)[-50:]:
            self._add_history_row(table, ev)

    def _append_history_row(self, ev: dict[str, Any]) -> None:
        """Incremental update — append one row to the existing table."""
        try:
            table = self.query_one("#agents-table", DataTable)
        except Exception:
            return
        self._add_history_row(table, ev)
        # Keep table bounded: drop the oldest row if we exceed 50.
        try:
            if table.row_count > 50:
                first_key = list(table.rows.keys())[0]
                table.remove_row(first_key)
        except Exception:
            pass

    def _add_history_row(self, table: DataTable, ev: dict[str, Any]) -> None:
        ts = (ev.get("ts") or "")[11:19]
        etype = ev.get("type", "?")
        tool = ev.get("tool") or "-"
        outcome = ev.get("outcome") or "-"
        dur = ev.get("duration_ms") or 0
        style = "red" if outcome == "errored" else (
            "yellow" if outcome == "blocked" else "white")
        table.add_row(
            Text(ts, style="dim"),
            Text(etype, style=style),
            Text(str(tool)[:14]),
            Text(str(outcome)),
            Text(f"{dur}ms" if dur else "-", style="dim"),
        )

    def _render_errors(self) -> None:
        try:
            panel = self.query_one("#agents-errors-list", Static)
        except Exception:
            return
        text = Text()
        if not self._errors:
            text.append("(no errors)\n", style="dim italic")
        else:
            for ev in list(self._errors)[-15:]:
                p = ev.get("payload") or {}
                ts = (ev.get("ts") or "")[11:19]
                agent = ev.get("agent") or "(main)"
                role = _role_for(agent) if agent != "(main)" else None
                msg = (p.get("message") or "")[:60]
                label = f"{agent} · {role}" if role else agent
                text.append(f"● {label}  {ts}\n", style="#FC8181 bold")
                text.append(f"  {msg}\n", style="white")
                text.append("─────────\n", style="dim")
        panel.update(text)


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
