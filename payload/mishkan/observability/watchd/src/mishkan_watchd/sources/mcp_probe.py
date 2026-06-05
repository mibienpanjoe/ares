"""MCP server health probe source — discovers configured MCP endpoints
from .mcp.json files across projects, then probes each by TCP connect.

Emits mcp_server events when status changes (up <-> down).
The probe is shallow — TCP connect + (when HTTP) a single HEAD request.
A server can appear up while broken internally; out of scope to deep-probe.
"""
from __future__ import annotations

import asyncio
import json
import socket
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    import httpx  # type: ignore
except Exception:  # pragma: no cover
    httpx = None  # graceful degradation if missing


def _iso(ts: float | None = None) -> str:
    t = datetime.fromtimestamp(ts or time.time(), tz=timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def _discover_mcp_servers(projects_dir: Path) -> dict[str, dict[str, str]]:
    """Read all .mcp.json under ~/.claude/projects/* and the user config.

    Returns {name: {url, transport, project}}, deduplicated by name+url.
    """
    found: dict[str, dict[str, str]] = {}
    # Per-project .mcp.json
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
            url = cfg.get("url") or cfg.get("endpoint") or ""
            transport = cfg.get("transport") or cfg.get("type") or "stdio"
            key = f"{name}@{url or 'stdio'}"
            found.setdefault(key, {
                "name": name,
                "url": url,
                "transport": transport,
                "project": str(mcp_json.parent),
            })
    # User-level settings.json mcpServers (some installs put MCPs there).
    user_settings = projects_dir.parent / "settings.json"
    if user_settings.exists():
        try:
            data = json.loads(user_settings.read_text())
            servers = data.get("mcpServers") or {}
            if isinstance(servers, dict):
                for name, cfg in servers.items():
                    if not isinstance(cfg, dict):
                        continue
                    url = cfg.get("url") or cfg.get("endpoint") or ""
                    transport = cfg.get("transport") or cfg.get("type") or "stdio"
                    key = f"{name}@{url or 'stdio'}"
                    found.setdefault(key, {
                        "name": name,
                        "url": url,
                        "transport": transport,
                        "project": "user",
                    })
        except Exception:
            pass
    return found


async def _probe_http(url: str, timeout: float = 2.0) -> bool:
    """Probe an HTTP MCP endpoint. Returns True if reachable."""
    if not httpx or not url:
        return False
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.head(url)
            # Any HTTP response (even 4xx) means the server is listening.
            return r.status_code < 600
    except Exception:
        # Some servers reject HEAD; try a GET as a fallback.
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                r = await client.get(url)
                return r.status_code < 600
        except Exception:
            return False


async def _probe_tcp(host: str, port: int, timeout: float = 2.0) -> bool:
    """Best-effort TCP connect probe for stdio MCPs (rarely useful)."""
    try:
        fut = asyncio.open_connection(host, port)
        reader, writer = await asyncio.wait_for(fut, timeout=timeout)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return True
    except Exception:
        return False


async def _probe_server(cfg: dict[str, str]) -> str:
    """Returns 'up' or 'down' for a given MCP server config."""
    transport = (cfg.get("transport") or "").lower()
    url = cfg.get("url") or ""
    if not url:
        return "unknown"
    if url.startswith(("http://", "https://")):
        return "up" if await _probe_http(url) else "down"
    parsed = urlparse(url)
    if parsed.hostname:
        return "up" if await _probe_tcp(parsed.hostname, parsed.port or 80) else "down"
    return "unknown"


async def run(queue: asyncio.Queue[dict[str, Any]], projects_dir: Path,
              poll_interval: float = 60.0) -> None:
    """Probe configured MCP servers every poll_interval seconds."""
    last_status: dict[str, str] = {}
    try:
        while True:
            servers = _discover_mcp_servers(projects_dir)
            for key, cfg in servers.items():
                try:
                    status = await _probe_server(cfg)
                except Exception:
                    status = "down"
                prev = last_status.get(key)
                changed = (prev is not None and prev != status)
                last_status[key] = status
                await queue.put({
                    "ts": _iso(),
                    "session": None,
                    "project": cfg.get("project") or "",
                    "type": "mcp_server",
                    "tool": cfg.get("name"),
                    "outcome": "completed",
                    "payload": {
                        "server": cfg.get("name"),
                        "url": cfg.get("url"),
                        "transport": cfg.get("transport"),
                        "status": status,
                        "status_changed": changed,
                    },
                })
            await asyncio.sleep(poll_interval)
    except asyncio.CancelledError:
        return
