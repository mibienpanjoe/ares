"""Tab 2 — Agents. Stub for Phase 4.

Per §7.3 spec, this tab needs: SESSIONS tree (left) + AGENT HISTORY
DataTable (center) + ERRORS panel (right). Lands in Phase 4 alongside
the daemon's workflow + per-agent history aggregation work.
"""
from __future__ import annotations

from typing import Any

from textual.app import ComposeResult
from textual.containers import Container
from textual.widgets import Static


class AgentsTab(Container):
    def compose(self) -> ComposeResult:
        yield Static("Agents — Phase 4 (sessions tree · per-agent history · errors panel)",
                     classes="stub")

    def apply_snapshot(self, state: dict[str, Any]) -> None:
        return

    def apply_event(self, ev: dict[str, Any]) -> None:
        return
