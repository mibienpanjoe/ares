"""Tab 7 — Usage Overview.

Aggregates token consumption, cost, request counts, and context-window
estimates across all sessions. Provides the detailed breakdown the
status bar can't fit.

Layout (left → right):
  - TOTALS card  : harness-wide tokens / cost / requests
  - SESSIONS     : per-session breakdown table
  - DETAIL       : selected session deep-dive (agents, top tools, recent activity)
"""
from __future__ import annotations

from typing import Any

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Container, Horizontal
from textual.widgets import DataTable, Static


# Heuristic context window per model family. Used only when we don't know
# the agent's model — Opus is the safe default since that's the orchestrator.
_DEFAULT_CONTEXT_WINDOW = 200_000  # Claude Opus / Sonnet 4.x


def _fmt_count(n: int | float) -> str:
    n = int(n or 0)
    if n >= 1_000_000:
        return f"{n/1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}k"
    return str(n)


def _fmt_money(d: float) -> str:
    if not d:
        return "$0.00"
    return f"${d:.2f}" if d < 100 else f"${d:.0f}"


class UsageTab(Container):
    DEFAULT_CSS = ""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._state: dict[str, Any] = {}
        self._selected_sid: str | None = None

    def compose(self) -> ComposeResult:
        with Horizontal(id="usage-row"):
            with Container(id="usage-totals"):
                yield Static("", id="usage-totals-body")
            with Container(id="usage-sessions"):
                yield Static("SESSIONS", classes="panel-title")
                yield DataTable(id="usage-sessions-table",
                                cursor_type="row", zebra_stripes=False)
            with Container(id="usage-detail"):
                yield Static("", id="usage-detail-body")

    def on_mount(self) -> None:
        try:
            t = self.query_one("#usage-sessions-table", DataTable)
            t.add_columns("session", "project", "in", "out", "cached", "$")
        except Exception:
            pass
        self._render_all()

    # ----- snapshot / event application --------------------------------------

    def apply_snapshot(self, state: dict[str, Any]) -> None:
        self._state = state
        self._render_all()

    def apply_event(self, ev: dict[str, Any]) -> None:
        etype = ev.get("type")
        # The structural totals come from the daemon's session state. We
        # don't need to mirror token_usage locally because the daemon
        # updates SessionState.tokens_* and broadcasts on each event.
        # Re-render on the events that actually change usage numbers.
        if etype in ("token_usage", "agent_spawn", "agent_complete",
                     "tool_call", "session_start", "session_stop"):
            self._render_all()

    # ----- renderers ---------------------------------------------------------

    def _render_all(self) -> None:
        self._render_totals()
        self._render_sessions()
        self._render_detail()

    def _render_totals(self) -> None:
        try:
            panel = self.query_one("#usage-totals-body", Static)
        except Exception:
            return
        sessions = (self._state.get("sessions") or {}).values()
        tin = sum(int(s.get("tokens_in") or 0) for s in sessions)
        tout = sum(int(s.get("tokens_out") or 0) for s in sessions)
        cr = sum(int(s.get("cache_read") or 0) for s in sessions)
        cw = sum(int(s.get("cache_write") or 0) for s in sessions)
        cost = sum(float(s.get("cost_estimate_usd") or 0.0) for s in sessions)
        agents_running = sum(len(s.get("agents_active") or {}) for s in sessions)
        # Request counts come from per-session recent_events; approximate
        # by counting tool_call entries across recent windows.
        tool_calls = 0
        for s in sessions:
            for ev in (s.get("recent_events") or []):
                if ev.get("type") == "tool_call":
                    tool_calls += 1
        # Context window estimate — assume Opus 200k per session.
        used_pct = 0
        if sessions:
            largest_in = max((int(s.get("tokens_in") or 0) for s in sessions), default=0)
            used_pct = min(100, int(100 * largest_in / _DEFAULT_CONTEXT_WINDOW))

        t = Text()
        t.append("HARNESS USAGE\n", style="bold #B794F4")
        t.append("\n")
        t.append("TOKENS\n", style="bold dim")
        t.append(f"  in     {_fmt_count(tin):>10}\n", style="cyan")
        t.append(f"  out    {_fmt_count(tout):>10}\n", style="cyan")
        t.append(f"  cache  {_fmt_count(cr):>10}", style="dim")
        t.append(f"  read\n", style="dim")
        t.append(f"         {_fmt_count(cw):>10}", style="dim")
        t.append(f"  write\n", style="dim")
        t.append("\n")
        t.append("COST\n", style="bold dim")
        t.append(f"  {_fmt_money(cost)}\n", style="#68D391 bold")
        t.append("\n")
        t.append("CONTEXT (worst sess.)\n", style="bold dim")
        bar = "█" * (used_pct // 5) + "░" * (20 - used_pct // 5)
        bar_color = "#FC8181" if used_pct > 80 else ("#F6AD55" if used_pct > 60 else "#00D4AA")
        t.append(f"  {bar}", style=bar_color)
        t.append(f"  {used_pct}%\n", style="dim")
        t.append(f"  est. cap {_DEFAULT_CONTEXT_WINDOW//1000}k\n", style="dim italic")
        t.append("\n")
        t.append("REQUESTS\n", style="bold dim")
        t.append(f"  tool_calls   {tool_calls:>6}\n", style="white")
        t.append(f"  agents now   {agents_running:>6}\n", style="white")
        panel.update(t)

    def _render_sessions(self) -> None:
        try:
            table = self.query_one("#usage-sessions-table", DataTable)
        except Exception:
            return
        table.clear()
        sessions = (self._state.get("sessions") or {})
        # Sort by tokens_in desc so the heaviest is on top.
        rows = sorted(sessions.items(),
                      key=lambda kv: int((kv[1].get("tokens_in") or 0)),
                      reverse=True)
        for sid, sess in rows[:15]:
            proj = sess.get("project") or "unknown"
            # Decode encoded form.
            if proj.startswith("-"):
                proj = proj.replace("-", "/")
            tin = int(sess.get("tokens_in") or 0)
            tout = int(sess.get("tokens_out") or 0)
            cr = int(sess.get("cache_read") or 0)
            cost = float(sess.get("cost_estimate_usd") or 0.0)
            table.add_row(
                Text(sid[:8] + "…", style="cyan"),
                Text(proj[-30:], style="dim"),
                Text(_fmt_count(tin), style="cyan"),
                Text(_fmt_count(tout), style="cyan"),
                Text(_fmt_count(cr), style="dim"),
                Text(_fmt_money(cost), style="#68D391"),
            )

    def on_data_table_row_selected(self, event) -> None:
        # Pick the session id from the first column of the selected row.
        try:
            table = self.query_one("#usage-sessions-table", DataTable)
            row = table.get_row(event.row_key)
            sid_text = str(row[0])
            sid_prefix = sid_text.rstrip("…").strip()
            sessions = self._state.get("sessions") or {}
            for sid in sessions:
                if sid.startswith(sid_prefix):
                    self._selected_sid = sid
                    self._render_detail()
                    return
        except Exception:
            return

    def _render_detail(self) -> None:
        try:
            panel = self.query_one("#usage-detail-body", Static)
        except Exception:
            return
        sessions = self._state.get("sessions") or {}
        sid = self._selected_sid
        # Default to the heaviest session if none selected.
        if not sid or sid not in sessions:
            if sessions:
                sid = max(sessions, key=lambda k: int(sessions[k].get("tokens_in") or 0))
            else:
                panel.update(Text("(no session)", style="dim italic"))
                return
        sess = sessions[sid]
        t = Text()
        t.append("DETAIL\n", style="bold #B794F4")
        t.append(f"  session {sid[:12]}…\n", style="cyan")
        proj = sess.get("project") or "unknown"
        if proj.startswith("-"):
            proj = proj.replace("-", "/")
        t.append(f"  project {proj}\n", style="dim")
        t.append("\n")
        # Per-agent breakdown
        agents = sess.get("agents_active") or {}
        t.append("AGENTS ACTIVE\n", style="bold dim")
        if not agents:
            t.append("  (none)\n", style="dim italic")
        else:
            for name, ag in list(agents.items())[:10]:
                last = ag.get("last_tool") or "-"
                tin = _fmt_count(int(ag.get("tokens_in") or 0))
                tout = _fmt_count(int(ag.get("tokens_out") or 0))
                t.append(f"  ● {name:14}", style="#00D4AA")
                t.append(f" in {tin:>5}", style="cyan")
                t.append(f" out {tout:>5}", style="cyan")
                t.append(f"  {last}\n", style="dim")
        t.append("\n")
        # Top tools from recent events
        tool_count: dict[str, int] = {}
        for ev in (sess.get("recent_events") or []):
            if ev.get("type") == "tool_call":
                tool = ev.get("tool") or "?"
                tool_count[tool] = tool_count.get(tool, 0) + 1
        if tool_count:
            t.append("TOP TOOLS\n", style="bold dim")
            top = sorted(tool_count.items(), key=lambda kv: -kv[1])[:8]
            for tool, count in top:
                t.append(f"  {tool:14} {count:>4}\n", style="white")
        panel.update(t)

    # ----- API expected by app.py -------------------------------------------

    def set_project_filter(self, project: Any) -> None:
        # Usage tab is informational across all sessions — filter is a no-op.
        return
