"""Tab 3 — Workflows.

2-panel layout per §7.3:
  - WORKFLOW LIST (left, 30%)  — cards of recent workflow runs
  - PHASE TREE (right, 70%)    — phases + agent fan-out of the selected run

Tracks workflow_start / workflow_phase / workflow_agent_call /
workflow_agent_result / workflow_complete events emitted by the
daemon's workflow_tail source (Phase 4) or the Workflow tool emitter
in post-tool-observe.sh.
"""
from __future__ import annotations

from collections import OrderedDict
from typing import Any, Optional

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Container, Horizontal
from textual.widgets import ListItem, ListView, Static, Tree
from textual.widgets.tree import TreeNode


class WorkflowsTab(Container):
    DEFAULT_CSS = ""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        # run_id -> { name, started, phases: {phase: [agent_call dicts]}, ... }
        self._runs: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._selected: Optional[str] = None

    def compose(self) -> ComposeResult:
        with Horizontal(id="workflows-row"):
            with Container(id="workflows-list"):
                yield Static("WORKFLOWS", classes="panel-title")
                yield ListView(id="workflows-listview")
            with Container(id="workflows-detail"):
                yield Static("PHASE TREE", classes="panel-title")
                yield Tree("(no workflow selected)", id="workflows-tree")

    def on_mount(self) -> None:
        self._render_list()
        self._render_tree()

    # ----- snapshot / event application --------------------------------------

    def apply_snapshot(self, state: dict[str, Any]) -> None:
        # Walk recent_events of all sessions for workflow events
        for sess in (state.get("sessions") or {}).values():
            for ev in (sess.get("recent_events") or []):
                self._ingest_event(ev)
        self._render_list()
        self._render_tree()

    def apply_event(self, ev: dict[str, Any]) -> None:
        if not self._is_workflow_event(ev):
            return
        self._ingest_event(ev)
        self._render_list()
        if self._selected:
            self._render_tree()

    def _is_workflow_event(self, ev: dict[str, Any]) -> bool:
        return (ev.get("type") or "").startswith("workflow_")

    def _ingest_event(self, ev: dict[str, Any]) -> None:
        etype = ev.get("type")
        p = ev.get("payload") or {}
        run_id = p.get("workflow_id") or p.get("run_id") or p.get("workflow") \
            or ev.get("subagent_id") or "(unknown)"
        run = self._runs.get(run_id)
        if run is None:
            run = {
                "run_id": run_id,
                "name": p.get("name") or p.get("workflow") or run_id,
                "started": ev.get("ts"),
                "status": "running",
                "phases": OrderedDict(),  # phase_name -> [agent_call dicts]
                "cost_usd": 0.0,
                "tokens": 0,
            }
            self._runs[run_id] = run
        if etype == "workflow_start":
            run["name"] = p.get("name") or p.get("workflow") or run["name"]
            run["started"] = ev.get("ts") or run["started"]
            run["status"] = "running"
        elif etype == "workflow_phase":
            phase = p.get("phase") or p.get("title") or "?"
            run["phases"].setdefault(phase, [])
            run["current_phase"] = phase
        elif etype == "workflow_agent_call":
            phase = p.get("phase") or run.get("current_phase") or "?"
            run["phases"].setdefault(phase, []).append({
                "label": p.get("label") or p.get("agent") or "agent",
                "model": p.get("model") or "?",
                "status": "running",
                "ts": ev.get("ts"),
            })
        elif etype == "workflow_agent_result":
            phase = p.get("phase") or run.get("current_phase") or "?"
            # find latest matching agent in phase to mark complete
            label = p.get("label") or p.get("agent")
            for ac in reversed(run["phases"].get(phase, [])):
                if not label or ac.get("label") == label:
                    if ac.get("status") == "running":
                        ac["status"] = "ok" if p.get("success", True) else "err"
                        ac["duration_ms"] = p.get("duration_ms")
                        ac["tokens_in"] = p.get("tokens_in")
                        ac["tokens_out"] = p.get("tokens_out")
                        break
        elif etype == "workflow_complete":
            run["status"] = "done"
            run["cost_usd"] = p.get("total_cost_usd") or run["cost_usd"]
            run["tokens"] = p.get("total_tokens") or run["tokens"]

    # ----- renderers ---------------------------------------------------------

    def _render_list(self) -> None:
        try:
            lv = self.query_one("#workflows-listview", ListView)
        except Exception:
            return
        lv.clear()
        if not self._runs:
            lv.append(ListItem(Static(Text("(none yet)\nrun a workflow to populate",
                                          style="dim italic"))))
            return
        for run_id, run in list(self._runs.items())[-10:]:
            t = Text()
            mark = "║ " if self._selected == run_id else "  "
            t.append(mark, style="#B794F4 bold")
            t.append(run["name"][:24], style="bold")
            t.append(f"  [{run['status']}]", style="dim")
            phases_done = sum(1 for items in run["phases"].values()
                              if items and all(a.get("status") != "running" for a in items))
            phases_total = max(1, len(run["phases"]) or 1)
            t.append(f"\n  {phases_done}/{phases_total} phases", style="dim")
            cost = run.get("cost_usd") or 0.0
            tok = run.get("tokens") or 0
            t.append(f"   ${cost:.2f} · {tok/1000:.1f}k tok", style="#B794F4")
            lv.append(ListItem(Static(t), id=f"wf-{run_id}"))

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        node_id = event.item.id or ""
        if node_id.startswith("wf-"):
            self._selected = node_id[3:]
            self._render_tree()

    def _render_tree(self) -> None:
        try:
            tree = self.query_one("#workflows-tree", Tree)
        except Exception:
            return
        tree.clear()
        root = tree.root
        if not self._selected or self._selected not in self._runs:
            root.label = Text("(no workflow selected)", style="dim italic")
            return
        run = self._runs[self._selected]
        rl = Text()
        rl.append(run["name"], style="bold #B794F4")
        rl.append(f"  [{run['status']}]", style="dim")
        root.label = rl
        root.expand()
        for phase, items in run["phases"].items():
            running = sum(1 for a in items if a.get("status") == "running")
            done = sum(1 for a in items if a.get("status") == "ok")
            err = sum(1 for a in items if a.get("status") == "err")
            pl = Text()
            mark = "▾" if running or err else ("✓" if items and not running else "○")
            color = "#00D4AA" if running else ("#68D391" if items and not running else "dim")
            pl.append(f"{mark} ", style=color)
            pl.append(phase, style="bold")
            pl.append(f"   {done}✓ {running}● {err}✗", style="dim")
            phase_node = root.add(pl)
            phase_node.expand()
            for ac in items:
                al = Text()
                s = ac.get("status", "running")
                dot = {"running": "●", "ok": "✓", "err": "✗"}.get(s, "○")
                col = {"running": "#00D4AA", "ok": "#68D391", "err": "#FC8181"}.get(s, "dim")
                al.append(f"{dot} ", style=col)
                al.append(ac.get("label", "?"), style="bold" if s == "running" else "white")
                al.append(f"  {ac.get('model','?')}", style="dim")
                dur = ac.get("duration_ms") or 0
                if dur:
                    al.append(f"  {dur}ms", style="dim")
                phase_node.add_leaf(al)
