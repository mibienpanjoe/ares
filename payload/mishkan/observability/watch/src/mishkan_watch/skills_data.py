"""Shared loader for installed skills and their cross-references to ADRs.

Used by:
  - tabs/skills.py — full Skills browser tab

Independent of the skill-discovery indexer being built by Bezalel — the TUI
needs a self-contained read-only view that works whether or not the
indexer has run. If Bezalel's index.json exists, we prefer it; otherwise
we fall back to scanning the canonical paths directly.

What we expose
--------------
- load_skills() : list of skill entries with metadata
- load_adr_index() : map adr id -> list of skill names mentioned there

A skill entry:
    {
      "name": str,
      "origin": "mishkan" | "user" | "plugin" | "project" | "builtin",
      "source_path": str,
      "description": str,
      "category": str,
      "frontmatter": dict,
      "adrs": list[str],   # ADR ids that mention this skill, e.g. ["D-008"]
    }
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any


# Search order matters for name-collision resolution. First-hit wins.
_SKILL_SOURCES = [
    ("mishkan", Path.home() / ".claude" / "mishkan" / "skills"),
    ("user",    Path.home() / ".claude" / "skills"),
]


def _plugin_skill_dirs() -> list[tuple[str, Path]]:
    """Enumerate `~/.claude/plugins/*/skills/` lazily — order is filesystem order."""
    out: list[tuple[str, Path]] = []
    plugins = Path.home() / ".claude" / "plugins"
    if not plugins.is_dir():
        return out
    try:
        for child in plugins.iterdir():
            sd = child / "skills"
            if sd.is_dir():
                out.append(("plugin", sd))
    except OSError:
        pass
    return out


def _all_sources() -> list[tuple[str, Path]]:
    return list(_SKILL_SOURCES) + _plugin_skill_dirs()


_FM_BLOCK_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_FM_KV_RE = re.compile(r"^([A-Za-z_-]+):\s*(.*)$")
_USE_WHEN_RE = re.compile(r"(?:Use when|use when|Use this skill when)\s+([^.\n]+)\.?", re.IGNORECASE)


def _parse_skill_md(path: Path) -> dict[str, Any]:
    """Parse a SKILL.md file. Returns frontmatter + body-derived hints.

    Frontmatter is YAML-ish but we keep parsing simple — single-line
    key: value pairs (no nested structures, no multiline values). Skills
    that need more get represented as the raw frontmatter dict; the TUI
    just shows what's there.
    """
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    fm: dict[str, Any] = {}
    body = text
    m = _FM_BLOCK_RE.match(text)
    if m:
        block = m.group(1)
        body = text[m.end():]
        for raw in block.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            kv = _FM_KV_RE.match(line)
            if kv:
                fm[kv.group(1)] = kv.group(2).strip().strip('"').strip("'")
    triggers: list[str] = []
    for um in _USE_WHEN_RE.finditer(body):
        triggers.append(um.group(1).strip())
    return {"frontmatter": fm, "triggers": triggers, "body_chars": len(body)}


def _category_for(path: Path, fm: dict[str, Any]) -> str:
    """Heuristic category — first segment of the path under skills/, falling
    back to a keyword scan of the description."""
    try:
        parts = path.parent.name
    except Exception:
        parts = ""
    cat = parts
    desc = (fm.get("description") or "").lower()
    for keyword, label in (
        ("security", "security"), ("frontend", "frontend"),
        ("backend", "backend"), ("python", "python"),
        ("kubernetes", "infra"), ("k8s", "infra"),
        ("docker", "infra"), ("test", "testing"),
        ("docs", "docs"), ("design", "design"),
    ):
        if keyword in desc:
            cat = label
            break
    return cat or "uncategorised"


def _load_indexer_output() -> list[dict[str, Any]] | None:
    """If Bezalel's indexer has run, prefer its output."""
    p = Path.home() / ".claude" / "mishkan" / "skill-discovery" / "index.json"
    try:
        if p.is_file():
            data = json.loads(p.read_text())
            if isinstance(data, dict) and "entries" in data:
                return data["entries"]
            if isinstance(data, list):
                return data
    except Exception:
        return None
    return None


def load_skills() -> list[dict[str, Any]]:
    """Return the full set of installed skills.

    If `~/.claude/mishkan/skill-discovery/index.json` exists, use it;
    otherwise scan the canonical paths directly. Entries are deduplicated
    by skill name (first hit by source precedence wins).
    """
    indexed = _load_indexer_output()
    if indexed:
        adr_map = load_adr_index()
        for e in indexed:
            name = e.get("name") or ""
            e["adrs"] = adr_map.get(name, [])
        return indexed
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for origin, root in _all_sources():
        if not root.is_dir():
            continue
        try:
            # Two layouts: skills/<name>.md, or skills/<name>/SKILL.md.
            for entry in sorted(root.iterdir()):
                skill_md: Path | None = None
                name: str | None = None
                if entry.is_file() and entry.suffix == ".md":
                    skill_md = entry
                    name = entry.stem
                elif entry.is_dir():
                    cand = entry / "SKILL.md"
                    if cand.is_file():
                        skill_md = cand
                        name = entry.name
                if not skill_md or not name or name in seen:
                    continue
                seen.add(name)
                parsed = _parse_skill_md(skill_md)
                fm = parsed.get("frontmatter") or {}
                out.append({
                    "name": fm.get("name") or name,
                    "origin": origin,
                    "source_path": str(skill_md),
                    "description": fm.get("description") or "",
                    "category": _category_for(skill_md, fm),
                    "frontmatter": fm,
                    "triggers": parsed.get("triggers") or [],
                    "adrs": [],
                })
        except OSError:
            continue
    adr_map = load_adr_index()
    for e in out:
        e["adrs"] = adr_map.get(e["name"], [])
    return out


_ADR_HEADER_RE = re.compile(r"^## (D-\d{3})\b", re.MULTILINE)


def load_adr_index() -> dict[str, list[str]]:
    """Map skill name -> list of ADR ids that mention it.

    Parses `docs/design/MISHKAN_decisions.md`. Each ADR section is delimited
    by `## D-NNN`; within each section we scan for any installed-skill name
    that appears verbatim. This is conservative — a skill named `pdf` could
    match noise, but we accept that for now (the alternative is a strict
    whitelist that drifts).
    """
    decisions_path = _find_decisions_md()
    if not decisions_path:
        return {}
    try:
        text = decisions_path.read_text()
    except OSError:
        return {}
    sections: list[tuple[str, str]] = []
    cur_id: str | None = None
    cur_buf: list[str] = []
    for line in text.splitlines():
        m = _ADR_HEADER_RE.match(line)
        if m:
            if cur_id is not None:
                sections.append((cur_id, "\n".join(cur_buf)))
            cur_id = m.group(1)
            cur_buf = []
        elif cur_id is not None:
            cur_buf.append(line)
    if cur_id is not None:
        sections.append((cur_id, "\n".join(cur_buf)))
    # Cross-ref against known skills — we need the name list, but at this
    # point load_skills hasn't returned yet (would be circular). Instead
    # scan all skill dir entries by name and look those up.
    skill_names: set[str] = set()
    for _, root in _all_sources():
        if not root.is_dir():
            continue
        try:
            for entry in root.iterdir():
                if entry.is_file() and entry.suffix == ".md":
                    skill_names.add(entry.stem)
                elif entry.is_dir() and (entry / "SKILL.md").is_file():
                    skill_names.add(entry.name)
        except OSError:
            continue
    rev: dict[str, list[str]] = {}
    for adr_id, body in sections:
        for name in skill_names:
            if not name:
                continue
            # Whole-word match — guard against substring noise.
            if re.search(rf"\b{re.escape(name)}\b", body):
                rev.setdefault(name, []).append(adr_id)
    return rev


def _find_decisions_md() -> Path | None:
    """Locate MISHKAN_decisions.md. Prefer ~/.claude install path, fall back
    to a repo-mode walk-up."""
    candidates: list[Path] = [
        Path.home() / ".claude" / "mishkan" / "design" / "MISHKAN_decisions.md",
    ]
    here = Path(__file__).resolve()
    for parent in here.parents:
        c = parent / "docs" / "design" / "MISHKAN_decisions.md"
        if c.is_file():
            candidates.append(c)
            break
        if parent == parent.parent:
            break
    for c in candidates:
        if c.is_file():
            return c
    return None
