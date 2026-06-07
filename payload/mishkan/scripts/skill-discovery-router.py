#!/usr/bin/env python3
"""
skill-discovery-router — read index.json, score skills for a task, emit 3 buckets.

Matching mechanisms (in this order, combined):
  1. Trigger-phrase match — substring-tokenize task; weighted hits
                            (trigger phrase = 3.0, description keyword = 1.0).
  2. Category prior      — when invoked from inside a workflow with a
                            relevant_skill_categories filter, hits in those
                            categories multiplied by 1.5.
  3. TF-IDF fallback     — pure-stdlib TF-IDF over (description + triggers).
                            Used to *augment* trigger results when trigger
                            matches yield fewer than 3 entries.

Output JSON shape (stdout):
    {
      "task_summary": "...",
      "must_load":        [ {name, score, origin, category, source_path}, ... ]  // ≤ 3
      "should_consider":  [ ... ]  // ≤ 5
      "adjacent":         [ ... ]  // ≤ 5
      "total_returned":   <int <= 13>,
      "warnings":         [ "stale_entry_dropped: <name>", ... ],
      "stale_rebuild_needed": <bool>
    }

Fail-open: any error → empty buckets, miss logged, exit 0.

Stdlib only.

CLI:
    python3 skill-discovery-router.py --task "<task description>"
                                      [--workflow <name>]
                                      [--relevant-categories cat1,cat2]
                                      [--threshold-high N]
                                      [--threshold-mid M]
                                      [--limit 13]
                                      [--json]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from collections import Counter
from pathlib import Path

HOME = Path(os.path.expanduser("~"))
INDEX_DIR = HOME / ".claude" / "mishkan" / "skill-discovery"
INDEX_PATH = INDEX_DIR / "index.json"
MISSES_PATH = INDEX_DIR / "misses.jsonl"

STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with",
    "this", "that", "is", "are", "be", "by", "as", "at", "it", "its", "from",
    "into", "i", "we", "you", "your", "my", "our", "use", "using", "when",
    "how", "what", "which", "do", "does", "did", "should", "would", "could",
    "have", "has", "had", "but", "not", "no", "yes", "if", "else", "then",
    "can", "will", "may", "make", "made", "than", "so", "such", "also",
}

TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9\-_/]{1,}")


def tokenize(text: str) -> list[str]:
    out: list[str] = []
    for raw in TOKEN_RE.findall(text or ""):
        t = raw.lower().strip("-_/")
        if not t or t in STOPWORDS or len(t) < 2:
            continue
        out.append(t)
    return out


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _log_miss(task: str, reason: str) -> None:
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    rec = {
        "task_summary": (task or "")[:500],
        "error": reason,
        "timestamp": _now_iso(),
    }
    try:
        with MISSES_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass


def load_index() -> dict | None:
    if not INDEX_PATH.is_file():
        return None
    try:
        return json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

TRIGGER_WEIGHT = 3.0
KEYWORD_WEIGHT = 1.0
CATEGORY_MULTIPLIER = 1.5


def score_trigger(entry: dict, task_tokens: set[str], task_text_low: str) -> float:
    """Substring/token weighted match on triggers + description."""
    score = 0.0
    # Triggers: each trigger phrase contributes once if any of its tokens hit
    for trig in entry.get("triggers", []) or []:
        trig_low = (trig or "").lower()
        trig_tokens = set(tokenize(trig))
        if not trig_tokens:
            continue
        # Substring hit (whole phrase in task text) → full weight
        if len(trig_low) >= 6 and trig_low in task_text_low:
            score += TRIGGER_WEIGHT
            continue
        overlap = trig_tokens & task_tokens
        if overlap:
            # Proportional: full weight if half-or-more of trigger tokens hit
            ratio = len(overlap) / max(1, len(trig_tokens))
            score += TRIGGER_WEIGHT * min(1.0, ratio * 2.0)
    # Description keywords
    desc_tokens = set(tokenize(entry.get("description", "")))
    if desc_tokens:
        overlap = desc_tokens & task_tokens
        score += KEYWORD_WEIGHT * len(overlap)
    # Name match — small bonus
    name_tokens = set(tokenize(entry.get("name", "").replace("-", " ")))
    if name_tokens & task_tokens:
        score += KEYWORD_WEIGHT * 0.5 * len(name_tokens & task_tokens)
    return score


def build_tfidf(entries: list[dict]) -> tuple[dict[str, float], list[set[str]]]:
    """IDF map + per-entry token sets (already lowercased)."""
    n = len(entries)
    df: Counter[str] = Counter()
    docs: list[set[str]] = []
    for e in entries:
        toks = set(tokenize(e.get("description", "") + " " + " ".join(e.get("triggers", []) or []) + " " + e.get("name", "")))
        docs.append(toks)
        for t in toks:
            df[t] += 1
    idf = {t: math.log((1 + n) / (1 + c)) + 1.0 for t, c in df.items()}
    return idf, docs


def score_tfidf(task_tokens: list[str], idf: dict[str, float], doc_tokens: set[str]) -> float:
    if not doc_tokens:
        return 0.0
    tf = Counter(task_tokens)
    score = 0.0
    for t, count in tf.items():
        if t in doc_tokens:
            score += count * idf.get(t, 0.0)
    return score


# ---------------------------------------------------------------------------
# Main routing
# ---------------------------------------------------------------------------

def route(
    task: str,
    relevant_categories: list[str] | None = None,
    workflow: str | None = None,
    threshold_high: float = 4.0,
    threshold_mid: float = 1.5,
    limit: int = 13,
) -> dict:
    payload = load_index()
    warnings: list[str] = []

    if payload is None:
        _log_miss(task, "index_missing_or_unreadable")
        return {
            "task_summary": task,
            "must_load": [], "should_consider": [], "adjacent": [],
            "total_returned": 0,
            "warnings": ["index_missing_or_unreadable — run /mishkan-skills-reindex"],
            "stale_rebuild_needed": True,
        }

    entries = payload.get("entries", []) or []

    # Stale-index protection: drop entries whose source_path no longer exists.
    live: list[dict] = []
    stale_rebuild_needed = False
    for e in entries:
        sp = e.get("source_path")
        if sp and Path(sp).exists():
            live.append(e)
        else:
            stale_rebuild_needed = True
            warnings.append(f"stale_entry_dropped:{e.get('name')}")
    entries = live

    if not entries:
        _log_miss(task, "no_live_entries")
        return {
            "task_summary": task,
            "must_load": [], "should_consider": [], "adjacent": [],
            "total_returned": 0,
            "warnings": warnings or ["no_live_entries"],
            "stale_rebuild_needed": True,
        }

    task_text_low = (task or "").lower()
    task_tokens_list = tokenize(task)
    task_tokens = set(task_tokens_list)

    cat_set = {c.strip().lower() for c in (relevant_categories or []) if c.strip()}

    # Pass 1: trigger + description scoring
    scored: list[tuple[float, dict, dict]] = []
    for e in entries:
        s = score_trigger(e, task_tokens, task_text_low)
        if cat_set and (e.get("category", "").lower() in cat_set):
            s *= CATEGORY_MULTIPLIER
        scored.append((s, e, {"trigger_score": s}))

    above_trigger = [(s, e, m) for (s, e, m) in scored if s > 0]
    above_trigger.sort(key=lambda x: x[0], reverse=True)

    # Pass 2: TF-IDF fallback when trigger results thin
    if len(above_trigger) < 3:
        idf, docs = build_tfidf(entries)
        tfidf_scored: list[tuple[float, dict]] = []
        for e, dtoks in zip(entries, docs):
            ts = score_tfidf(task_tokens_list, idf, dtoks)
            if cat_set and (e.get("category", "").lower() in cat_set):
                ts *= CATEGORY_MULTIPLIER
            tfidf_scored.append((ts, e))
        tfidf_scored.sort(key=lambda x: x[0], reverse=True)
        # Inject top TF-IDF entries that aren't already in above_trigger,
        # mapped to a lower-weighted comparable score.
        existing = {id(e) for _s, e, _m in above_trigger}
        max_tfidf = tfidf_scored[0][0] if tfidf_scored else 0.0
        for ts, e in tfidf_scored:
            if id(e) in existing or ts <= 0:
                continue
            # Normalise TF-IDF onto the trigger-score scale (cap below threshold_high
            # so trigger hits always rank above pure TF-IDF unless very strong).
            normalised = (ts / max_tfidf) * (threshold_high - 0.5) if max_tfidf else 0.0
            above_trigger.append((normalised, e, {"trigger_score": 0.0, "tfidf_score": ts, "tfidf_normalised": normalised}))
        above_trigger.sort(key=lambda x: x[0], reverse=True)

    # Bucket
    must_load: list[dict] = []
    should_consider: list[dict] = []
    adjacent: list[dict] = []

    for s, e, meta in above_trigger:
        item = {
            "name": e.get("name"),
            "score": round(float(s), 3),
            "origin": e.get("origin"),
            "category": e.get("category"),
            "source_path": e.get("source_path"),
            "description": e.get("description"),
            "triggers": e.get("triggers", [])[:3],
        }
        # Mark non-mishkan origin for trust-asymmetry awareness
        if e.get("origin") != "mishkan":
            item["trust"] = f"third-party ({e.get('origin')}); not auto-loadable for stateful operations"
        item["score_breakdown"] = meta
        if s >= threshold_high and len(must_load) < 3:
            must_load.append(item)
        elif s >= threshold_mid and len(should_consider) < 5:
            should_consider.append(item)
        else:
            if len(adjacent) < 5:
                adjacent.append(item)

    # If buckets all empty, log miss
    if not (must_load or should_consider or adjacent):
        _log_miss(task, "no_match_above_threshold")
        warnings.append("no_match_above_threshold")

    total = len(must_load) + len(should_consider) + len(adjacent)
    # Enforce hard cap of 13 (sum of caps already 13, but trim defensively)
    if total > limit:
        # Trim adjacent first, then should_consider
        while total > limit and adjacent:
            adjacent.pop()
            total -= 1
        while total > limit and should_consider:
            should_consider.pop()
            total -= 1

    return {
        "task_summary": task,
        "must_load": must_load,
        "should_consider": should_consider,
        "adjacent": adjacent,
        "total_returned": total,
        "warnings": warnings,
        "stale_rebuild_needed": stale_rebuild_needed,
        "workflow": workflow,
        "relevant_categories": sorted(cat_set) or None,
        "thresholds": {"high": threshold_high, "mid": threshold_mid},
    }


def _truncate_desc(s: str, n: int = 110) -> str:
    s = re.sub(r"\s+", " ", (s or "").strip())
    if len(s) <= n:
        return s
    return s[: n - 1].rstrip() + "…"


def render_injection(result: dict, max_tokens: int = 600) -> str:
    """Render the 3-bucket router result as a compact advisory markdown block.

    Hard caps for Phase 2 auto-injection: 3 must_load + 3 should_consider,
    adjacent is dropped (it's awareness-only and would pad without justifying
    its tokens at injection time).

    Trust marker preserved: non-mishkan entries get a `(community)` suffix.

    Returns "" when every relevant bucket is empty — the caller should then
    skip injection entirely rather than prepending "no skills found".

    Token budget enforced naively: 4 chars ≈ 1 token rule of thumb. If the
    rendered block exceeds the budget, drop should_consider entries first.
    """
    must = (result.get("must_load") or [])[:3]
    cons = (result.get("should_consider") or [])[:3]
    if not must and not cons:
        return ""

    def _line(item: dict) -> str:
        name = item.get("name", "")
        desc = _truncate_desc(item.get("description", ""))
        suffix = "" if item.get("origin") == "mishkan" else " (community)"
        return f"- {name}{suffix}: {desc}"

    parts: list[str] = ["## Discovered skills (advisory)", ""]
    if must:
        parts.append("**Load now (high relevance):**")
        for it in must:
            parts.append(_line(it))
        parts.append("")
    if cons:
        parts.append("**Consider:**")
        for it in cons:
            parts.append(_line(it))
        parts.append("")
    parts.append(
        "These skills were surfaced by the harness's skill-discovery router. "
        "Loading is your call."
    )
    block = "\n".join(parts).rstrip() + "\n"

    # Hard-cap by token estimate; drop should_consider lines tail-first.
    budget_chars = max_tokens * 4
    while len(block) > budget_chars and cons:
        cons.pop()
        parts = ["## Discovered skills (advisory)", ""]
        if must:
            parts.append("**Load now (high relevance):**")
            for it in must:
                parts.append(_line(it))
            parts.append("")
        if cons:
            parts.append("**Consider:**")
            for it in cons:
                parts.append(_line(it))
            parts.append("")
        parts.append(
            "These skills were surfaced by the harness's skill-discovery router. "
            "Loading is your call."
        )
        block = "\n".join(parts).rstrip() + "\n"
    return block


def main() -> int:
    parser = argparse.ArgumentParser(description="Skill-discovery router (advisory)")
    parser.add_argument("--task", default=None, help="Task description; if absent, read from stdin")
    parser.add_argument("--workflow", default=None)
    parser.add_argument("--relevant-categories", default=None,
                        help="Comma-separated category names to boost ×1.5")
    parser.add_argument("--threshold-high", type=float, default=4.0)
    parser.add_argument("--threshold-mid", type=float, default=1.5)
    parser.add_argument("--limit", type=int, default=13)
    parser.add_argument("--json", action="store_true", help="(default) emit JSON")
    parser.add_argument("--format", choices=("json", "injection"), default="json",
                        help="json (default, full router output) | injection "
                             "(compact markdown for PreToolUse hook prepend)")
    parser.add_argument("--max-injection-tokens", type=int, default=600,
                        help="Hard cap for --format injection (default 600)")
    args = parser.parse_args()

    task = args.task
    if not task:
        task = sys.stdin.read().strip()
    if not task:
        # fail-open: empty task → empty buckets / empty injection
        if args.format == "injection":
            return 0
        out = {
            "task_summary": "",
            "must_load": [], "should_consider": [], "adjacent": [],
            "total_returned": 0,
            "warnings": ["empty_task"],
            "stale_rebuild_needed": False,
        }
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return 0

    cats = None
    if args.relevant_categories:
        cats = [c.strip() for c in args.relevant_categories.split(",") if c.strip()]

    try:
        result = route(
            task=task,
            relevant_categories=cats,
            workflow=args.workflow,
            threshold_high=args.threshold_high,
            threshold_mid=args.threshold_mid,
            limit=args.limit,
        )
    except Exception as exc:
        _log_miss(task, f"router_exception: {type(exc).__name__}: {exc}")
        result = {
            "task_summary": task,
            "must_load": [], "should_consider": [], "adjacent": [],
            "total_returned": 0,
            "warnings": [f"router_exception: {type(exc).__name__}"],
            "stale_rebuild_needed": False,
        }

    if args.format == "injection":
        block = render_injection(result, max_tokens=args.max_injection_tokens)
        if block:
            sys.stdout.write(block)
        return 0

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
