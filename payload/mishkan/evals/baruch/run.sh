#!/usr/bin/env bash
# evals/baruch/run.sh — exercise the Baruch contract end-to-end.
#
# Three checks, each independent:
#   1. Every fixture under fixtures/valid/   must validate (exit 0).
#   2. Every fixture under fixtures/invalid/ must fail validation (exit 1).
#   3. The golden case's produced.json must validate AND satisfy every
#      jq assertion in golden_case/expected.yaml.
#
# Exit codes:
#   0  → all checks passed.
#   1  → one or more checks failed.
#   2  → environment problem (missing jq, missing validator, missing schema).
#
# This eval does NOT run Baruch live. It validates the contract and
# the golden output. To exercise Baruch's reasoning, swap produced.json
# for a fresh run's output and re-run.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR_CANDIDATES=(
  "${MISHKAN_HOME:-$HOME/.claude/mishkan}/scripts/validate-research-log.sh"
  "$HERE/../../scripts/validate-research-log.sh"
)
VALIDATOR=""
for c in "${VALIDATOR_CANDIDATES[@]}"; do
  if [[ -x "$c" ]]; then VALIDATOR="$c"; break; fi
done
if [[ -z "$VALIDATOR" ]]; then
  echo "error: validate-research-log.sh not found in any known location" >&2
  printf '  searched: %s\n' "${VALIDATOR_CANDIDATES[@]}" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 2
fi

PASS=0
FAIL=0
SKIP=0

pass() { printf "  ✓ %s\n" "$1"; PASS=$((PASS+1)); }
fail() { printf "  ✗ %s — %s\n" "$1" "$2"; FAIL=$((FAIL+1)); }

# --- Check 1: valid fixtures must validate -----------------------------
echo "[1/3] Valid fixtures must validate (expect exit 0)"
shopt -s nullglob
valid_count=0
for f in "$HERE/fixtures/valid"/*.json; do
  valid_count=$((valid_count+1))
  name="$(basename "$f")"
  if out=$("$VALIDATOR" "$f" 2>&1); then
    pass "$name"
  else
    fail "$name" "validator rejected a known-good fixture: $out"
  fi
done
[[ $valid_count -eq 0 ]] && echo "  (no fixtures found)" && SKIP=$((SKIP+1))

# --- Check 2: invalid fixtures must fail validation --------------------
echo "[2/3] Invalid fixtures must fail validation (expect exit 1)"
invalid_count=0
for f in "$HERE/fixtures/invalid"/*.json; do
  invalid_count=$((invalid_count+1))
  name="$(basename "$f")"
  out=$("$VALIDATOR" "$f" 2>&1)
  rc=$?
  if [[ $rc -eq 1 ]]; then
    pass "$name (rejected as expected)"
  elif [[ $rc -eq 0 ]]; then
    fail "$name" "validator accepted a known-bad fixture"
  else
    fail "$name" "validator returned $rc (expected 1)"
  fi
done
[[ $invalid_count -eq 0 ]] && echo "  (no fixtures found)" && SKIP=$((SKIP+1))

# --- Check 3: golden case — schema valid + semantic assertions ---------
echo "[3/3] Golden case must validate and satisfy semantic assertions"
GC="$HERE/golden_case/produced.json"
EXPECT="$HERE/golden_case/expected.yaml"

if [[ ! -r "$GC" ]]; then
  fail "golden_case/produced.json" "missing or unreadable"
elif [[ ! -r "$EXPECT" ]]; then
  fail "golden_case/expected.yaml" "missing or unreadable"
else
  if out=$("$VALIDATOR" "$GC" 2>&1); then
    pass "produced.json passes schema validation"
  else
    fail "produced.json" "did not pass schema validation: $out"
  fi

  # Each non-blank, non-comment line in expected.yaml is `<jq filter>: <expected>`.
  # The expected side is YAML-ish JSON (string, number, true, false, JSON array).
  while IFS= read -r raw; do
    line="${raw%%#*}"                                  # strip inline comments
    line="$(echo "$line" | sed -e 's/[[:space:]]*$//')"
    [[ -z "$line" ]] && continue
    filter="$(echo "$line" | sed -E 's/:[[:space:]]*[^:]*$//')"
    expected_raw="$(echo "$line" | sed -E 's/^.*:[[:space:]]*//')"
    filter="${filter#\"}"; filter="${filter%\"}"

    # Normalise expected_raw to canonical JSON for comparison.
    if expected_json=$(echo "$expected_raw" | jq -c . 2>/dev/null); then
      :
    else
      # bare word like `true` / `false` / unquoted string — wrap as JSON string
      expected_json=$(jq -nc --arg v "$expected_raw" '$v')
    fi

    if actual_json=$(jq -c "$filter" "$GC" 2>/dev/null); then
      if [[ "$actual_json" == "$expected_json" ]]; then
        pass "assertion: $filter"
      else
        fail "assertion: $filter" "expected $expected_json, got $actual_json"
      fi
    else
      fail "assertion: $filter" "jq filter errored"
    fi
  done < "$EXPECT"
fi

# --- Summary ----------------------------------------------------------
echo
echo "Summary: $PASS passed, $FAIL failed, $SKIP skipped sections"
[[ $FAIL -eq 0 ]]
