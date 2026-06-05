"""Cognee polling source — HTTP probe of cognee work + curated endpoints.

Emits cognee_op events with up/down status. Node-count requires a
cypher query against neo4j which is deferred — we report nodes=null
and let the engineer drill in via the Cognee Graph Explorer UI.

Defaults to the conventional MISHKAN cognee endpoints (work :7777,
curated :7730) but reads .mcp.json files to pick up overrides.
"""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    import httpx  # type: ignore
except Exception:  # pragma: no cover
    httpx = None  # graceful degradation


DEFAULT_ENDPOINTS = {
    "work": "http://localhost:7777/mcp",
    "curated": "http://localhost:7730/mcp",
}


def _iso(ts: float | None = None) -> str:
    t = datetime.fromtimestamp(ts or time.time(), tz=timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def _resolve_endpoints(projects_dir: Path) -> dict[str, str]:
    """Override defaults with any cognee-named MCP entries found in .mcp.json files."""
    found = dict(DEFAULT_ENDPOINTS)
    try:
        for mcp_json in projects_dir.glob("*/.mcp.json"):
            try:
                data = json.loads(mcp_json.read_text())
            except Exception:
                continue
            servers = data.get("mcpServers") or data.get("servers") or {}
            if not isinstance(servers, dict):
                continue
            for name, cfg in servers.items():
                if not isinstance(cfg, dict):
                    continue
                lname = name.lower()
                url = cfg.get("url") or cfg.get("endpoint")
                if not url:
                    continue
                if "curated" in lname:
                    found["curated"] = url
                elif "cognee" in lname or "work" in lname:
                    found["work"] = url
    except Exception:
        pass
    return found


async def _probe(url: str, timeout: float = 2.0) -> bool:
    if not httpx or not url:
        return False
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(url)
            return r.status_code < 600
    except Exception:
        try:
            parsed = urlparse(url)
            host = parsed.hostname or "localhost"
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            fut = asyncio.open_connection(host, port)
            _, w = await asyncio.wait_for(fut, timeout=timeout)
            w.close()
            return True
        except Exception:
            return False


async def run(queue: asyncio.Queue[dict[str, Any]], projects_dir: Path,
              poll_interval: float = 30.0) -> None:
    last_status: dict[str, bool] = {}
    try:
        while True:
            endpoints = _resolve_endpoints(projects_dir)
            for store, url in endpoints.items():
                try:
                    up = await _probe(url)
                except Exception:
                    up = False
                prev = last_status.get(store)
                last_status[store] = up
                changed = (prev is not None and prev != up)
                await queue.put({
                    "ts": _iso(),
                    "session": None,
                    "project": None,
                    "type": "cognee_op",
                    "tool": None,
                    "outcome": "completed",
                    "payload": {
                        "store": store,
                        "url": url,
                        "op": "probe",
                        "up": up,
                        "status_changed": changed,
                    },
                })
            await asyncio.sleep(poll_interval)
    except asyncio.CancelledError:
        return
