#!/usr/bin/env python3
"""
skill-discovery-indexer — universal indexer for agent skills.

Scans every installed skill on the user's agent runtime and produces a
single flat JSON index at ~/.ares/skill-discovery/index.json.

Roots scanned (in precedence order — first wins on name collisions):
  1. ~/.ares/skills/                    (origin = ares)
  2. ~/.agents/skills/                  (origin = portable)
  3. ~/.claude/skills/                  (origin = user)
  4. ~/.claude/plugins/*/skills/        (origin = plugin)
  5. <repo>/.claude/skills/             (origin = project)

Frontmatter is YAML-ish but parsed by a minimal stdlib parser (no PyYAML).
Triggers are extracted from "Use when…" / "Use this when…" sentences inside
the description, plus any explicit ``triggers: [...]`` list.

Categories are inferred from path segment first (e.g. -craft / ares- /
agent skills), then from a keyword heuristic on the description.

CLI:
    python3 skill-discovery-indexer.py [--rebuild | --stat-only | --manual]

Modes:
    --rebuild    (default on install/update) full rescan + sha256 + write
    --stat-only  cheap session-boot sweep; rebuilds only when any source
                 path's mtime is newer than index.json.meta.last_scan
    --manual     same as --rebuild but writes manual=True into meta

Stdlib only. Fail-open: any error indexing a single skill is logged and
that skill is skipped; the index still writes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Iterable

HOME = Path(os.path.expanduser("~"))


def runtime_home() -> Path:
    if os.environ.get("ARES_HOME"):
        return Path(os.path.expanduser(os.environ["ARES_HOME"]))
    if os.environ.get("MISHKAN_HOME"):
        return Path(os.path.expanduser(os.environ["MISHKAN_HOME"]))
    ares = HOME / ".ares"
    legacy = HOME / ".claude" / "mishkan"
    if ares.exists() or not legacy.exists():
        return ares
    return legacy


RUNTIME_HOME = runtime_home()
INDEX_DIR = RUNTIME_HOME / "skill-discovery"
INDEX_PATH = INDEX_DIR / "index.json"
MISSES_PATH = INDEX_DIR / "misses.jsonl"
ERRORS_PATH = INDEX_DIR / "indexer-errors.jsonl"

# Precedence order matters: first hit on a duplicate name wins.
ROOTS = [
    ("ares", RUNTIME_HOME / "skills"),
    ("mishkan", HOME / ".claude" / "mishkan" / "skills"),
    ("portable", HOME / ".agents" / "skills"),
    ("user", HOME / ".claude" / "skills"),
]


def discover_plugin_roots() -> list[tuple[str, Path]]:
    """~/.claude/plugins/*/skills."""
    out: list[tuple[str, Path]] = []
    plugins_root = HOME / ".claude" / "plugins"
    if not plugins_root.is_dir():
        return out
    for plugin_dir in sorted(plugins_root.iterdir()):
        if not plugin_dir.is_dir():
            continue
        skills_dir = plugin_dir / "skills"
        if skills_dir.is_dir():
            out.append(("plugin", skills_dir))
    return out


def discover_project_roots(cwd: Path) -> list[tuple[str, Path]]:
    """<repo>/.claude/skills/ — walk up from cwd looking for a .git or repo root."""
    out: list[tuple[str, Path]] = []
    here = cwd.resolve()
    seen: set[Path] = set()
    for parent in [here, *here.parents]:
        if parent in seen:
            continue
        seen.add(parent)
        candidate = parent / ".claude" / "skills"
        if candidate.is_dir():
            out.append(("project", candidate))
        # Stop at filesystem root or after we hit a .git
        if (parent / ".git").exists():
            break
    return out


# ---------------------------------------------------------------------------
# Minimal frontmatter parser (no PyYAML dependency)
# ---------------------------------------------------------------------------

FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Returns (frontmatter_dict, body). Tolerant — bad lines are skipped."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    raw = m.group(1)
    body = text[m.end():]
    fm: dict = {}
    current_key: str | None = None
    current_list: list[str] | None = None
    for line in raw.splitlines():
        if not line.strip():
            current_key, current_list = None, None
            continue
        # List item under previous key
        if line.lstrip().startswith("-") and current_list is not None:
            item = line.lstrip()[1:].strip()
            item = _strip_quotes(item)
            if item:
                current_list.append(item)
            continue
        if ":" in line:
            key, _, value = line.partition(":")
            key = key.strip()
            value = value.strip()
            if not key:
                continue
            if value == "":
                # Possible list to follow
                current_list = []
                fm[key] = current_list
                current_key = key
                continue
            if value.startswith("[") and value.endswith("]"):
                # Inline list
                inner = value[1:-1].strip()
                if inner:
                    items = [
                        _strip_quotes(part.strip())
                        for part in _split_inline_list(inner)
                    ]
                    fm[key] = [i for i in items if i]
                else:
                    fm[key] = []
                current_key, current_list = None, None
                continue
            fm[key] = _strip_quotes(value)
            current_key, current_list = None, None
        else:
            # Continuation of previous scalar (rare; folded value)
            if current_key and isinstance(fm.get(current_key), str):
                fm[current_key] = (fm[current_key] + " " + line.strip()).strip()
    # Demote empty lists to absent
    return fm, body


def _strip_quotes(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        return s[1:-1]
    return s


def _split_inline_list(s: str) -> list[str]:
    # Naive split on commas; good enough for skill frontmatter.
    return [p for p in s.split(",")]


# ---------------------------------------------------------------------------
# Trigger + category extraction
# ---------------------------------------------------------------------------

TRIGGER_PATTERNS = [
    re.compile(r"Use\s+(?:this\s+)?when\s+([^\.\n]+)", re.IGNORECASE),
    re.compile(r"Invoke\s+when\s+([^\.\n]+)", re.IGNORECASE),
    re.compile(r"Trigger(?:s)?\s+(?:when|on)\s+([^\.\n]+)", re.IGNORECASE),
    re.compile(r"Apply\s+when\s+([^\.\n]+)", re.IGNORECASE),
]

CATEGORY_KEYWORDS = [
    ("research", ["research", "investigate", "evaluate evidence"]),
    ("security", ["security", "threat", "vulnerab", "cve", "auth", "rbac"]),
    ("testing", ["test", "qa", "coverage", "e2e", "playwright", "jest", "bats"]),
    ("docs", ["documentation", "adr", "readme", "changelog"]),
    ("infra", ["kubernetes", "helm", "terraform", "docker", "cloud", "k8s", "deploy"]),
    ("data", ["database", "sql", "postgres", "schema", "migration", "etl"]),
    ("frontend", ["ui", "react", "tailwind", "nextjs", "frontend", "design system"]),
    ("backend", ["fastapi", "api", "backend", "server"]),
    ("observability", ["observ", "monitor", "metrics", "grafana", "prometheus", "tracing", "slo"]),
    ("ml", ["llm", "embedding", "rag", "langchain", "machine learning"]),
    ("orchestration", ["workflow", "orchestrat", "scheduling", "saga", "temporal"]),
    ("process", ["sprint", "review", "incident", "postmortem", "onboarding"]),
]


def extract_triggers(description: str, frontmatter: dict) -> list[str]:
    out: list[str] = []
    # Explicit list in frontmatter
    triggers = frontmatter.get("triggers")
    if isinstance(triggers, list):
        out.extend(str(t).strip() for t in triggers if str(t).strip())
    elif isinstance(triggers, str) and triggers.strip():
        out.append(triggers.strip())
    # Parsed from description prose
    for pat in TRIGGER_PATTERNS:
        for m in pat.finditer(description or ""):
            phrase = m.group(1).strip()
            phrase = re.sub(r"\s+", " ", phrase)
            if phrase and phrase not in out:
                out.append(phrase)
    return out


def infer_category(name: str, source_path: Path, description: str) -> str:
    """Path segment heuristic first, then keyword on description."""
    parts = [p.lower() for p in source_path.parts]
    # Path-segment hits
    if name.endswith("-craft"):
        return "craft"
    if name.startswith(("ares-", "mishkan-")):
        return "ares-workflow"
    if "research" in name:
        return "research"
    if "cognee" in name:
        return "memory"
    # Description keyword hits
    desc_low = (description or "").lower()
    for cat, kws in CATEGORY_KEYWORDS:
        for kw in kws:
            if kw in desc_low:
                return cat
    # Fallback by enclosing directory
    for seg in parts[::-1]:
        if seg in {"skills", "ares", "mishkan"}:
            continue
        if seg.startswith("."):
            continue
        return seg
    return "general"


# ---------------------------------------------------------------------------
# Walking + indexing
# ---------------------------------------------------------------------------

@dataclass
class IndexEntry:
    name: str
    source_path: str
    origin: str
    description: str
    triggers: list[str]
    category: str
    frontmatter_raw: dict
    sha256: str
    indexed_at: str
    mtime: float = 0.0


def iter_skill_files(root: Path) -> Iterable[Path]:
    if not root.is_dir():
        return
    for entry in root.iterdir():
        if entry.is_dir():
            skill_md = entry / "SKILL.md"
            if skill_md.is_file():
                yield skill_md
        elif entry.is_file() and entry.name == "SKILL.md":
            # rare flat case
            yield entry


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    try:
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
    except OSError:
        return ""
    return h.hexdigest()


def _log_error(stage: str, path: Path | None, exc: Exception) -> None:
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    rec = {
        "stage": stage,
        "path": str(path) if path else None,
        "error": f"{type(exc).__name__}: {exc}",
        "timestamp": _now_iso(),
    }
    try:
        with ERRORS_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
    except OSError:
        pass


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def build_entry(skill_md: Path, origin: str) -> IndexEntry | None:
    try:
        text = skill_md.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        _log_error("read", skill_md, exc)
        return None
    fm, _body = parse_frontmatter(text)
    name = str(fm.get("name") or skill_md.parent.name).strip()
    if not name:
        return None
    description = str(fm.get("description") or "").strip()
    triggers = extract_triggers(description, fm)
    category = infer_category(name, skill_md, description)
    try:
        mtime = skill_md.stat().st_mtime
    except OSError:
        mtime = 0.0
    return IndexEntry(
        name=name,
        source_path=str(skill_md),
        origin=origin,
        description=description,
        triggers=triggers,
        category=category,
        frontmatter_raw=fm,
        sha256=sha256_file(skill_md),
        indexed_at=_now_iso(),
        mtime=mtime,
    )


def collect_roots(cwd: Path) -> list[tuple[str, Path]]:
    roots: list[tuple[str, Path]] = []
    roots.extend(ROOTS)
    roots.extend(discover_plugin_roots())
    roots.extend(discover_project_roots(cwd))
    return roots


def rebuild_index(manual: bool = False, cwd: Path | None = None) -> dict:
    cwd = cwd or Path.cwd()
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    roots = collect_roots(cwd)

    entries: list[IndexEntry] = []
    seen_names: dict[str, str] = {}
    collisions: list[dict] = []

    for origin, root in roots:
        try:
            for skill_md in iter_skill_files(root):
                try:
                    entry = build_entry(skill_md, origin)
                except Exception as exc:  # fail-open per skill
                    _log_error("build_entry", skill_md, exc)
                    continue
                if entry is None:
                    continue
                if entry.name in seen_names:
                    collisions.append({
                        "name": entry.name,
                        "kept_origin": seen_names[entry.name],
                        "shadowed_origin": entry.origin,
                        "shadowed_path": entry.source_path,
                    })
                    continue
                seen_names[entry.name] = entry.origin
                entries.append(entry)
        except Exception as exc:
            _log_error("walk", root, exc)
            continue

    meta = {
        "version": 1,
        "generated_at": _now_iso(),
        "last_scan": time.time(),
        "manual": bool(manual),
        "roots": [{"origin": o, "path": str(p), "exists": p.is_dir()} for o, p in roots],
        "count": len(entries),
        "collisions": collisions,
    }
    payload = {"meta": meta, "entries": [asdict(e) for e in entries]}
    tmp = INDEX_PATH.with_suffix(".json.tmp")
    try:
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, INDEX_PATH)
    except OSError as exc:
        _log_error("write_index", INDEX_PATH, exc)
        # Still return payload so callers see it succeeded in-memory
    return payload


def stat_only_check(cwd: Path | None = None) -> bool:
    """Returns True if a rebuild was triggered."""
    cwd = cwd or Path.cwd()
    if not INDEX_PATH.is_file():
        rebuild_index(cwd=cwd)
        return True
    try:
        existing = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _log_error("read_index", INDEX_PATH, exc)
        rebuild_index(cwd=cwd)
        return True
    last_scan = float(existing.get("meta", {}).get("last_scan", 0.0))
    roots = collect_roots(cwd)
    for _origin, root in roots:
        if not root.is_dir():
            continue
        for skill_md in iter_skill_files(root):
            try:
                if skill_md.stat().st_mtime > last_scan:
                    rebuild_index(cwd=cwd)
                    return True
            except OSError:
                continue
    # Also rebuild if any indexed source_path no longer exists
    for entry in existing.get("entries", []):
        p = entry.get("source_path")
        if p and not Path(p).exists():
            rebuild_index(cwd=cwd)
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Universal skill-discovery indexer")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--rebuild", action="store_true", help="Full rescan + write")
    group.add_argument("--stat-only", action="store_true", help="Session-boot mtime sweep")
    group.add_argument("--manual", action="store_true", help="Manual rebuild via /ares-skills-reindex")
    parser.add_argument("--cwd", default=None, help="Override cwd for project root discovery")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    cwd = Path(args.cwd) if args.cwd else Path.cwd()

    try:
        if args.stat_only:
            rebuilt = stat_only_check(cwd=cwd)
            if not args.quiet:
                print(json.dumps({"mode": "stat-only", "rebuilt": rebuilt}))
            return 0
        payload = rebuild_index(manual=args.manual, cwd=cwd)
        if not args.quiet:
            print(json.dumps({
                "mode": "manual" if args.manual else "rebuild",
                "count": payload["meta"]["count"],
                "index_path": str(INDEX_PATH),
                "collisions": len(payload["meta"]["collisions"]),
            }))
        return 0
    except Exception as exc:
        _log_error("main", None, exc)
        # Fail-open: print error to stderr, exit 0 so callers never block on us
        print(f"skill-discovery-indexer: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    sys.exit(main())
