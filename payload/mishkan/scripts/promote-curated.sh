#!/usr/bin/env bash
# MISHKAN — promote ONE approved candidate into the curated library (D-016).
# Additive: never prunes, dedups by url, appends to the promoted ledger on success.
#
# Usage:
#   promote-curated.sh <candidate.json>
#
# <candidate.json> is one curated_promotion_candidate object
# (name, url, problem_class, team, source_tier, why) — the shape Baruch queues
# into ~/.claude/mishkan/curated-candidates.jsonl and the CLI hands here on approval.
#
# Exit codes:
#   0  → promoted (or already present — dedup skip; both are "nothing left to do")
#   1  → invalid input / write failed
#   2  → environment problem (jq missing, curated container down)
#
# This is a STATEFUL step (docker exec into the curated stack). It is invoked by
# `mishkan knowledge curate`, which a human runs — never an agent (rule 5 / D-005).
set -euo pipefail

CANDIDATE="${1:-}"
if [[ -z "$CANDIDATE" || ! -r "$CANDIDATE" ]]; then
  echo "usage: $(basename "$0") <candidate.json>" >&2
  exit 1
fi
command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 2; }

MISHKAN="${HOME}/.claude/mishkan"
SEED_MANIFEST="${MISHKAN}/cognee/curated-resources.jsonl"     # written by seed-curated-library.sh
PROMOTED_LEDGER="${MISHKAN}/cognee/curated-promoted.jsonl"    # this script's append-only record
PROMOTE_PY="${MISHKAN}/cognee/promote-curated.py"
CONTAINER="${COGNEE_CONTAINER:-mishkan-curated-mcp}"
CTR_CAND="/home/cognee/curated-candidate.json"
CTR_PY="/home/cognee/promote-curated.py"

# Validate the candidate shape (mirror the schema's inner contract).
url=$(jq -r '.url // ""' "$CANDIDATE")
name=$(jq -r '.name // ""' "$CANDIDATE")
team=$(jq -r '.team // ""' "$CANDIDATE")
if [[ -z "$url" || -z "$name" || -z "$team" ]]; then
  echo "error: candidate missing one of name/url/team" >&2
  exit 1
fi

# Dedup by url against the seed manifest AND the promoted ledger. Curated writes
# are owned by these scripts, so the union of the two files is authoritative.
already_curated() {
  local f="$1"
  [[ -r "$f" ]] || return 1
  jq -r '.url // empty' "$f" 2>/dev/null | grep -Fxq -- "$url"
}
if already_curated "$SEED_MANIFEST" || already_curated "$PROMOTED_LEDGER"; then
  echo "skip: '${url}' is already in the curated library (dedup) — nothing written."
  exit 0
fi

# The write is stateful — the container must be up.
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "${CONTAINER}"; then
  echo "error: curated container '${CONTAINER}' not running — bring the stack up first" >&2
  echo "       (mishkan knowledge-stack up), then re-approve." >&2
  exit 2
fi
[[ -r "$PROMOTE_PY" ]] || { echo "error: promote script missing: $PROMOTE_PY" >&2; exit 2; }

echo "Promoting into ${CONTAINER} (additive — no prune): ${name}"
docker cp "$CANDIDATE"  "${CONTAINER}:${CTR_CAND}"
docker cp "$PROMOTE_PY" "${CONTAINER}:${CTR_PY}"
if docker exec -i -w /app/cognee-mcp "${CONTAINER}" uv run python -u "${CTR_PY}"; then
  mkdir -p "$(dirname "$PROMOTED_LEDGER")"
  jq -c . "$CANDIDATE" >> "$PROMOTED_LEDGER"
  echo "Promoted. Ledger updated: ${PROMOTED_LEDGER}"
  echo "Verify: MATCH (r:CuratedResource {url: \"${url}\"}) RETURN r;"
  exit 0
else
  echo "error: additive write failed inside ${CONTAINER} — curated left unchanged" >&2
  exit 1
fi
