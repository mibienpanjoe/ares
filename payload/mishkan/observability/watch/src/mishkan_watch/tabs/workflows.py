"""Tab 3 — Workflows. Stub for Phase 4.

Per §7.3, lands the live phase tree, parallel fan-out, schema validation
pass-rate, per-workflow token+$ spend. Depends on the workflow_* events
which require the daemon's workflow journal-tail source (Phase 4).
"""
from __future__ import annotations

from typing import Any

from textual.app import ComposeResult
from textual.containers import Container
from textual.widgets import Static


class WorkflowsTab(Container):
    def compose(self) -> ComposeResult:
        yield Static("Workflows — Phase 4 (phase tree · fan-out bars · schema pass-rate)",
                     classes="stub")

    def apply_snapshot(self, state: dict[str, Any]) -> None:
        return

    def apply_event(self, ev: dict[str, Any]) -> None:
        return
