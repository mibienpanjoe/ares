"""Graphify daemon source — stats-only watcher for graphify-out/.

Graphify produces deterministic AST graphs under `<project>/graphify-out/`.
This source watches every active session's project for graph.json changes
and surfaces current node/edge/community counts as state refreshes.

STATS-ONLY (as of Fix ③): this source no longer owns scan or query COUNTS.
Real graphify CLI invocations are detected by post-tool-observe.sh (Bash
hook, PostToolUse) which emits the authoritative graphify_scan and
graphify_query events that carry session_id and increment the counters in
state.py. This source only emits graphify_scan events with stats_only=True
so state.py updates the size display (nodes/edges/communities) WITHOUT
incrementing the scan counter. This eliminates:
  - double-counting (hook + tail both firing for one real scan), and
  - the phantom scan on every daemon restart (old last_graph_mtime=0.0 init).

The memory/ watcher is also removed: graphify query --save-result is not
the documented workflow; the hook detects the real `graphify query` CLI
invocation instead.

Fail-open per the daemon contract. Missing graphify-out/ is silent —
many projects don't use Graphify and that's fine.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


def _iso(ts: float | None = None) -> str:
    t = datetime.fromtimestamp(ts or time.time(), tz=timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


class _ProjectWatcher:
    """One watcher per project root that has a graphify-out/ dir.

    Stats-only: emits graphify_scan with stats_only=True when graph.json
    mtime advances. This refreshes the node/edge/community display in the
    Knowledge tab WITHOUT incrementing the scan counter in state.py.

    The mtime baseline is initialised to the CURRENT mtime of graph.json
    at construction time so an already-built graph does NOT fire a phantom
    stats event on daemon restart. It fires only when the graph is actually
    rebuilt after the daemon started.
    """

    def __init__(self, project_path: Path, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self.project_path = project_path
        self.queue = queue
        self.graph_dir = project_path / "graphify-out"
        self.graph_json = self.graph_dir / "graph.json"
        # Initialise to the current mtime so pre-existing graphs do NOT
        # produce a phantom stats event on the first poll.
        try:
            self.last_graph_mtime: float = self.graph_json.stat().st_mtime
        except OSError:
            self.last_graph_mtime = 0.0

    async def step(self) -> None:
        if not self.graph_dir.is_dir():
            return
        await self._check_graph()

    async def _check_graph(self) -> None:
        try:
            if not self.graph_json.exists():
                return
            mtime = self.graph_json.stat().st_mtime
        except OSError:
            return
        if mtime <= self.last_graph_mtime:
            return
        self.last_graph_mtime = mtime
        stats = self._read_graph_stats()
        await self.queue.put({
            "ts": _iso(),
            "session": None,
            "project": str(self.project_path),
            "type": "graphify_scan",
            "tool": None,
            "outcome": "completed",
            "payload": {
                "op": "stats",
                "project": str(self.project_path),
                "nodes": stats.get("nodes"),
                "edges": stats.get("edges"),
                "communities": stats.get("communities"),
                "scanned_at": _iso(mtime),
                # stats_only=True signals state.py to update size fields
                # but NOT increment the scan counter.
                "stats_only": True,
            },
        })

    def _read_graph_stats(self) -> dict[str, Any]:
        """Read node/edge/community counts from graph.json.

        Graphify's manifest.json is a file→hash map, NOT a stats file —
        we only read graph.json. The format is NetworkX node-link:
          {nodes: [...], links: [...], hyperedges?: [...]}
        Note: 'links' (NetworkX naming), not 'edges'. Communities are
        not currently exported by Graphify, but we keep the field nullable
        for future compatibility.
        """
        try:
            g = json.loads(self.graph_json.read_text())
        except Exception:
            return {}
        if not isinstance(g, dict):
            return {}
        nodes = g.get("nodes") or []
        # Accept both 'links' (NetworkX, what Graphify writes) and 'edges'
        # (alt convention) for forward-compat.
        edges = g.get("links") or g.get("edges") or []
        communities = g.get("communities") or g.get("hyperedges") or []
        return {
            "nodes": len(nodes) if isinstance(nodes, list) else None,
            "edges": len(edges) if isinstance(edges, list) else None,
            "communities": len(communities) if isinstance(communities, list) else None,
        }


def _decode_project(p: str) -> str:
    """Decode Claude Code's encoded project dir name into an absolute path.

    ~/.claude/projects encodes each working directory as its absolute path
    with '/' replaced by '-' (e.g. -home-ogu-theY4NN-harness for
    /home/ogu/theY4NN/harness). When the daemon's session_discover source
    grabs the project from jsonl.parent.name, it gets this encoded form.
    Sources that try to open the project on disk (graphify_tail,
    worktree_poll) MUST decode first or every project is silently skipped.
    """
    if not p or p in ("", "unknown", "?"):
        return p
    if p.startswith("/"):
        return p
    if p.startswith("-"):
        return p.replace("-", "/")
    return p


def _project_paths_from_state(state) -> list[Path]:
    """Pull distinct project paths from the daemon's active sessions."""
    seen: set[str] = set()
    out: list[Path] = []
    try:
        for sess in (state.sessions or {}).values():
            raw = sess.project if hasattr(sess, "project") else None
            if not raw or raw in ("", "unknown"):
                continue
            p = _decode_project(raw)
            if p in seen:
                continue
            seen.add(p)
            if Path(p).is_dir():
                out.append(Path(p))
    except Exception:
        pass
    return out


async def run(queue: asyncio.Queue[dict[str, Any]],
              project_paths_provider, poll_interval: float = 5.0) -> None:
    """Watch every project with a graphify-out/ dir.

    project_paths_provider is a callable returning list[Path]. Re-evaluated
    each poll so sessions discovered later are picked up automatically.
    """
    watchers: dict[Path, _ProjectWatcher] = {}
    try:
        while True:
            try:
                projects = project_paths_provider() or []
            except Exception:
                projects = []
            for p in projects:
                if p not in watchers and (p / "graphify-out").is_dir():
                    watchers[p] = _ProjectWatcher(p, queue)
            # Don't prune watchers whose graphify-out/ disappeared — same
            # project may rebuild later; cheap to keep.
            for w in list(watchers.values()):
                try:
                    await w.step()
                except Exception:
                    continue
            await asyncio.sleep(poll_interval)
    except asyncio.CancelledError:
        return
