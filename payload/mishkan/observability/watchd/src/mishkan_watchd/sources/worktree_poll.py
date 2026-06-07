"""Worktree poll source — `git worktree list --porcelain` per known project.

Polls every 5 s. Emits worktree_change events on add / remove.
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _iso(ts: float | None = None) -> str:
    t = datetime.fromtimestamp(ts or time.time(), tz=timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


async def _list_worktrees(project_path: Path) -> list[dict[str, str]]:
    """Run `git worktree list --porcelain` in project_path, parse output."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", "-C", str(project_path), "worktree", "list", "--porcelain",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=2.0)
    except Exception:
        return []
    out = stdout.decode("utf-8", errors="replace")
    entries: list[dict[str, str]] = []
    cur: dict[str, str] = {}
    for line in out.splitlines():
        if not line.strip():
            if cur:
                entries.append(cur)
                cur = {}
            continue
        if line.startswith("worktree "):
            cur["path"] = line[len("worktree "):]
        elif line.startswith("HEAD "):
            cur["head"] = line[len("HEAD "):]
        elif line.startswith("branch "):
            cur["branch"] = line[len("branch "):].replace("refs/heads/", "", 1)
        elif line == "detached":
            cur["branch"] = "(detached)"
    if cur:
        entries.append(cur)
    return entries


async def _poll_once(project_paths: list[Path], known: dict[str, dict[str, str]],
                     queue: asyncio.Queue[dict[str, Any]]) -> None:
    seen: set[str] = set()
    for proj in project_paths:
        if not (proj / ".git").exists():
            continue
        for wt in await _list_worktrees(proj):
            path = wt.get("path", "")
            if not path:
                continue
            seen.add(path)
            if path not in known:
                # Stamp the owner project so we only emit "remove" later
                # if the OWNER was actually polled this round. Prevents the
                # storm of phantom removes when project list temporarily
                # drops (e.g. before session_discover's first confirmation).
                known[path] = {**wt, "_project": str(proj)}
                await queue.put({
                    "ts": _iso(),
                    "session": None,
                    "project": str(proj),
                    "type": "worktree_change",
                    "tool": None,
                    "outcome": "completed",
                    "payload": {"op": "add", **wt},
                })

    polled_projects = {str(p) for p in project_paths}
    for path in list(known.keys()):
        owner = known[path].get("_project", "")
        if owner not in polled_projects:
            # The project that owned this worktree wasn't polled this
            # round — don't infer a removal from absence of evidence.
            continue
        if path not in seen:
            wt = known.pop(path)
            wt.pop("_project", None)
            await queue.put({
                "ts": _iso(),
                "session": None,
                "project": owner,
                "type": "worktree_change",
                "tool": None,
                "outcome": "completed",
                "payload": {"op": "remove", **wt},
            })


async def run(queue: asyncio.Queue[dict[str, Any]],
              project_paths_provider, poll_interval: float = 5.0) -> None:
    """Poll worktrees across the projects returned by project_paths_provider.

    project_paths_provider is a callable returning list[Path] of project
    roots to inspect. Called fresh on each poll so sessions discovered
    later are picked up automatically.
    """
    known: dict[str, dict[str, str]] = {}
    try:
        while True:
            try:
                projects = project_paths_provider() or []
            except Exception:
                projects = []
            await _poll_once(projects, known, queue)
            await asyncio.sleep(poll_interval)
    except asyncio.CancelledError:
        return
