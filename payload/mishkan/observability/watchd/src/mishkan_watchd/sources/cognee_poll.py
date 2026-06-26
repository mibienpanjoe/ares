"""Cognee polling source — HTTP probe of cognee stores, per the D-012
three-pillar model:

  work    — per-project store (alias "cognee" in the project's .mcp.json,
             container ares-work-<slug> or mishkan-work-<slug>, dynamic port). Discovered from
             each project's .mcp.json; no fixed port.
  memory  — session memory store (alias "cognee-memory"), Neo4j on :7777
             (http://localhost:7777/mcp). Holds claude_code_memory.
  curated — shared curated store (alias "cognee-curated"), :7730 (unchanged).

Emits cognee_op events with up/down status and nodes count. neo4j
credentials are read from the runtime cognee env files under ~/.ares/cognee
(or legacy ~/.claude/mishkan/cognee). If creds are
missing or auth fails, the event carries nodes=null and the Knowledge
tab shows "?" rather than fabricating zero.
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


# Fixed endpoints for the two always-present stores (D-012).
# "work" (per-project) has no fixed port — it is discovered from .mcp.json.
DEFAULT_ENDPOINTS: dict[str, str] = {
    "memory": "http://localhost:7777/mcp",
    "curated": "http://localhost:7730/mcp",
}

# Neo4j HTTP endpoints for the fixed stores.
# memory neo4j HTTP port maps host:7716 -> container:7474.
# curated neo4j HTTP port maps host:7731 -> container:7474.
# Both expose POST /db/neo4j/tx/commit.
NEO4J_HTTP: dict[str, str] = {
    "memory": "http://localhost:7716/db/neo4j/tx/commit",
    "curated": "http://localhost:7731/db/neo4j/tx/commit",
}

def _runtime_home() -> Path:
    if os.environ.get("ARES_HOME"):
        return Path(os.path.expanduser(os.environ["ARES_HOME"]))
    if os.environ.get("MISHKAN_HOME"):
        return Path(os.path.expanduser(os.environ["MISHKAN_HOME"]))
    home = Path(os.path.expanduser("~"))
    if (home / ".ares").exists() or not (home / ".claude" / "mishkan").exists():
        return home / ".ares"
    return home / ".claude" / "mishkan"


RUNTIME_HOME = _runtime_home()
COGNEE_ENV_FILES: dict[str, Path] = {
    "memory": RUNTIME_HOME / "cognee" / ".env",
    "curated": RUNTIME_HOME / "cognee" / ".env.curated",
}
LEGACY_COGNEE_ENV_FILES: dict[str, Path] = {
    "memory": Path(os.path.expanduser("~/.claude/mishkan/cognee/.env")),
    "curated": Path(os.path.expanduser("~/.claude/mishkan/cognee/.env.curated")),
}


def _iso(ts: float | None = None) -> str:
    t = datetime.fromtimestamp(ts or time.time(), tz=timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def _discover_project_mcp_servers(projects_dir: Path) -> list[tuple[str, dict]]:
    """Return a flat list of (project_path, servers_dict) from all known .mcp.json files.

    Mirrors the discovery logic in mcp_probe._discover_mcp_servers: reads
    ~/.claude.json `.projects` keys first (the /ares-init layout where
    .mcp.json lives at the project root), then falls back to the legacy
    projects_dir glob.
    """
    results: list[tuple[str, dict]] = []
    claude_home = projects_dir.parent  # ~/.claude/
    home = claude_home.parent           # /home/ogu/ (or equivalent)
    claude_json = home / ".claude.json"

    seen: set[Path] = set()

    # Primary: project roots listed in ~/.claude.json
    if claude_json.exists():
        try:
            data = json.loads(claude_json.read_text())
            for p in (data.get("projects") or {}).keys():
                mcp_path = Path(p) / ".mcp.json"
                if mcp_path.exists() and mcp_path not in seen:
                    seen.add(mcp_path)
                    try:
                        pdata = json.loads(mcp_path.read_text())
                        servers = pdata.get("mcpServers") or pdata.get("servers") or {}
                        if isinstance(servers, dict):
                            results.append((p, servers))
                    except Exception:
                        pass
        except Exception:
            pass

    # Fallback: legacy glob inside projects_dir
    try:
        for mcp_json in projects_dir.glob("*/.mcp.json"):
            if mcp_json not in seen:
                seen.add(mcp_json)
                try:
                    pdata = json.loads(mcp_json.read_text())
                    servers = pdata.get("mcpServers") or pdata.get("servers") or {}
                    if isinstance(servers, dict):
                        results.append((str(mcp_json.parent), servers))
                except Exception:
                    pass
    except Exception:
        pass

    return results


def _resolve_endpoints(projects_dir: Path) -> dict[str, str]:
    """Build the endpoint map for all three D-012 stores.

    Returns a dict with keys:
      "memory"  — the cognee-memory store (:7777 or overridden by a
                  cognee-memory alias in any project's .mcp.json)
      "curated" — the cognee-curated store (:7730 or overridden)
      "work"    — the per-project store (cognee alias in .mcp.json);
                  present only when at least one project declares it.

    Discovery priority for "work": the first project whose .mcp.json
    carries a server named exactly "cognee" (the alias /ares-init
    writes for the per-project Ladybug store) wins. This is intentionally
    first-match because only one project-local store is in scope for the
    current polling cycle; the project slug is also returned so the TUI
    can label the card.
    """
    found: dict[str, str] = dict(DEFAULT_ENDPOINTS)
    found_work_project: str | None = None

    for project_path, servers in _discover_project_mcp_servers(projects_dir):
        for name, cfg in servers.items():
            if not isinstance(cfg, dict):
                continue
            lname = name.lower()
            url = cfg.get("url") or cfg.get("endpoint")
            if not url:
                continue
            if lname == "cognee-curated" or ("curated" in lname and "cognee" in lname):
                found["curated"] = url
            elif lname == "cognee-memory" or ("memory" in lname and "cognee" in lname):
                found["memory"] = url
            elif lname == "cognee" and "work" not in found:
                # Exact "cognee" alias = per-project work store (D-012).
                found["work"] = url
                found_work_project = project_path

    # Attach the discovered project path as a sidecar key so the run()
    # loop can embed it in the emitted event payload.
    if found_work_project:
        found["_work_project"] = found_work_project

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

    memory  → ~/.ares/cognee/.env
    curated → ~/.ares/cognee/.env.curated
    work    → per-project store (Ladybug embedded); no fixed .env path,
              returns (neo4j, None) so node-count is skipped gracefully.

    Each cognee store has its own neo4j with its own password, so the
    two .env files MUST be read independently — using the memory password
    against the curated neo4j returns 401.
    """
    user = "neo4j"
    pwd: Optional[str] = None
    env_path = COGNEE_ENV_FILES.get(store)
    if env_path is not None and not env_path.exists():
        legacy_env_path = LEGACY_COGNEE_ENV_FILES.get(store)
        if legacy_env_path is not None and legacy_env_path.exists():
            env_path = legacy_env_path
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
    # Read creds for the fixed stores independently — memory and curated
    # have different neo4j passwords loaded from .env / .env.curated.
    # "work" (per-project Ladybug) has no fixed .env; node-count is skipped.
    creds = {s: _read_neo4j_creds_for(s) for s in NEO4J_HTTP.keys()}
    try:
        while True:
            endpoints = _resolve_endpoints(projects_dir)
            # Strip the sidecar _work_project key before iterating stores.
            work_project: str | None = endpoints.pop("_work_project", None)

            for store, url in endpoints.items():
                try:
                    up = await _probe(url)
                except Exception:
                    up = False
                prev = last_status.get(store)
                last_status[store] = up
                changed = (prev is not None and prev != up)

                # Node count via neo4j HTTP cypher. Fails open to None.
                # "work" store uses an embedded Ladybug — no standalone
                # neo4j HTTP port is known; skip node-count for it.
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
                # Embed the project path for the per-project work store so
                # the TUI can label the card with the project slug.
                if store == "work" and work_project:
                    payload["project"] = work_project

                await queue.put({
                    "ts": _iso(),
                    "session": None,
                    "project": work_project if store == "work" else None,
                    "type": "cognee_op",
                    "tool": None,
                    "outcome": "completed",
                    "payload": payload,
                })
                # Also surface cognee stores in the MCP servers table.
                # "work" uses the alias "cognee"; memory and curated use
                # "cognee-memory" / "cognee-curated" respectively.
                mcp_name = "cognee" if store == "work" else f"cognee-{store}"
                await queue.put({
                    "ts": _iso(),
                    "session": None,
                    "project": work_project if store == "work" else None,
                    "type": "mcp_server",
                    "tool": mcp_name,
                    "outcome": "completed",
                    "payload": {
                        "server": mcp_name,
                        "url": url,
                        "transport": "http",
                        "status": "up" if up else "down",
                        "status_changed": changed,
                    },
                })
            await asyncio.sleep(poll_interval)
    except asyncio.CancelledError:
        return
