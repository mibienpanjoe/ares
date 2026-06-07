"""Org tab — MISHKAN organisation reference.

Read-only browser of the 45-agent org chart. Tree on the left
(groups → agents), details panel on the right (role + description +
source). Static data: loaded from org.json via org_data.load_org(),
never depends on the bus.

Purpose: small recalls until the org is memorised.
"""
from __future__ import annotations

from typing import Any

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Container, Horizontal
from textual.widgets import Static, Tree

from ..org_data import load_org as _load_org


class OrgTab(Container):
    """Org reference tab."""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._org = _load_org()
        self._selected: tuple[str, str] | None = None  # (group_id, alias)

    def compose(self) -> ComposeResult:
        with Horizontal(id="org-row"):
            yield Tree("MISHKAN", id="org-tree")
            with Container(id="org-detail"):
                yield Static("(select an agent)", id="org-detail-body")

    def on_mount(self) -> None:
        self._build_tree()

    def _build_tree(self) -> None:
        try:
            tree = self.query_one("#org-tree", Tree)
        except Exception:
            return
        tree.root.expand()
        for grp in self._org.get("groups", []):
            label = Text()
            label.append(grp["label"], style="bold")
            domain = grp.get("domain")
            if domain:
                label.append(f"  · {domain}", style="#00D4AA")
            label.append(f"  ({len(grp.get('agents', []))})", style="dim")
            node = tree.root.add(label, data={"kind": "group", "id": grp["id"]})
            node.expand()
            for ag in grp.get("agents", []):
                al = Text()
                al.append("● ", style="#00D4AA")
                al.append(ag["alias"].capitalize(), style="bold")
                al.append(f"  · {ag['role']}", style="dim")
                node.add_leaf(al, data={"kind": "agent", "group": grp["id"], "alias": ag["alias"]})

    def on_tree_node_selected(self, event: Tree.NodeSelected) -> None:
        data = event.node.data or {}
        kind = data.get("kind")
        if kind == "agent":
            self._render_agent_detail(data["group"], data["alias"])
        elif kind == "group":
            self._render_group_detail(data["id"])

    def _render_group_detail(self, gid: str) -> None:
        try:
            panel = self.query_one("#org-detail-body", Static)
        except Exception:
            return
        grp = next((g for g in self._org.get("groups", []) if g["id"] == gid), None)
        if not grp:
            return
        t = Text()
        t.append(grp["label"], style="bold #B794F4")
        if grp.get("domain"):
            t.append(f"  ·  {grp['domain']}", style="bold #00D4AA")
        t.append("\n")
        if grp.get("hebrew"):
            t.append(grp["hebrew"], style="cyan")
            if grp.get("hebrew_meaning"):
                t.append(f"  —  {grp['hebrew_meaning']}", style="dim italic")
            t.append("\n")
        t.append("\n")
        if grp.get("mission"):
            t.append("mission\n", style="dim")
            t.append(grp["mission"], style="white")
            t.append("\n\n")
        if grp.get("charter"):
            t.append("charter\n", style="dim")
            t.append(grp["charter"], style="white")
            t.append("\n\n")
        if grp.get("relationships"):
            t.append("relationships\n", style="dim")
            t.append(grp["relationships"], style="white")
            t.append("\n\n")
        t.append(f"{len(grp.get('agents', []))} agents — select one for role detail.", style="dim italic")
        panel.update(t)

    def _render_agent_detail(self, gid: str, alias: str) -> None:
        try:
            panel = self.query_one("#org-detail-body", Static)
        except Exception:
            return
        grp = next((g for g in self._org.get("groups", []) if g["id"] == gid), None)
        if not grp:
            return
        ag = next((a for a in grp.get("agents", []) if a["alias"] == alias), None)
        if not ag:
            return
        t = Text()
        t.append(ag["alias"].capitalize(), style="bold #B794F4")
        t.append(f"  ·  {grp['label']}", style="bold")
        if grp.get("domain"):
            t.append(f"  ·  {grp['domain']}", style="#00D4AA")
        t.append("\n\n")
        t.append("role  ", style="dim")
        t.append(ag["role"], style="cyan")
        t.append("\n")
        if ag.get("short"):
            t.append("short  ", style="dim")
            t.append(ag["short"], style="white")
            t.append("\n")
        t.append("source  ", style="dim")
        t.append(ag.get("source", "—"), style="dim italic")
        t.append("\n\n")
        t.append(ag.get("description", ""), style="white")
        panel.update(t)

    # ----- API expected by app.py (no-op since static data) -----------------

    def apply_snapshot(self, state: dict[str, Any]) -> None:
        return

    def apply_event(self, ev: dict[str, Any]) -> None:
        return
