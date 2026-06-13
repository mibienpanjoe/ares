#!/usr/bin/env bash
# MISHKAN — full knowledge-data reset to the stable baseline ("restart from scratch").
# Wipes ALL per-project work stores (container + data volume), prunes the shared
# cognee-memory store (:7777), and re-seeds the curated library (:7730) from the
# canonical YAML. End-state = a fresh, reproducible knowledge layer; also disposes
# of any leaked/test data sitting in the graphs.
#
# DESTRUCTIVE and IRREVERSIBLE. Stateful (docker rm / docker exec): a human runs
# this — never an agent (rule 5 / D-005). Work stores recreate on the next
# /mishkan-init; memory is session-scoped; curated re-seeds from config.
#
# Usage:  mishkan knowledge reset        (interactive type-to-confirm)
#         bash reset-knowledge-data.sh --yes   (skip the prompt — scripted use)
#
# Exit: 0 ok / aborted · 2 environment problem (docker/scripts missing).
set -euo pipefail

MISHKAN="${HOME}/.claude/mishkan"
PRUNE_PY="${MISHKAN}/cognee/prune-store.py"
SEED="${MISHKAN}/scripts/seed-curated-library.sh"
MEM_CONTAINER="${COGNEE_MEMORY_CONTAINER:-mishkan-cognee-mcp}"
CTR_PRUNE="/home/cognee/prune-store.py"

command -v docker >/dev/null 2>&1 || { echo "docker required" >&2; exit 2; }

# Inventory what will be destroyed (work stores).
mapfile -t WORK < <(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^mishkan-work-' || true)

echo "This RESETS the MISHKAN knowledge layer to a clean baseline:"
echo "  • wipe ${#WORK[@]} work store(s): ${WORK[*]:-(none)}   (containers + *_work_data volumes)"
echo "  • prune cognee-memory (${MEM_CONTAINER}) — all session memory"
echo "  • re-seed curated (${COGNEE_CONTAINER:-mishkan-curated-mcp}) from config/curated-library.yaml"
echo "    (the seed is prune-then-write: curated is reset to the stable ~96-node baseline)"
echo
if [[ "${1:-}" != "--yes" ]]; then
  read -r -p 'Type RESET to proceed (anything else aborts): ' ans
  [[ "$ans" == "RESET" ]] || { echo "aborted."; exit 0; }
fi

# 1. Wipe all per-project work stores (container + data volume).
if ((${#WORK[@]})); then
  for c in "${WORK[@]}"; do
    echo ">> removing work store ${c}"
    docker rm -f "$c" >/dev/null 2>&1 || true
    docker volume rm "${c}_work_data" >/dev/null 2>&1 || echo "   (volume ${c}_work_data already gone)"
  done
else
  echo ">> no work stores to remove"
fi

# 2. Prune the shared cognee-memory store.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "${MEM_CONTAINER}"; then
  [[ -r "$PRUNE_PY" ]] || { echo "prune script missing: ${PRUNE_PY}" >&2; exit 2; }
  echo ">> pruning ${MEM_CONTAINER} (session memory)"
  docker cp "$PRUNE_PY" "${MEM_CONTAINER}:${CTR_PRUNE}"
  docker exec -i -w /app/cognee-mcp "${MEM_CONTAINER}" uv run python -u "${CTR_PRUNE}"
else
  echo "!! ${MEM_CONTAINER} not running — skipped memory prune (bring the stack up, then re-run to clear it)"
fi

# 3. Re-seed the curated library from the canonical YAML (seed prunes-then-writes).
if [[ -r "$SEED" ]]; then
  echo ">> re-seeding curated library (stable baseline)"
  bash "$SEED"
else
  echo "!! seed-curated-library.sh missing (${SEED}) — curated NOT re-seeded" >&2
fi

echo
echo "✓ knowledge layer reset to the stable baseline. Work stores recreate on the next /mishkan-init."
