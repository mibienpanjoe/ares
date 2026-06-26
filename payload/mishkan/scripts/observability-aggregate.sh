#!/usr/bin/env bash
# MISHKAN — observability aggregation.
# Reads logs/*.jsonl (raw PostToolUse events), computes per-tool and per-outcome
# counts plus per-session activity, and writes a summary the improvement layer
# reads. Triggered by /sprint-close.
#
# Raw events carry tool/outcome/session/timestamp; agent/team/sprint/token fields
# are enriched here where derivable and left null otherwise (hook payload limit).
set -euo pipefail

runtime_home() {
  if [[ -n "${ARES_HOME:-}" ]]; then printf '%s' "$ARES_HOME"; return; fi
  if [[ -n "${MISHKAN_HOME:-}" ]]; then printf '%s' "$MISHKAN_HOME"; return; fi
  if [[ -d "$HOME/.ares" || ! -d "$HOME/.claude/mishkan" ]]; then printf '%s' "$HOME/.ares"; return; fi
  printf '%s' "$HOME/.claude/mishkan"
}
ARES_HOME_RES="$(runtime_home)"
LOG_DIR="${ARES_LOG_DIR:-${MISHKAN_LOG_DIR:-${ARES_HOME_RES}/logs}}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${LOG_DIR}/aggregate-${TS}.json"

command -v python3 >/dev/null 2>&1 || { echo "python3 required" >&2; exit 1; }
mkdir -p "$LOG_DIR"

python3 - "$LOG_DIR" "$OUT" <<'PY'
import sys, json, glob, os
from collections import Counter, defaultdict
log_dir, out_path = sys.argv[1], sys.argv[2]
tool_counts = Counter()
outcome_counts = Counter()
per_session = defaultdict(int)
total = 0
for f in glob.glob(os.path.join(log_dir, "*.jsonl")):
    if os.path.basename(f).startswith(("aggregate-", "milestones")):
        continue
    for line in open(f):
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        total += 1
        for t in e.get("tool_calls", []):
            tool_counts[t] += 1
        outcome_counts[e.get("outcome", "unknown")] += 1
        per_session[e.get("session", "unknown")] += 1
summary = {
    "generated": os.path.basename(out_path),
    "total_events": total,
    "tool_calls": dict(tool_counts.most_common()),
    "outcomes": dict(outcome_counts),
    "sessions": dict(per_session),
    "note": "agent/team/sprint/token enrichment pending Cognee-side join; raw hook payload lacks them.",
}
json.dump(summary, open(out_path, "w"), indent=2)
print(f"aggregated {total} events -> {out_path}")
print("top tools:", dict(tool_counts.most_common(5)))
PY

echo "Summary written. Push to Cognee as Sprint/Agent metric nodes once the"
echo "container is up (see config/improvement-queries.md for the queries it feeds)."
