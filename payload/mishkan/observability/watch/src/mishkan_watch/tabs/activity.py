"""Tab 5 — Activity. Unified event stream with filter.

Single-panel layout per §7.3: filter bar (1 line) + stream RichLog. Every
event from every stream lands here; the filter narrows by regex over the
rendered line. Error / permission events get rhythm-breaking separators
above (per §7.6 mockup E).
"""
from __future__ import annotations

import re
from typing import Any, Optional

from textual.app import ComposeResult
from textual.containers import Container, Horizontal
from textual.widgets import Input, RichLog, Static
from rich.text import Text

from .live import _fmt_event_line


class ActivityTab(Container):
    DEFAULT_CSS = ""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._filter: Optional[re.Pattern[str]] = None
        # Ring buffer of (raw_event, rendered_text) so we can re-filter
        # without losing data.
        self._buf: list[tuple[dict[str, Any], Text]] = []
        self._buf_cap = 1000

    def compose(self) -> ComposeResult:
        with Container(id="activity-filter"):
            with Horizontal():
                yield Static("filter:", classes="filter-label")
                yield Input(placeholder="regex (Enter to apply; empty = all)", id="filter-input")
        yield RichLog(id="activity-stream", highlight=False, markup=False, wrap=False)

    def apply_event(self, ev: dict[str, Any]) -> None:
        line = _fmt_event_line(ev)
        self._buf.append((ev, line))
        if len(self._buf) > self._buf_cap:
            self._buf.pop(0)
        if not self._matches(ev, line):
            return
        try:
            log = self.query_one("#activity-stream", RichLog)
            # Rhythm-breaking separator for error / blocked permission.
            etype = ev.get("type")
            if etype == "error" or (etype == "permission" and ev.get("outcome") == "blocked"):
                log.write(Text("━" * 80, style="#FC8181 dim"))
            log.write(line)
        except Exception:
            pass

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "filter-input":
            return
        pattern = (event.value or "").strip()
        if not pattern:
            self._filter = None
        else:
            try:
                self._filter = re.compile(pattern)
            except re.error:
                self._filter = None
        self._refresh()

    def _matches(self, ev: dict[str, Any], rendered: Text) -> bool:
        if self._filter is None:
            return True
        plain = rendered.plain
        return bool(self._filter.search(plain))

    def _refresh(self) -> None:
        """Re-render the stream from the ring buffer applying the current filter."""
        try:
            log = self.query_one("#activity-stream", RichLog)
            log.clear()
            for ev, line in self._buf:
                if not self._matches(ev, line):
                    continue
                etype = ev.get("type")
                if etype == "error" or (etype == "permission" and ev.get("outcome") == "blocked"):
                    log.write(Text("━" * 80, style="#FC8181 dim"))
                log.write(line)
        except Exception:
            pass

    def apply_snapshot(self, state: dict[str, Any]) -> None:
        """Backfill the stream from the snapshot's per-session recent_events."""
        sessions = (state or {}).get("sessions") or {}
        all_events: list[dict[str, Any]] = []
        for sess in sessions.values():
            for ev in (sess.get("recent_events") or []):
                all_events.append(ev)
        # Sort by ts and replay through apply_event so the buffer + filter work.
        all_events.sort(key=lambda e: e.get("ts") or "")
        for ev in all_events:
            self.apply_event(ev)
