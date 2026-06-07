"""Tab 8 — Skills.

3-column browser of every installed skill on the user's Claude Code
instance, with cross-reference to the CTO decisions (ADRs) where each
skill is mentioned.

Layout:
  - LEFT (28%)  : tree grouped by origin (MISHKAN / user / plugin)
                  then by category. Selecting a leaf loads detail.
  - CENTER (44%): selected skill's full metadata — origin, source path,
                  category, description, triggers ("Use when..." lines).
  - RIGHT (28%) : ADRs that mention this skill, with section bodies
                  truncated for at-a-glance reading.

Data via skills_data.load_skills() (prefers the indexer output if
Bezalel's index.json exists; otherwise scans paths directly).
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Container, Horizontal
from textual.widgets import Static, Tree

from ..skills_data import load_skills


class SkillsTab(Container):
    DEFAULT_CSS = ""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._skills: list[dict[str, Any]] = []
        self._selected_name: str | None = None

    def compose(self) -> ComposeResult:
        with Horizontal(id="skills-row"):
            yield Tree("Skills", id="skills-tree")
            with Container(id="skills-detail"):
                yield Static("", id="skills-detail-body")
            with Container(id="skills-adrs"):
                yield Static("", id="skills-adrs-body")

    def on_mount(self) -> None:
        try:
            self._skills = load_skills()
        except Exception:
            self._skills = []
        self._rebuild_tree()
        self._render_detail()
        self._render_adrs()

    def _rebuild_tree(self) -> None:
        try:
            tree = self.query_one("#skills-tree", Tree)
        except Exception:
            return
        tree.clear()
        root = tree.root
        root.expand()
        # Group origin → category → entries.
        groups: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(
            lambda: defaultdict(list))
        for s in self._skills:
            groups[s.get("origin") or "?"][s.get("category") or "?"].append(s)
        origin_labels = {
            "mishkan": "MISHKAN craft",
            "user":    "Community",
            "plugin":  "Plugins",
            "project": "Project-local",
            "builtin": "Built-in",
        }
        # Render in fixed order so MISHKAN is always first.
        for origin in ("mishkan", "user", "plugin", "project", "builtin"):
            if origin not in groups:
                continue
            cats = groups[origin]
            total = sum(len(v) for v in cats.values())
            label = Text()
            label.append(origin_labels.get(origin, origin), style="bold")
            label.append(f"  ({total})", style="dim")
            on = root.add(label, data={"kind": "origin"})
            on.expand()
            for cat in sorted(cats.keys()):
                entries = cats[cat]
                cl = Text()
                cl.append(cat, style="bold #00D4AA")
                cl.append(f"  ({len(entries)})", style="dim")
                cn = on.add(cl, data={"kind": "category"})
                for entry in sorted(entries, key=lambda e: e.get("name") or ""):
                    sl = Text()
                    sl.append("● ", style="#B794F4")
                    sl.append(entry.get("name") or "?", style="white")
                    if entry.get("adrs"):
                        sl.append(f"  · {','.join(entry['adrs'])}", style="#F6AD55 italic")
                    cn.add_leaf(sl, data={"kind": "skill", "name": entry.get("name")})

    def on_tree_node_selected(self, event: Tree.NodeSelected) -> None:
        data = event.node.data or {}
        if data.get("kind") == "skill":
            self._selected_name = data.get("name")
            self._render_detail()
            self._render_adrs()

    def _render_detail(self) -> None:
        try:
            panel = self.query_one("#skills-detail-body", Static)
        except Exception:
            return
        if not self._selected_name:
            panel.update(Text("(select a skill on the left)\n\n"
                              f"{len(self._skills)} skills installed",
                              style="dim italic"))
            return
        entry = next((s for s in self._skills if s.get("name") == self._selected_name), None)
        if not entry:
            panel.update(Text("(skill no longer in index)", style="dim italic"))
            return
        t = Text()
        t.append(entry["name"], style="bold #B794F4")
        t.append("\n\n")
        t.append("origin   ", style="dim")
        t.append(entry.get("origin") or "?", style="cyan")
        t.append("\n")
        t.append("category ", style="dim")
        t.append(entry.get("category") or "?", style="cyan")
        t.append("\n")
        t.append("source   ", style="dim")
        t.append(str(entry.get("source_path") or "?")[-60:], style="dim italic")
        t.append("\n\n")
        desc = entry.get("description") or "(no description)"
        t.append("description\n", style="bold dim")
        t.append(desc + "\n", style="white")
        triggers = entry.get("triggers") or []
        if triggers:
            t.append("\nuse when\n", style="bold dim")
            for tr in triggers[:4]:
                t.append(f"  · {tr[:80]}\n", style="white")
        # Frontmatter dump for the curious.
        fm = entry.get("frontmatter") or {}
        if fm:
            t.append("\nfrontmatter\n", style="bold dim")
            for k, v in list(fm.items())[:6]:
                if k in ("name", "description"):
                    continue
                t.append(f"  {k}: ", style="dim")
                t.append(str(v)[:60] + "\n", style="white")
        panel.update(t)

    def _render_adrs(self) -> None:
        try:
            panel = self.query_one("#skills-adrs-body", Static)
        except Exception:
            return
        t = Text()
        t.append("CTO decisions\n", style="bold #B794F4")
        if not self._selected_name:
            t.append("\n(select a skill to see linked ADRs)", style="dim italic")
            panel.update(t)
            return
        entry = next((s for s in self._skills if s.get("name") == self._selected_name), None)
        adrs = (entry or {}).get("adrs") or []
        if not adrs:
            t.append("\n(no ADR mentions this skill)\n", style="dim italic")
            t.append("\nADRs live in docs/design/MISHKAN_decisions.md", style="dim")
            panel.update(t)
            return
        t.append(f"\n{len(adrs)} ADR mention(s):\n\n", style="dim")
        for adr_id in adrs:
            t.append(f"  ● {adr_id}\n", style="#F6AD55 bold")
        t.append("\nFull text:\n", style="bold dim")
        t.append("  docs/design/MISHKAN_decisions.md\n", style="dim italic")
        panel.update(t)

    # ----- API expected by app.py -------------------------------------------

    def apply_snapshot(self, state: dict[str, Any]) -> None:
        return  # static data, no daemon dependency

    def apply_event(self, ev: dict[str, Any]) -> None:
        return

    def set_project_filter(self, project: Any) -> None:
        return
