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


class AgentsTab(Container):
    DEFAULT_CSS = ""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._state: dict[str, Any] = {}
        # Per-(session, agent) deque of recent events
        self._history: dict[tuple[str, str], deque[dict[str, Any]]] = {}
        self._errors: deque[dict[str, Any]] = deque(maxlen=50)
        self._selected: Optional[tuple[str, str]] = None  # (session, agent) | None

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
        # Build history from snapshot's recent_events
        self._history.clear()
        self._errors.clear()
        for sid, sess in (state.get("sessions") or {}).items():
            for ev in (sess.get("recent_events") or []):
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
            if ev.get("session") == sid and (ev.get("agent") == agent or agent == "(main)"):
                self._render_history(sid, agent)

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
            agent = ev.get("agent") or "(main)"
            if not sid:
                return
            key = (sid, agent)
            buf = self._history.setdefault(key, deque(maxlen=50))
            buf.append(ev)
            if ev.get("type") == "error":
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
        for sid, sess in sessions.items():
            label = Text()
            label.append(sid[:8] + "… ", style="cyan")
            label.append(sess.get("project", "?")[:30], style="dim")
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
        try:
            table = self.query_one("#agents-table", DataTable)
        except Exception:
            return
        table.clear()
        events = self._history.get((sid, agent), deque())
        for ev in list(events)[-50:]:
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
                msg = (p.get("message") or "")[:60]
                text.append(f"● {agent}  {ts}\n", style="#FC8181 bold")
                text.append(f"  {msg}\n", style="white")
                text.append("─────────\n", style="dim")
        panel.update(text)
