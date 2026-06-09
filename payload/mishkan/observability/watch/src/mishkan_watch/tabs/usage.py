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


# Per-model context window (tokens). Authoritative as of 2026-06 — verified
# against the live Claude model catalogue (shared/models.md). Sonnet 4.6 and
# Opus 4.x both ship with 1M context windows at standard pricing; Haiku 4.5
# stays at 200K. The MISHKAN model-routing YAML keeps most write-heavy
# specialists on Sonnet and orchestration on Opus, so the dominant ceiling for
# a session is 1M — not 200K. Pinning the bar at 200K made the "context used"
# gauge read 5× higher than reality on Sonnet-routed sessions.
_CONTEXT_WINDOW_BY_MODEL = {
    "opus":   1_000_000,
    "sonnet": 1_000_000,
    "haiku":     200_000,
}
# Fallback when no agent attribution is available. Sonnet is the default tier
# in the routing YAML (defaults.unlisted_agent), so 1M is the honest ceiling
# for an un-attributed session.
_DEFAULT_CONTEXT_WINDOW = 1_000_000

# Bytes-per-token approximation is irrelevant here; tokens are emitted
# verbatim by the daemon's token_usage source.


def _session_context_window(sess: dict) -> tuple[int, str]:
    """Pick the right context window for a session.

    Heuristic: walk the session's active agents, look up each agent's tier in
    the routing-derived per-agent map (populated by the daemon when it sees
    the model field on agent events), and take the max. An Opus + Sonnet
    session has a 1M ceiling either way; an all-Haiku session caps at 200K.

    Returns (window_tokens, label) where label is a short tier string for
    display ("opus", "sonnet", "haiku", or "mixed" when multiple tiers run).
    """
    agents = sess.get("agents_active") or {}
    tiers: set[str] = set()
    for ag in agents.values():
        m = (ag.get("model") or "").lower()
        if "opus" in m:
            tiers.add("opus")
        elif "sonnet" in m:
            tiers.add("sonnet")
        elif "haiku" in m:
            tiers.add("haiku")
    if not tiers:
        return _DEFAULT_CONTEXT_WINDOW, "sonnet?"
    if len(tiers) == 1:
        t = next(iter(tiers))
        return _CONTEXT_WINDOW_BY_MODEL.get(t, _DEFAULT_CONTEXT_WINDOW), t
    # Mixed: the limiting factor is whichever tier is loaded heaviest, but
    # for a "context used" gauge the user cares about the smallest ceiling
    # any active agent is bounded by. Haiku in the mix caps the harness at 200K.
    window = min(_CONTEXT_WINDOW_BY_MODEL.get(t, _DEFAULT_CONTEXT_WINDOW) for t in tiers)
    return window, "mixed(" + "+".join(sorted(tiers)) + ")"


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
        # We hold a *mutable copy* of the snapshot state and patch it on every
        # token_usage delta. The daemon's broadcast cadence is one delta per
        # bus event, but a fresh snapshot only arrives on client connect /
        # reconnect — without local accumulation the Usage tab numbers stayed
        # frozen between snapshots even though the status bar moved (the bar
        # accumulates into the app's `_totals` dict). Mirror the same shape
        # here so this tab is live.
        self._state: dict[str, Any] = {"sessions": {}}
        self._selected_sid: str | None = None
        # Throttle re-renders to ~4 Hz max. The bus can emit many deltas per
        # second; rendering on every one costs CPU and never produces a frame
        # the human can read. We dirty-flag instead and the on_mount tick
        # repaints if anything changed since the last paint.
        self._dirty = False

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
            t.add_columns("session", "project", "model", "in", "out", "cached", "$")
        except Exception:
            pass
        # 250 ms repaint tick — flushes whatever deltas accumulated since the
        # last paint. Without this the tab depends on snapshot frames for
        # visible motion, which only arrive on (re)connect; deltas update
        # `_state` silently and the user sees a frozen panel.
        self.set_interval(0.25, self._tick)
        self._render_all()

    def _tick(self) -> None:
        if self._dirty:
            self._dirty = False
            self._render_all()

    # ----- snapshot / event application --------------------------------------

    def apply_snapshot(self, state: dict[str, Any]) -> None:
        # Replace local mirror with the authoritative snapshot. Any deltas
        # that landed between the snapshot's generation and its arrival are
        # already folded in by the daemon.
        self._state = dict(state or {})
        self._state.setdefault("sessions", {})
        self._render_all()

    def apply_event(self, ev: dict[str, Any]) -> None:
        """Patch our local state mirror so the totals move between snapshots.

        Without this, the Usage tab is read-only between snapshot frames —
        the daemon broadcasts deltas (not snapshots) on every bus event, so
        nothing would refresh except on reconnect.
        """
        etype = ev.get("type")
        sid = ev.get("session") or ev.get("session_id") or ev.get("sid")
        sessions = self._state.setdefault("sessions", {})

        if etype == "token_usage" and sid:
            p = ev.get("payload") or {}
            sess = sessions.setdefault(sid, {})
            sess["tokens_in"]  = int(sess.get("tokens_in")  or 0) + int(p.get("tokens_in")  or 0)
            sess["tokens_out"] = int(sess.get("tokens_out") or 0) + int(p.get("tokens_out") or 0)
            sess["cache_read"]  = int(sess.get("cache_read")  or 0) + int(p.get("cache_read")  or 0)
            sess["cache_write"] = int(sess.get("cache_write") or 0) + int(p.get("cache_write") or 0)
            sess["cost_estimate_usd"] = float(sess.get("cost_estimate_usd") or 0.0) \
                                       + float(p.get("cost_estimate_usd") or 0.0)
            self._dirty = True
        elif etype == "agent_spawn" and sid:
            sess = sessions.setdefault(sid, {})
            agents = sess.setdefault("agents_active", {})
            name = ev.get("agent") or (ev.get("payload") or {}).get("name") or "?"
            model = (ev.get("payload") or {}).get("model") or ""
            ag = agents.setdefault(name, {})
            if model:
                ag["model"] = model
            self._dirty = True
        elif etype == "agent_complete" and sid:
            sess = sessions.setdefault(sid, {})
            agents = sess.setdefault("agents_active", {})
            name = ev.get("agent") or (ev.get("payload") or {}).get("name")
            if name and name in agents:
                agents.pop(name, None)
            self._dirty = True
        elif etype == "tool_call" and sid:
            sess = sessions.setdefault(sid, {})
            recent = sess.setdefault("recent_events", [])
            # Keep a bounded tail so the "TOP TOOLS" panel has signal.
            recent.append({"type": "tool_call", "tool": ev.get("tool")})
            if len(recent) > 200:
                del recent[: len(recent) - 200]
            self._dirty = True
        elif etype in ("session_start", "session_stop"):
            self._dirty = True

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
        sessions_map = self._state.get("sessions") or {}
        sessions = list(sessions_map.values())
        tin = sum(int(s.get("tokens_in") or 0) for s in sessions)
        tout = sum(int(s.get("tokens_out") or 0) for s in sessions)
        cr = sum(int(s.get("cache_read") or 0) for s in sessions)
        cw = sum(int(s.get("cache_write") or 0) for s in sessions)
        cost = sum(float(s.get("cost_estimate_usd") or 0.0) for s in sessions)
        agents_running = sum(len(s.get("agents_active") or {}) for s in sessions)
        tool_calls = 0
        for s in sessions:
            for ev in (s.get("recent_events") or []):
                if ev.get("type") == "tool_call":
                    tool_calls += 1

        # Context "used" gauge: pick the worst (most-loaded) session, divide
        # by *its own* context window. Sonnet 4.6 and Opus 4.x carry 1M; Haiku
        # 4.5 carries 200K. A session running 600k tokens on Sonnet is 60%
        # full; the same 600k on Haiku is "over the cap" (which the daemon
        # would normally have already compacted around). Using a single 200k
        # default for everyone (the old behaviour) pinned the bar red on any
        # Sonnet session crossing 160k — a false alarm by 5×.
        used_pct = 0
        worst_label = "—"
        worst_window = _DEFAULT_CONTEXT_WINDOW
        if sessions:
            best_pct = -1
            for sess in sessions:
                tokens_in = int(sess.get("tokens_in") or 0)
                window, label = _session_context_window(sess)
                pct = int(100 * tokens_in / window) if window else 0
                if pct > best_pct:
                    best_pct = pct
                    worst_label = label
                    worst_window = window
            used_pct = min(100, max(0, best_pct))

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
        # Show the actual ceiling we used — 1M for opus/sonnet, 200k for haiku,
        # honest "?" when the session has no agent attribution yet.
        cap_str = f"{worst_window // 1000}k" if worst_window < 1_000_000 else "1M"
        t.append(f"  cap {cap_str} ({worst_label})\n", style="dim italic")
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
            _, model_label = _session_context_window(sess)
            table.add_row(
                Text(sid[:8] + "…", style="cyan"),
                Text(proj[-30:], style="dim"),
                Text(model_label[:10], style="#B794F4"),
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
