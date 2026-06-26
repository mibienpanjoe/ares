"""Shared loader for the ARES org.json reference.

Used by:
  - tabs/org.py     : full org tree + details panel
  - tabs/agents.py  : inline role annotation next to alias
  - tabs/live.py    : same

Loads once at import; refreshes are cheap (re-call _load_org()).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def _candidate_paths() -> list[Path]:
    """Where org.json may live, first hit wins.

    Order matters: the installed runtime copy is canonical because
    it tracks the harness version actually in use. Repo fallbacks are
    for dev mode (running ares-watch out of the source checkout).
    """
    runtime_home = _runtime_home()
    paths: list[Path] = [
        runtime_home / "org" / "org.json",
    ]
    legacy = Path(os.path.expanduser("~/.claude/mishkan/org/org.json"))
    if legacy != paths[0]:
        paths.append(legacy)
    # Walk up from this file looking for `payload/mishkan/org/org.json`
    # in case we're running from the repo checkout (dev mode).
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "payload" / "mishkan" / "org" / "org.json"
        if candidate.is_file():
            paths.append(candidate)
            break
        if parent == parent.parent:
            break
    return paths


def _runtime_home() -> Path:
    if os.environ.get("ARES_HOME"):
        return Path(os.path.expanduser(os.environ["ARES_HOME"]))
    if os.environ.get("MISHKAN_HOME"):
        return Path(os.path.expanduser(os.environ["MISHKAN_HOME"]))
    home = Path(os.path.expanduser("~"))
    if (home / ".ares").exists() or not (home / ".claude" / "mishkan").exists():
        return home / ".ares"
    return home / ".claude" / "mishkan"


def load_org() -> dict[str, Any]:
    for p in _candidate_paths():
        try:
            if p.is_file():
                return json.loads(p.read_text())
        except Exception:
            continue
    return {"groups": []}


def role_for(alias: str, org: dict[str, Any] | None = None) -> str | None:
    """Return the snake_case role for a given alias, or None if unknown.

    alias matching is case-insensitive. Returns the `short` field if
    present (e.g. "PM"), else the full `role` (e.g. "project_manager").
    The caller chooses which form to render.
    """
    if not alias:
        return None
    org = org or load_org()
    key = alias.lower()
    for grp in org.get("groups", []):
        for ag in grp.get("agents", []):
            if ag.get("alias", "").lower() == key:
                return ag.get("short") or ag.get("role")
    return None


def full_role_for(alias: str, org: dict[str, Any] | None = None) -> str | None:
    """Same as role_for but returns the full snake_case role, never the short alias."""
    if not alias:
        return None
    org = org or load_org()
    key = alias.lower()
    for grp in org.get("groups", []):
        for ag in grp.get("agents", []):
            if ag.get("alias", "").lower() == key:
                return ag.get("role")
    return None
