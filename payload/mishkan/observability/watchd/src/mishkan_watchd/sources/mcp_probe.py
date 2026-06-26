"""MCP server health probe source — discovers configured MCP endpoints
from .mcp.json files across projects, then probes each by TCP connect.

Emits mcp_server events when status changes (up <-> down).
The probe is shallow — TCP connect + (when HTTP) a single HEAD request.
A server can appear up while broken internally; out of scope to deep-probe.
"""
from __future__ import annotations

import asyncio
import json
import re
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


def _add(found: dict[str, dict[str, str]], name: str, url: str,
         transport: str, project: str) -> None:
    key = f"{name}@{url or 'stdio'}"
    found.setdefault(key, {
        "name": name,
        "url": url,
        "transport": transport,
        "project": project,
    })


def _parse_servers_block(servers: Any, project: str, found: dict[str, dict[str, str]]) -> None:
    if not isinstance(servers, dict):
        return
    for name, cfg in servers.items():
        if not isinstance(cfg, dict):
            continue
        url = cfg.get("url") or cfg.get("endpoint") or ""
        transport = cfg.get("transport") or cfg.get("type") or "stdio"
        _add(found, name, url, transport, project)


def _parse_codex_config(path: Path, project: str, found: dict[str, dict[str, str]]) -> None:
    """Parse the subset of Codex TOML config written by ARES."""
    try:
        text = path.read_text()
    except Exception:
        return
    section_re = re.compile(r"^\[mcp_servers\.([^\]]+)\]\s*(.*?)(?=^\[|\Z)", re.MULTILINE | re.DOTALL)
    for match in section_re.finditer(text):
        name = match.group(1).strip().strip('"').strip("'")
        body = match.group(2)
        enabled = re.search(r"^\s*enabled\s*=\s*false\s*$", body, re.MULTILINE)
        if not name or enabled:
            continue
        url_match = re.search(r'^\s*url\s*=\s*"([^"]+)"\s*$', body, re.MULTILINE)
        url = url_match.group(1) if url_match else ""
        transport = "http" if url.startswith(("http://", "https://")) else "stdio"
        _add(found, name, url, transport, project)


def _parse_opencode_config(path: Path, project: str, found: dict[str, dict[str, str]]) -> None:
    """Parse OpenCode's JSON MCP block."""
    try:
        data = json.loads(path.read_text())
    except Exception:
        return
    mcp = data.get("mcp") if isinstance(data, dict) else None
    if not isinstance(mcp, dict):
        return
    for name, cfg in mcp.items():
        if not isinstance(cfg, dict) or cfg.get("enabled") is False:
            continue
        url = cfg.get("url") or cfg.get("endpoint") or ""
        transport = cfg.get("transport") or cfg.get("type") or ("http" if url.startswith(("http://", "https://")) else "stdio")
        _add(found, name, url, transport, project)


def _parse_project_runtime_configs(project_root: Path, found: dict[str, dict[str, str]]) -> None:
    project = str(project_root)
    codex_config = project_root / ".codex" / "config.toml"
    if codex_config.exists():
        _parse_codex_config(codex_config, project=project, found=found)
    opencode_config = project_root / "opencode.json"
    if opencode_config.exists():
        _parse_opencode_config(opencode_config, project=project, found=found)


def _discover_mcp_servers(projects_dir: Path) -> dict[str, dict[str, str]]:
    """Discover MCP servers from every place Claude Code stores them.

    Returns {name@url: {name, url, transport, project}}.

    Sources, in increasing priority for the same name:
      1. Project .mcp.json files placed by /ares-init at each project
         root (e.g. /home/ogu/theY4NN/aiobi-mail/.mcp.json). Project
         paths are read from ~/.claude.json `.projects` keys.
      2. The legacy ~/.claude/projects/*/.mcp.json glob (most installs
         do not use this layout but it's cheap to also check).
      3. ~/.claude.json `.projects.<path>.mcpServers` per-project block
         (claude mcp add writes here on some installs).
      4. ~/.claude/settings.json `mcpServers`.
      5. ~/.claude/mcp-needs-auth-cache.json — exposes claude.ai-side
         injected MCPs (Gmail, Drive, Canva, …) that don't have a
         local URL. They appear in the table with transport="claude.ai"
         and status will be reported as "remote" rather than probed.
      6. ARES Codex/OpenCode project and user config blocks.
    """
    found: dict[str, dict[str, str]] = {}
    claude_home = projects_dir.parent  # ~/.claude/

    # (1) — project .mcp.json files. The list of project paths lives in
    # ~/.claude.json under `.projects`. /ares-init writes the .mcp.json
    # at the project root, NOT in the Claude Code project session dir.
    home = claude_home.parent  # /home/ogu/
    claude_json = home / ".claude.json"
    project_roots: set[Path] = set()
    if claude_json.exists():
        try:
            data = json.loads(claude_json.read_text())
            project_paths = list((data.get("projects") or {}).keys())
        except Exception:
            project_paths = []
        for p in project_paths:
            project_roots.add(Path(p))
            try:
                mcp_path = Path(p) / ".mcp.json"
                if not mcp_path.exists():
                    continue
                pdata = json.loads(mcp_path.read_text())
                _parse_servers_block(
                    pdata.get("mcpServers") or pdata.get("servers"),
                    project=p, found=found,
                )
            except Exception:
                continue

    # (2) — legacy glob; covers old layouts where .mcp.json sat alongside
    # the session JSONLs.
    try:
        for mcp_json in projects_dir.glob("*/.mcp.json"):
            project_roots.add(mcp_json.parent)
            try:
                data = json.loads(mcp_json.read_text())
                _parse_servers_block(
                    data.get("mcpServers") or data.get("servers"),
                    project=str(mcp_json.parent), found=found,
                )
            except Exception:
                continue
    except Exception:
        pass

    # (3) — ~/.claude.json `.projects.<path>.mcpServers`. claude mcp add
    # may write here on some installs.
    if claude_json.exists():
        try:
            data = json.loads(claude_json.read_text())
            for p, pcfg in (data.get("projects") or {}).items():
                if isinstance(pcfg, dict):
                    _parse_servers_block(pcfg.get("mcpServers"), project=p, found=found)
        except Exception:
            pass

    # (4) — ~/.claude/settings.json `mcpServers`.
    user_settings = claude_home / "settings.json"
    if user_settings.exists():
        try:
            data = json.loads(user_settings.read_text())
            _parse_servers_block(data.get("mcpServers"), project="user", found=found)
        except Exception:
            pass

    # (5) — claude.ai-injected MCPs. No URL → marked transport=claude.ai.
    needs_auth = claude_home / "mcp-needs-auth-cache.json"
    if needs_auth.exists():
        try:
            data = json.loads(needs_auth.read_text())
            if isinstance(data, dict):
                for name, cfg in data.items():
                    _add(found, name, url="", transport="claude.ai",
                         project="claude.ai-injected")
        except Exception:
            pass

    # (6) — ARES-managed Codex/OpenCode configs, both project-local and user.
    try:
        project_roots.add(Path.cwd())
    except Exception:
        pass
    for root in list(project_roots):
        _parse_project_runtime_configs(root, found)
    codex_global = home / ".codex" / "config.toml"
    if codex_global.exists():
        _parse_codex_config(codex_global, project="codex-user", found=found)
    opencode_global = home / ".config" / "opencode" / "opencode.json"
    if opencode_global.exists():
        _parse_opencode_config(opencode_global, project="opencode-user", found=found)

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
    """Returns 'up', 'down', 'remote' (claude.ai-side, no probe), or 'unknown'."""
    transport = (cfg.get("transport") or "").lower()
    if transport == "claude.ai":
        return "remote"  # injected by claude.ai server-side; not locally probable
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
