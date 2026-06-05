"""mishkan-watch Textual App.

5 tabs (Live default, Agents/Workflows/Knowledge stubs for Phase 4,
Activity), permanent status bar at the bottom (cost + session age +
fan-out), Header on top with tab labels. Connects to mishkan-watchd via
UNIX socket and dispatches snapshot + deltas to the appropriate tab.
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container
from textual.widgets import Footer, Header, Static, TabbedContent, TabPane
from rich.text import Text

from .client import DEFAULT_SOCKET, DaemonClient, _dlog
from .tabs.activity import ActivityTab
from .tabs.agents import AgentsTab
from .tabs.knowledge import KnowledgeTab
from .tabs.live import LiveTab
from .tabs.workflows import WorkflowsTab


class MishkanWatch(App):
    """The TUI."""

    CSS_PATH = "theme.tcss"
    TITLE = "mishkan-watch"

    BINDINGS = [
        Binding("q", "quit", "quit"),
        Binding("1", "switch_tab('live')", "Live"),
        Binding("2", "switch_tab('agents')", "Agents"),
        Binding("3", "switch_tab('workflows')", "Workflows"),
        Binding("4", "switch_tab('knowledge')", "Knowledge"),
        Binding("5", "switch_tab('activity')", "Activity"),
        Binding("question_mark", "show_help", "help", show=False),
    ]

    def __init__(self, socket_path: Path | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self._socket_path = socket_path or DEFAULT_SOCKET
        self._client: DaemonClient | None = None
        self._started_at = time.time()
        self._totals = {
            "tokens_in": 0,
            "tokens_out": 0,
            "cache_read": 0,
            "cache_write": 0,
            "cost_estimate_usd": 0.0,
            "agents_active": 0,
            "workflows_active": 0,
            "status": "starting",
        }

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with TabbedContent(initial="live"):
            with TabPane("Live", id="live"):
                yield LiveTab(id="tab-live")
            with TabPane("Agents", id="agents"):
                yield AgentsTab(id="tab-agents")
            with TabPane("Workflows", id="workflows"):
                yield WorkflowsTab(id="tab-workflows")
            with TabPane("Knowledge", id="knowledge"):
                yield KnowledgeTab(id="tab-knowledge")
            with TabPane("Activity", id="activity"):
                yield ActivityTab(id="tab-activity")
        yield Static("", id="status-bar")
        yield Footer()

    async def on_mount(self) -> None:
        # Status bar refresh on a fixed cadence rather than on every event.
        # In busy periods events fire 10-20/sec; rebuilding the Rich Text
        # on each was a major source of UI latency. 500 ms ticks feel
        # live without saturating the loop.
        self.set_interval(0.5, self._refresh_status_bar)
        self._client = DaemonClient(self._socket_path)
        await self._client.start(self._on_frame, self._on_status)

    async def on_unmount(self) -> None:
        if self._client:
            await self._client.stop()

    # ----- daemon frame handling --------------------------------------------

    async def _on_status(self, status: str) -> None:
        self._totals["status"] = status
        self._refresh_status_bar()

    async def _on_frame(self, frame: dict[str, Any]) -> None:
        ftype = frame.get("type")
        if ftype == "snapshot":
            state = frame.get("state") or {}
            sessions_in_snap = len((state or {}).get("sessions") or {})
            _dlog(f"app: snapshot sessions={sessions_in_snap}")
            self._sync_totals_from_snapshot(state)
            tabs = self._all_tabs()
            _dlog(f"app: dispatching snapshot to {len(tabs)} tabs")
            for tab in tabs:
                try:
                    tab.apply_snapshot(state)
                    _dlog(f"app: {type(tab).__name__}.apply_snapshot OK")
                except Exception as e:
                    import traceback as _tb
                    _dlog(f"app: {type(tab).__name__}.apply_snapshot FAILED: {e}\n{_tb.format_exc()}")
                    continue
            self._refresh_status_bar()
        elif ftype == "delta":
            event = frame.get("event") or {}
            self._update_totals_from_event(event)
            for tab in self._all_tabs():
                try:
                    tab.apply_event(event)
                except Exception as e:
                    import traceback as _tb
                    _dlog(f"app: {type(tab).__name__}.apply_event FAILED for type={event.get('type')}: {e}")
                    continue
            # Status bar refresh is now driven by the set_interval tick.
            # On-event refresh removed: it was the main UI-latency culprit.
        elif ftype == "heartbeat":
            self._totals["status"] = "connected"

    def _all_tabs(self) -> list[Any]:
        out = []
        for sel in ("#tab-live", "#tab-agents", "#tab-workflows", "#tab-knowledge", "#tab-activity"):
            try:
                out.append(self.query_one(sel))
            except Exception:
                continue
        return out

    def _sync_totals_from_snapshot(self, state: dict[str, Any]) -> None:
        agents = 0
        workflows = 0
        tin = tout = cr = cw = 0
        cost = 0.0
        for sess in (state.get("sessions") or {}).values():
            agents += len(sess.get("agents_active") or {})
            workflows += len(sess.get("workflows_active") or {})
            tin += int(sess.get("tokens_in") or 0)
            tout += int(sess.get("tokens_out") or 0)
            cr += int(sess.get("cache_read") or 0)
            cw += int(sess.get("cache_write") or 0)
            cost += float(sess.get("cost_estimate_usd") or 0.0)
        self._totals.update({
            "agents_active": agents,
            "workflows_active": workflows,
            "tokens_in": tin,
            "tokens_out": tout,
            "cache_read": cr,
            "cache_write": cw,
            "cost_estimate_usd": cost,
        })

    def _update_totals_from_event(self, ev: dict[str, Any]) -> None:
        etype = ev.get("type")
        if etype == "token_usage":
            p = ev.get("payload") or {}
            self._totals["tokens_in"] += int(p.get("tokens_in") or 0)
            self._totals["tokens_out"] += int(p.get("tokens_out") or 0)
            self._totals["cache_read"] += int(p.get("cache_read") or 0)
            self._totals["cache_write"] += int(p.get("cache_write") or 0)
            self._totals["cost_estimate_usd"] += float(p.get("cost_estimate_usd") or 0.0)
        elif etype == "agent_spawn":
            self._totals["agents_active"] += 1
        elif etype == "agent_complete":
            self._totals["agents_active"] = max(0, self._totals["agents_active"] - 1)

    # ----- status bar --------------------------------------------------------

    def _refresh_status_bar(self) -> None:
        try:
            bar = self.query_one("#status-bar", Static)
        except Exception:
            return
        elapsed = int(time.time() - self._started_at)
        h, rem = divmod(elapsed, 3600)
        m, s = divmod(rem, 60)
        tin = self._totals["tokens_in"]
        tout = self._totals["tokens_out"]
        cache = self._totals["cache_read"]
        cost = self._totals["cost_estimate_usd"]
        agents = self._totals["agents_active"]
        wf = self._totals["workflows_active"]
        status = self._totals["status"]
        text = Text()
        text.append(" ⏵ ", style="#00D4AA")
        text.append(f"{h:02d}h{m:02d}m{s:02d}s", style="bold")
        text.append("  ·  ")
        text.append(f"{tin/1000:.1f}k", style="cyan")
        text.append(" in  ·  ")
        text.append(f"{tout/1000:.1f}k", style="cyan")
        text.append(" out  ·  ")
        text.append(f"{cache/1000:.1f}k", style="dim")
        text.append(" cached  ·  ")
        text.append(f"${cost:.2f}", style="#B794F4 bold")
        text.append("  ·  ")
        text.append(f"{agents}", style="bold")
        text.append(" agents  ·  ")
        text.append(f"{wf}", style="bold")
        text.append(" wf  ·  ")
        text.append(status, style="#68D391" if status == "connected" else "#F6AD55")
        bar.update(text)

    # ----- actions -----------------------------------------------------------

    def action_switch_tab(self, tab_id: str) -> None:
        try:
            tabs = self.query_one(TabbedContent)
            tabs.active = tab_id
        except Exception:
            pass

    def action_show_help(self) -> None:
        # Minimal help; expand into a modal in a follow-up.
        try:
            bar = self.query_one("#status-bar", Static)
            help_text = Text("1-5 tabs · / filter (Activity) · q quit",
                             style="bold")
            bar.update(help_text)
        except Exception:
            pass


def run(socket_path: Path | None = None) -> int:
    app = MishkanWatch(socket_path=socket_path)
    app.run()
    return 0
