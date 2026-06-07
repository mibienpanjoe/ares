#!/usr/bin/env bash
# skill-discovery-smoke — end-to-end smoke test for the discovery layer.
#
# Runs the indexer against the harness payload itself (so we don't depend
# on a live ~/.claude/mishkan install), asserts non-zero entry count,
# runs the router on a known query, asserts a non-empty bucket result.
#
# Exit codes:
#   0  all assertions pass
#   1  setup failure
#   2  indexer assertion failure
#   3  router assertion failure
#
# stdlib only, fail-fast. Safe to run anywhere — uses a temp HOME so it
# never touches the real ~/.claude tree.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
INDEXER="$HERE/skill-discovery-indexer.py"
ROUTER="$HERE/skill-discovery-router.py"

if [[ ! -f "$INDEXER" ]]; then
  echo "smoke: indexer missing at $INDEXER" >&2
  exit 1
fi
if [[ ! -f "$ROUTER" ]]; then
  echo "smoke: router missing at $ROUTER" >&2
  exit 1
fi

# Set up a fake HOME so we point the indexer at the harness payload as if
# it were ~/.claude/mishkan/skills/.
TMPHOME="$(mktemp -d)"
trap 'rm -rf "$TMPHOME"' EXIT

mkdir -p "$TMPHOME/.claude/mishkan"
ln -s "$REPO_ROOT/payload/mishkan/skills" "$TMPHOME/.claude/mishkan/skills"

export HOME="$TMPHOME"

echo "smoke: running indexer (--rebuild) against harness payload..."
INDEX_OUT="$(python3 "$INDEXER" --rebuild --cwd "$REPO_ROOT")"
echo "smoke: indexer output: $INDEX_OUT"

INDEX_PATH="$TMPHOME/.claude/mishkan/skill-discovery/index.json"
if [[ ! -f "$INDEX_PATH" ]]; then
  echo "smoke: FAIL — index.json was not written at $INDEX_PATH" >&2
  exit 2
fi

COUNT="$(python3 -c "import json,sys; p=json.load(open('$INDEX_PATH')); print(p['meta']['count'])")"
echo "smoke: indexed entries: $COUNT"
if [[ "$COUNT" -lt 5 ]]; then
  echo "smoke: FAIL — expected at least 5 entries, got $COUNT" >&2
  exit 2
fi

echo "smoke: running router on a known query..."
ROUTER_OUT="$(python3 "$ROUTER" --task "Write the architecture document for a new project: bounded contexts, data flow, failure modes." --workflow mishkan-init --relevant-categories craft,mishkan-workflow,docs)"
echo "$ROUTER_OUT" | python3 -m json.tool >/dev/null || {
  echo "smoke: FAIL — router output is not valid JSON" >&2
  echo "$ROUTER_OUT" >&2
  exit 3
}

TOTAL="$(echo "$ROUTER_OUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['total_returned'])")"
echo "smoke: router total_returned: $TOTAL"
if [[ "$TOTAL" -lt 1 ]]; then
  echo "smoke: FAIL — router returned empty buckets for a clearly matching query" >&2
  echo "$ROUTER_OUT" >&2
  exit 3
fi

# Hard cap check
if [[ "$TOTAL" -gt 13 ]]; then
  echo "smoke: FAIL — router exceeded the 13-entry cap ($TOTAL)" >&2
  exit 3
fi

echo "smoke: indexer + router OK ($COUNT entries indexed, $TOTAL surfaced)."

# -----------------------------------------------------------------------------
# Phase 2 smoke — --format injection + PreToolUse hook timing.
# -----------------------------------------------------------------------------

echo "smoke: Phase 2 — --format injection (non-empty case)..."
INJ_GOOD="$(python3 "$ROUTER" \
  --task "Write the architecture document for a new project: bounded contexts, data flow, failure modes." \
  --workflow mishkan-init \
  --relevant-categories craft,mishkan-workflow,docs \
  --format injection 2>/dev/null || true)"
if [[ -z "$INJ_GOOD" ]]; then
  echo "smoke: FAIL — --format injection produced empty output for a known-good query" >&2
  exit 3
fi
if ! printf '%s' "$INJ_GOOD" | grep -q "Discovered skills (advisory)"; then
  echo "smoke: FAIL — injection block missing the advisory header" >&2
  printf '%s\n' "$INJ_GOOD" >&2
  exit 3
fi
# Hard cap check: 600 tokens ≈ 2400 chars rule-of-thumb. Allow some slack
# (3000) — what we're guarding against is unbounded growth, not the exact
# token count which depends on Claude's tokeniser.
INJ_LEN=${#INJ_GOOD}
if (( INJ_LEN > 3000 )); then
  echo "smoke: FAIL — injection block exceeded the soft char cap ($INJ_LEN > 3000)" >&2
  exit 3
fi
echo "smoke: injection block OK ($INJ_LEN chars)"

echo "smoke: Phase 2 — --format injection (empty-bucket case)..."
# A task with no plausible match anywhere in the harness skill set. We use
# a string of gibberish unlikely to score on any trigger or description.
INJ_BAD="$(python3 "$ROUTER" \
  --task "xqzzv frobnitz blortwhomp threnody unicorn snorblat" \
  --format injection 2>/dev/null || true)"
if [[ -n "$INJ_BAD" ]]; then
  echo "smoke: FAIL — --format injection produced output for an empty-bucket query" >&2
  echo "  Got: $INJ_BAD" >&2
  exit 3
fi
echo "smoke: empty-bucket injection produces no output (correct)"

# -----------------------------------------------------------------------------
# PreToolUse hook timing — verify the auto-injection hook completes under
# the 100 ms p95 contract on a known-good query. We measure the worst of
# 5 runs (cold + warm) and fail at > 250 ms to give CI headroom on slow
# runners; the design target is 100 ms p95.
# -----------------------------------------------------------------------------

HOOK="$REPO_ROOT/payload/mishkan/hooks/pre-tool-task-skill-route.sh"
if [[ -f "$HOOK" && $(command -v jq >/dev/null 2>&1 && echo y) == "y" ]]; then
  echo "smoke: Phase 2 — PreToolUse hook timing..."
  HOOK_PAYLOAD='{"session_id":"smoke","tool_name":"Task","tool_input":{"prompt":"Write the architecture document for a new project: bounded contexts, data flow, failure modes."}}'
  MAX_MS=0
  for i in 1 2 3 4 5; do
    T0=$(python3 -c "import time;print(int(time.time()*1000))")
    printf '%s' "$HOOK_PAYLOAD" | bash "$HOOK" >/dev/null 2>&1 || true
    T1=$(python3 -c "import time;print(int(time.time()*1000))")
    DT=$(( T1 - T0 ))
    echo "  run $i: ${DT} ms"
    (( DT > MAX_MS )) && MAX_MS=$DT
  done
  if (( MAX_MS > 250 )); then
    echo "smoke: FAIL — hook worst-of-5 ${MAX_MS} ms exceeds the 250 ms CI ceiling (target 100 ms p95)" >&2
    exit 3
  fi
  echo "smoke: PreToolUse hook OK (worst-of-5: ${MAX_MS} ms)"
else
  echo "smoke: PreToolUse hook timing skipped (jq missing or hook absent)"
fi

echo "smoke: Phase 2 assertions OK."
exit 0
