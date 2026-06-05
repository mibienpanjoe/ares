"""Tab 4 — Knowledge. Stub for Phase 4.

Per §7.3, lands Cognee store cards (node counts + sparklines) + recent
ops DataTable + MCP servers status table. Cognee node-count polling is
a Phase 4 daemon source; mock data lives in the Live tab's knowledge
panel until that source ships.
"""
from __future__ import annotations

from typing import Any

from textual.app import ComposeResult
from textual.containers import Container
from textual.widgets import Static


class KnowledgeTab(Container):
    def compose(self) -> ComposeResult:
        yield Static("Knowledge — Phase 4 (Cognee cards · recent ops · MCP servers)",
                     classes="stub")

    def apply_snapshot(self, state: dict[str, Any]) -> None:
        return

    def apply_event(self, ev: dict[str, Any]) -> None:
        return
