#!/usr/bin/env python3
"""
skill-discovery-misses — aggregate the router miss log into a tuning report.

Reads ``~/.ares/skill-discovery/misses.jsonl`` (one JSON record per
empty-bucket routing, written by the router) and produces a compact summary:

- Top N task patterns that produced empty buckets, with count + last_seen.
- Breakdown by error reason (no_match_above_threshold vs index_missing vs
  router_exception …).
- Total miss count + observation window.

Used at sprint close (and on demand via ``/ares-skills-misses``) to
identify skills whose ``description`` / ``triggers`` need richer keywords so
the trigger-match catches the recurring patterns. Threshold-tuning happens
*after* description-tuning has been tried — premature threshold changes chase
noise (D-011 §"Phase 1 → Phase 2 path").

Stdlib only. Fail-open: missing file → empty report, exit 0.

CLI:
    python3 skill-discovery-misses.py [--top N] [--json]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

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


MISSES_PATH = runtime_home() / "skill-discovery" / "misses.jsonl"

STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with",
    "this", "that", "is", "are", "be", "by", "as", "at", "it", "its", "from",
    "into", "i", "we", "you", "your", "my", "our", "use", "using", "when",
    "how", "what", "which", "do", "does", "did", "should", "would", "could",
}
TOK_RE = re.compile(r"[A-Za-z][A-Za-z0-9\-_/]{2,}")


def _norm_pattern(task: str) -> str:
    """Collapse a task into a short keyword signature — same shape repeats
    cluster together in the top-N. Lowercased non-stopword tokens, sorted,
    capped at 6 to keep clusters tight."""
    toks = [t.lower() for t in TOK_RE.findall(task or "")]
    toks = [t for t in toks if t not in STOPWORDS]
    if not toks:
        return "(empty)"
    return " ".join(sorted(set(toks))[:6])


def aggregate(top: int = 10) -> dict:
    if not MISSES_PATH.is_file():
        return {
            "miss_log_path": str(MISSES_PATH),
            "exists": False,
            "total": 0,
            "by_reason": {},
            "top_patterns": [],
            "first_seen": None,
            "last_seen": None,
        }

    total = 0
    by_reason: Counter[str] = Counter()
    pattern_counts: Counter[str] = Counter()
    pattern_examples: dict[str, str] = {}
    pattern_last_seen: dict[str, str] = {}
    first_seen: str | None = None
    last_seen: str | None = None

    try:
        with MISSES_PATH.open("r", encoding="utf-8") as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                total += 1
                reason = (rec.get("error") or "unknown").split(":", 1)[0]
                by_reason[reason] += 1
                task = rec.get("task_summary") or ""
                ts = rec.get("timestamp") or ""
                if ts:
                    if first_seen is None or ts < first_seen:
                        first_seen = ts
                    if last_seen is None or ts > last_seen:
                        last_seen = ts
                pat = _norm_pattern(task)
                pattern_counts[pat] += 1
                pattern_last_seen[pat] = ts or pattern_last_seen.get(pat, "")
                pattern_examples.setdefault(pat, task[:140])
    except OSError:
        # Fail-open on read errors.
        pass

    top_patterns = [
        {
            "pattern": pat,
            "count": cnt,
            "last_seen": pattern_last_seen.get(pat, ""),
            "example": pattern_examples.get(pat, ""),
        }
        for pat, cnt in pattern_counts.most_common(top)
    ]

    return {
        "miss_log_path": str(MISSES_PATH),
        "exists": True,
        "total": total,
        "by_reason": dict(by_reason),
        "top_patterns": top_patterns,
        "first_seen": first_seen,
        "last_seen": last_seen,
    }


def render_text(report: dict) -> str:
    lines = []
    lines.append(f"Skill-discovery misses — {report['miss_log_path']}")
    if not report["exists"]:
        lines.append("(no miss log yet; nothing to aggregate)")
        return "\n".join(lines) + "\n"
    lines.append(f"Total misses : {report['total']}")
    if report["first_seen"] or report["last_seen"]:
        lines.append(f"Window       : {report['first_seen']} → {report['last_seen']}")
    if report["by_reason"]:
        lines.append("By reason    :")
        for k, v in sorted(report["by_reason"].items(), key=lambda kv: -kv[1]):
            lines.append(f"  - {k:32s} {v}")
    if report["top_patterns"]:
        lines.append(f"Top {len(report['top_patterns'])} patterns (signature = sorted unique keywords):")
        for p in report["top_patterns"]:
            lines.append(f"  [{p['count']:4d}]  {p['pattern']}")
            if p["example"]:
                lines.append(f"          e.g. {p['example']}")
            if p["last_seen"]:
                lines.append(f"          last seen: {p['last_seen']}")
    else:
        lines.append("No patterns recorded.")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Aggregate skill-discovery miss log")
    parser.add_argument("--top", type=int, default=10, help="Top N patterns (default 10)")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of text")
    args = parser.parse_args()

    try:
        report = aggregate(top=args.top)
    except Exception as exc:  # fail-open
        print(f"skill-discovery-misses: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 0

    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        sys.stdout.write(render_text(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
