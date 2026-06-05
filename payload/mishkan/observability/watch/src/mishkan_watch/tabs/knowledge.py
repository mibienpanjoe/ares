"""Tab 4 — Knowledge.

3-row stacked layout per §7.3:
  - COGNEE STORES (top, 2 Static cards side-by-side)
  - RECENT OPS (middle, DataTable — cognee_op + graphify_query mixed)
  - MCP SERVERS (bottom, DataTable — all MCPs)
"""
from __future__ import annotations

from collections import deque
from typing import Any

from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Container, Horizontal
from textual.widgets import DataTable, Static


class KnowledgeTab(Container):
    DEFAULT_CSS = ""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._state: dict[str, Any] = {"mcp_servers": {}, "cognee": {}}
        self._recent_ops: deque[dict[str, Any]] = deque(maxlen=30)

    def compose(self) -> ComposeResult:
        with Horizontal(id="knowledge-stores"):
            yield Static("", id="knowledge-work", classes="cognee-card")
            yield Static("", id="knowledge-curated", classes="cognee-card")
        with Container(id="knowledge-ops"):
            yield Static("RECENT OPS", classes="panel-title")
            yield DataTable(id="knowledge-ops-table", cursor_type="row",
                            zebra_stripes=False)
        with Container(id="knowledge-mcp"):
            yield Static("MCP SERVERS", classes="panel-title")
            yield DataTable(id="knowledge-mcp-table", cursor_type="row",
                            zebra_stripes=False)

    def on_mount(self) -> None:
        try:
            ops = self.query_one("#knowledge-ops-table", DataTable)
            ops.add_columns("time", "store", "op", "query/path", "ms")
            mcp = self.query_one("#knowledge-mcp-table", DataTable)
            mcp.add_columns("server", "status", "since", "last event")
        except Exception:
            pass
        self._render_all()

    # ----- snapshot / event application --------------------------------------

    def apply_snapshot(self, state: dict[str, Any]) -> None:
        self._state = state
        # Backfill recent_ops from per-session recent_events
        self._recent_ops.clear()
        for sess in (state.get("sessions") or {}).values():
            for ev in (sess.get("recent_events") or []):
                if ev.get("type") in ("cognee_op", "graphify_query", "graphify_scan"):
                    self._recent_ops.append(ev)
        self._render_all()

    def apply_event(self, ev: dict[str, Any]) -> None:
        etype = ev.get("type")
        if etype in ("cognee_op", "graphify_query", "graphify_scan"):
            self._recent_ops.append(ev)
            self._render_ops()
        if etype == "mcp_server":
            self._mutate_mcp(ev)
            self._render_mcp()
            self._render_cards()

    def _mutate_mcp(self, ev: dict[str, Any]) -> None:
        try:
            p = ev.get("payload") or {}
            name = p.get("server") or ev.get("tool")
            if not name:
                return
            mcps = self._state.setdefault("mcp_servers", {})
            existing = mcps.get(name) or {"name": name, "url": p.get("url") or ""}
            new_status = p.get("status") or existing.get("status", "?")
            if new_status != existing.get("status"):
                existing["since"] = ev.get("ts")
            existing["status"] = new_status
            existing["last_event"] = ev.get("ts")
            mcps[name] = existing
        except Exception:
            return

    # ----- renderers ---------------------------------------------------------

    def _render_all(self) -> None:
        self._render_cards()
        self._render_ops()
        self._render_mcp()

    def _render_cards(self) -> None:
        try:
            work_panel = self.query_one("#knowledge-work", Static)
            cur_panel = self.query_one("#knowledge-curated", Static)
        except Exception:
            return
        mcps = self._state.get("mcp_servers") or {}
        cognee_state = self._state.get("cognee") or {}
        # Try cognee_state first (set by cognee_op events), else fall back to MCP status
        work_entry = cognee_state.get("work") or self._mcp_match(mcps, "cognee", ("work", "7777"))
        cur_entry = cognee_state.get("curated") or self._mcp_match(mcps, "cognee", ("curated", "7730"))
        work_panel.update(self._card_for("work :7777", work_entry))
        cur_panel.update(self._card_for("curated :7730", cur_entry))

    def _mcp_match(self, mcps: dict[str, Any], must_have: str,
                   prefer_tokens: tuple[str, ...]) -> dict[str, Any] | None:
        """Find an MCP entry whose name contains must_have AND prefers any of prefer_tokens."""
        candidates = [m for n, m in mcps.items() if must_have in n.lower()]
        if not candidates:
            return None
        for token in prefer_tokens:
            for c in candidates:
                blob = (c.get("name", "") + " " + (c.get("url") or "")).lower()
                if token in blob:
                    return c
        return candidates[0]

    def _card_for(self, title: str, entry: dict[str, Any] | None) -> Text:
        text = Text()
        if entry is None:
            text.append(f"{title}\n", style="bold dim")
            text.append("? not configured / not detected\n", style="dim italic")
            return text
        status = entry.get("status") or "?"
        nodes = entry.get("nodes")
        last = entry.get("last_ingest") or entry.get("last_event") or "-"
        if isinstance(last, str) and len(last) > 19:
            last = last[11:19]
        dot = "●" if status == "up" else ("✗" if status == "down" else "⟳")
        color = {"up": "#00D4AA", "down": "#FC8181"}.get(status, "#F6AD55")
        text.append(f"{dot} ", style=color)
        text.append(title, style="bold")
        text.append(f"  ({status})\n", style="dim")
        text.append("\n")
        if nodes is not None:
            text.append(f"{nodes:>6}", style="bold")
            text.append(" nodes\n", style="dim")
        text.append(f"last activity: {last}\n", style="dim")
        return text

    def _render_ops(self) -> None:
        try:
            table = self.query_one("#knowledge-ops-table", DataTable)
        except Exception:
            return
        table.clear()
        for ev in list(self._recent_ops)[-20:]:
            ts = (ev.get("ts") or "")[11:19]
            p = ev.get("payload") or {}
            store = p.get("store") or ("graphify" if ev.get("type", "").startswith("graphify") else "?")
            op = p.get("op") or ev.get("type", "").replace("graphify_", "g:")
            query = (p.get("query") or p.get("path") or "")[:40]
            dur = ev.get("duration_ms") or p.get("duration_ms") or 0
            style = "#F687B3" if "cognee" in (ev.get("type") or "") else "#B794F4"
            table.add_row(
                Text(ts, style="dim"),
                Text(str(store)[:10], style=style),
                Text(str(op)[:10]),
                Text(query),
                Text(f"{dur}ms" if dur else "-", style="dim"),
            )

    def _render_mcp(self) -> None:
        try:
            table = self.query_one("#knowledge-mcp-table", DataTable)
        except Exception:
            return
        table.clear()
        mcps = self._state.get("mcp_servers") or {}
        if not mcps:
            return
        for name, m in mcps.items():
            status = m.get("status") or "?"
            since = (m.get("since") or "")[11:19] if m.get("since") else "-"
            last_event = (m.get("last_event") or "")[11:19] if m.get("last_event") else "-"
            color = {"up": "#00D4AA", "down": "#FC8181", "stale": "#F6AD55"}.get(status, "dim")
            dot = {"up": "●", "down": "✗", "stale": "⟳"}.get(status, "○")
            table.add_row(
                Text(f"{dot} {name}", style=color),
                Text(status, style=color),
                Text(since, style="dim"),
                Text(last_event, style="dim"),
            )
