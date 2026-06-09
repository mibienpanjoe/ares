"""Tab 3 — Workflows.

2-panel layout per §7.3:
  - WORKFLOW LIST (left, 30%)  — static catalogue + recent runs
  - PHASE TREE (right, 70%)    — phases + agent fan-out OR catalog detail

The list panel shows BOTH:
  - Live runs (top) — recent workflow invocations with status
  - Available catalogue (below) — workflows installed on the system,
    with name, description, whenToUse — clickable to read full meta.

Tracks workflow_start / workflow_phase / workflow_agent_call /
workflow_agent_result / workflow_complete events emitted by the
daemon's workflow_tail source (Phase 4) or the Workflow tool emitter
in post-tool-observe.sh.
"""
from __future__ import annotations

import os
import re
from collections import OrderedDict
from pathlib import Path
from typing import Any, Optional

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Container, Horizontal
from textual.widgets import ListItem, ListView, Static, Tree
from textual.widgets.tree import TreeNode


# Locations to scan for installed workflow scripts. First hit wins per name.
_WORKFLOW_PATHS = [
    Path.home() / ".claude" / "mishkan" / "workflows",
]


def _scan_catalogue() -> list[dict[str, Any]]:
    """Parse meta blocks from every .js workflow on disk.

    Extracts: name, description, whenToUse, phases (titles only). The meta
    block is required by the workflow contract (`export const meta = {...}`)
    so a missing one is a malformed workflow — silently skipped.

    Repo-mode fallback: walk up from this file looking for
    payload/mishkan/workflows/ in case mishkan-watch runs from a source
    checkout without the runtime payload installed.
    """
    paths = list(_WORKFLOW_PATHS)
    here = Path(__file__).resolve()
    for parent in here.parents:
        c = parent / "payload" / "mishkan" / "workflows"
        if c.is_dir():
            paths.append(c)
            break
        if parent == parent.parent:
            break
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for d in paths:
        if not d.is_dir():
            continue
        for js in sorted(d.glob("*.js")):
            try:
                txt = js.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            meta = _extract_meta(txt)
            if not meta or not meta.get("name"):
                continue
            if meta["name"] in seen:
                continue
            seen.add(meta["name"])
            meta["_path"] = str(js)
            out.append(meta)
    return out


# Accept both " and ' quoting — JS allows both in literal strings.
_META_KEY_RE = re.compile(
    r'(name|description|whenToUse|title|detail)\s*:\s*'
    r'(?:"((?:[^"\\]|\\.)*)"|\'((?:[^\'\\]|\\.)*)\')'
)


def _extract_meta(txt: str) -> dict[str, Any]:
    """Best-effort extract of the `export const meta = {...}` literal.

    The contract guarantees meta is a pure literal — no computed values —
    so a key/value regex over the meta block is enough. We don't run a
    full JS parser; we just lift the four fields we render.
    """
    m = re.search(r'export\s+const\s+meta\s*=\s*\{', txt)
    if not m:
        return {}
    # Naive brace match — meta blocks don't contain strings with unmatched
    # braces in practice; if they do we just truncate, which is fine for
    # display purposes.
    start = m.end()
    depth = 1
    i = start
    while i < len(txt) and depth > 0:
        c = txt[i]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
        i += 1
    block = txt[start:i]
    out: dict[str, Any] = {}
    for key, dq, sq in _META_KEY_RE.findall(block):
        val = dq or sq
        # JS escape unescape for the common cases.
        val = val.replace('\\"', '"').replace("\\'", "'").replace("\\n", " ").replace("\\\\", "\\")
        out.setdefault(key, val)
    # Phase titles (best-effort): every `title: "..."` or `title: '...'`.
    titles = re.findall(r'\{\s*title:\s*[\'"]([^\'"]+)[\'"]', block)
    if titles:
        out["phase_titles"] = titles
    return out


class WorkflowsTab(Container):
    DEFAULT_CSS = ""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        # run_id -> { name, started, phases: {phase: [agent_call dicts]}, ... }
        self._runs: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._selected: Optional[str] = None
        # Static catalogue parsed from disk at mount.
        self._catalogue: list[dict[str, Any]] = []
        # Currently-shown catalogue entry (selected name) for the detail panel.
        self._cat_selected: Optional[str] = None

    def compose(self) -> ComposeResult:
        with Horizontal(id="workflows-row"):
            with Container(id="workflows-list"):
                yield Static("WORKFLOWS", classes="panel-title")
                yield ListView(id="workflows-listview")
            with Container(id="workflows-detail"):
                yield Static("PHASE TREE", classes="panel-title")
                yield Tree("(no workflow selected)", id="workflows-tree")

    async def on_mount(self) -> None:
        try:
            self._catalogue = _scan_catalogue()
        except Exception:
            self._catalogue = []
        await self._render_list()
        self._render_tree()
        # Re-render once after mount completes — when the tab is created
        # before TabbedContent settles its layout, the first ListView paint
        # can land before ListItem rows have a size computed and the items
        # show as zero-height (visible as "header only, no rows"). A delayed
        # repaint guarantees the second pass runs with the final container
        # dimensions.
        self.set_timer(0.1, self._re_render_list)

    # ----- snapshot / event application --------------------------------------

    def apply_snapshot(self, state: dict[str, Any]) -> None:
        # Walk recent_events of all sessions for workflow events
        for sess in (state.get("sessions") or {}).values():
            for ev in (sess.get("recent_events") or []):
                self._ingest_event(ev)
        self._render_tree()
        self.call_later(self._re_render_list)

    def apply_event(self, ev: dict[str, Any]) -> None:
        if not self._is_workflow_event(ev):
            return
        self._ingest_event(ev)
        if self._selected:
            self._render_tree()
        self.call_later(self._re_render_list)

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

    async def _re_render_list(self) -> None:
        await self._render_list()

    async def _render_list(self) -> None:
        try:
            lv = self.query_one("#workflows-listview", ListView)
        except Exception:
            return
        await lv.clear()
        # Stable, index-based widget IDs. A run_id or workflow name can contain
        # characters Textual rejects in an id (the "(unknown)" placeholder has
        # parentheses; real names may have dots/spaces). Key list items by
        # render position and map the position back to the real id/name on
        # selection — never feed arbitrary data into a widget id.
        self._wf_ids: list[str] = []
        self._cat_ids: list[str] = []
        # ----- Recent runs (top) ---------------------------------------------
        if self._runs:
            head = Text()
            head.append("RECENT RUNS\n", style="bold #B794F4")
            lv.append(ListItem(Static(head)))
            for i, (run_id, run) in enumerate(list(self._runs.items())[-8:]):
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
                self._wf_ids.append(run_id)
                lv.append(ListItem(Static(t), id=f"wf-{i}"))
        # ----- Catalogue (bottom) --------------------------------------------
        if self._catalogue:
            head = Text()
            head.append("AVAILABLE", style="bold #00D4AA")
            head.append(f"  ({len(self._catalogue)} workflows)", style="dim italic")
            lv.append(ListItem(Static(head)))
            for i, entry in enumerate(self._catalogue):
                name = entry.get("name", "?")
                desc = entry.get("description") or ""
                mark = "║ " if self._cat_selected == name else "  "
                t = Text()
                t.append(mark, style="#00D4AA bold")
                t.append(name[:30], style="bold")
                if desc:
                    t.append(f"\n  {desc[:60]}", style="dim")
                self._cat_ids.append(name)
                lv.append(ListItem(Static(t), id=f"cat-{i}"))
        elif not self._runs:
            lv.append(ListItem(Static(Text(
                "(no workflows installed and no runs yet)\n"
                "Install via `npx mishkan-harness install`,\n"
                "or run a workflow from the main session.",
                style="dim italic",
            ))))

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        node_id = event.item.id or ""
        if node_id.startswith("wf-"):
            try:
                idx = int(node_id[3:])
            except ValueError:
                return
            wf_ids = getattr(self, "_wf_ids", [])
            self._selected = wf_ids[idx] if 0 <= idx < len(wf_ids) else None
            self._cat_selected = None
            self._render_tree()
        elif node_id.startswith("cat-"):
            try:
                idx = int(node_id[4:])
            except ValueError:
                return
            cat_ids = getattr(self, "_cat_ids", [])
            self._cat_selected = cat_ids[idx] if 0 <= idx < len(cat_ids) else None
            self._selected = None
            self._render_tree()

    def _render_tree(self) -> None:
        try:
            tree = self.query_one("#workflows-tree", Tree)
        except Exception:
            return
        tree.clear()
        root = tree.root
        # Catalogue detail mode — shows description, whenToUse, phases.
        if self._cat_selected:
            entry = next((e for e in self._catalogue if e.get("name") == self._cat_selected), None)
            if entry:
                rl = Text()
                rl.append(entry.get("name", ""), style="bold #00D4AA")
                rl.append("  (catalogue)", style="dim")
                root.label = rl
                root.expand()
                desc = entry.get("description") or "(no description)"
                root.add_leaf(Text(f"description: {desc}", style="white"))
                wtu = entry.get("whenToUse")
                if wtu:
                    root.add_leaf(Text(f"when to use: {wtu}", style="#F6AD55"))
                phases = entry.get("phase_titles") or []
                if phases:
                    pn = root.add(Text(f"phases ({len(phases)})", style="bold dim"))
                    pn.expand()
                    for i, ph in enumerate(phases, 1):
                        pn.add_leaf(Text(f"  {i}. {ph}", style="white"))
                path = entry.get("_path") or ""
                if path:
                    root.add_leaf(Text(f"source: {path}", style="dim italic"))
            else:
                root.label = Text("(workflow not in catalogue)", style="dim italic")
            return
        if not self._selected or self._selected not in self._runs:
            root.label = Text("(select a workflow run or a catalogue entry)", style="dim italic")
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
