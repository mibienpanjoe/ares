"""Cognee polling source — HTTP probe of cognee work + curated endpoints,
plus a cypher node-count query against the underlying neo4j HTTP API.

Emits cognee_op events with up/down status and nodes count. neo4j
credentials are read from ~/.claude/mishkan/cognee/.env (the same env
the cognee containers load). If creds are missing or auth fails, the
event carries nodes=null and the Knowledge tab shows "?" rather than
fabricating zero.

Defaults to the conventional MISHKAN cognee endpoints (work :7777,
curated :7730) but reads .mcp.json files to pick up overrides.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

try:
    import httpx  # type: ignore
except Exception:  # pragma: no cover
    httpx = None  # graceful degradation


DEFAULT_ENDPOINTS = {
    "work": "http://localhost:7777/mcp",
    "curated": "http://localhost:7730/mcp",
}

# Neo4j HTTP endpoints in the MISHKAN cognee compose. work neo4j HTTP
# port maps host:7716 -> container:7474. curated neo4j HTTP port maps
# host:7731 -> container:7474. Both expose POST /db/neo4j/tx/commit.
NEO4J_HTTP = {
    "work": "http://localhost:7716/db/neo4j/tx/commit",
    "curated": "http://localhost:7731/db/neo4j/tx/commit",
}

COGNEE_ENV_FILES = {
    "work": Path(os.path.expanduser("~/.claude/mishkan/cognee/.env")),
    "curated": Path(os.path.expanduser("~/.claude/mishkan/cognee/.env.curated")),
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


def _read_neo4j_creds_for(store: str) -> tuple[Optional[str], Optional[str]]:
    """Read NEO4J creds from the .env that pairs with this store.

    work    → ~/.claude/mishkan/cognee/.env
    curated → ~/.claude/mishkan/cognee/.env.curated

    Each cognee store has its own neo4j with its own password, so the
    two .env files MUST be read independently — using the work password
    against the curated neo4j returns 401.
    """
    user = "neo4j"
    pwd: Optional[str] = None
    env_path = COGNEE_ENV_FILES.get(store)
    if env_path is None or not env_path.exists():
        return user, pwd
    try:
        for raw in env_path.read_text().splitlines():
            line = raw.split("#", 1)[0].strip()
            if not line or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key in ("GRAPH_DATABASE_USERNAME", "NEO4J_USERNAME", "NEO4J_USER"):
                user = val
            elif key in ("GRAPH_DATABASE_PASSWORD", "NEO4J_PASSWORD"):
                pwd = val
    except Exception:
        return user, pwd
    return user, pwd


async def _count_nodes(url: str, user: str, pwd: str, timeout: float = 3.0) -> Optional[int]:
    """POST a `MATCH (n) RETURN count(n)` cypher to neo4j HTTP API."""
    if not httpx or not pwd:
        return None
    try:
        async with httpx.AsyncClient(timeout=timeout, auth=(user, pwd)) as client:
            r = await client.post(
                url,
                json={"statements": [{"statement": "MATCH (n) RETURN count(n) AS c"}]},
                headers={"Accept": "application/json", "Content-Type": "application/json"},
            )
            if r.status_code >= 400:
                return None
            data = r.json()
            results = data.get("results") or []
            if not results:
                return None
            rows = results[0].get("data") or []
            if not rows:
                return None
            row = rows[0].get("row") or []
            if not row:
                return None
            return int(row[0])
    except Exception:
        return None


async def run(queue: asyncio.Queue[dict[str, Any]], projects_dir: Path,
              poll_interval: float = 30.0) -> None:
    last_status: dict[str, bool] = {}
    # Read creds for each store independently — work and curated have
    # different neo4j passwords loaded from .env / .env.curated.
    creds = {s: _read_neo4j_creds_for(s) for s in NEO4J_HTTP.keys()}
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

                # Node count via neo4j HTTP cypher. Fails open to None.
                nodes: Optional[int] = None
                if up and store in NEO4J_HTTP:
                    s_user, s_pwd = creds.get(store, ("neo4j", None))
                    if s_pwd:
                        nodes = await _count_nodes(NEO4J_HTTP[store],
                                                    s_user or "neo4j", s_pwd)

                payload: dict[str, Any] = {
                    "store": store,
                    "url": url,
                    "op": "probe",
                    "up": up,
                    "status_changed": changed,
                }
                if nodes is not None:
                    payload["nodes"] = nodes

                await queue.put({
                    "ts": _iso(),
                    "session": None,
                    "project": None,
                    "type": "cognee_op",
                    "tool": None,
                    "outcome": "completed",
                    "payload": payload,
                })
            await asyncio.sleep(poll_interval)
    except asyncio.CancelledError:
        return
