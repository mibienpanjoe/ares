#!/usr/bin/env bash
# MISHKAN — seed the curated library into Cognee.
# Reads config/curated-library.yaml, emits a JSONL of CuratedResource entries,
# then ingests them as typed Team + CuratedResource nodes via the structured
# low-level pipeline (ingest-curated.py) run INSIDE the cognee-mcp container.
# No LLM extraction — embeddings only (use local Ollama embeddings to avoid
# cloud rate walls on bulk ingest).
#
# One-time bootstrap. The ingest PRUNES the graph first for a clean, reproducible
# seed — run before real session knowledge accumulates.
set -euo pipefail

runtime_home() {
  if [[ -n "${ARES_HOME:-}" ]]; then printf '%s' "$ARES_HOME"; return; fi
  if [[ -n "${MISHKAN_HOME:-}" ]]; then printf '%s' "$MISHKAN_HOME"; return; fi
  if [[ -d "$HOME/.ares" || ! -d "$HOME/.claude/mishkan" ]]; then printf '%s' "$HOME/.ares"; return; fi
  printf '%s' "$HOME/.claude/mishkan"
}
ARES_HOME_RES="$(runtime_home)"
LIB="${ARES_HOME_RES}/config/curated-library.yaml"
OUT="${ARES_HOME_RES}/cognee/curated-resources.jsonl"
INGEST="${ARES_HOME_RES}/cognee/ingest-curated.py"
CONTAINER="${COGNEE_CONTAINER:-ares-curated-mcp}"
if [[ -z "${COGNEE_CONTAINER:-}" ]]; then
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "mishkan-curated-mcp" && \
     ! docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "ares-curated-mcp"; then
    CONTAINER="mishkan-curated-mcp"
  else
    CONTAINER="ares-curated-mcp"
  fi
fi
CTR_JSONL="/home/cognee/curated-resources.jsonl"
CTR_INGEST="/home/cognee/ingest-curated.py"

command -v python3 >/dev/null 2>&1 || { echo "python3 required" >&2; exit 1; }
[ -f "$LIB" ] || { echo "curated library not found: $LIB" >&2; exit 1; }
mkdir -p "${ARES_HOME_RES}/cognee"

# Convert YAML → JSONL of CuratedResource nodes (ontology type=CuratedResource).
python3 - "$LIB" "$OUT" <<'PY'
import sys, json
try:
    import yaml
except ImportError:
    sys.exit("pyyaml required: pip install pyyaml")
lib_path, out_path = sys.argv[1], sys.argv[2]
data = yaml.safe_load(open(lib_path))
n = 0
with open(out_path, "w") as f:
    for team, items in (data or {}).items():
        for it in items:
            node = {
                "type": "CuratedResource",
                "team": team,
                "name": it["name"],
                "url": it["url"],
                "problem_class": it.get("problem_class", ""),
                "source_tier": "curated",
            }
            f.write(json.dumps(node) + "\n")
            n += 1
print(f"wrote {n} CuratedResource nodes -> {out_path}")
PY

# Ingest into Cognee via the structured low-level pipeline inside the container.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "${CONTAINER}"; then
  echo "Ingesting into ${CONTAINER} (structured Team + CuratedResource nodes)..."
  [ -f "$INGEST" ] || { echo "ingest script missing: $INGEST" >&2; exit 1; }
  docker cp "$OUT" "${CONTAINER}:${CTR_JSONL}"
  docker cp "$INGEST" "${CONTAINER}:${CTR_INGEST}"
  docker exec -i -w /app/cognee-mcp "${CONTAINER}" uv run python -u "${CTR_INGEST}"
  echo "Seed complete. Verify: MATCH (r:CuratedResource) RETURN r.team, count(*);"
else
  echo "Cognee container '${CONTAINER}' not running. JSONL is ready at ${OUT};"
  echo "bring the stack up and re-run this script (or set COGNEE_CONTAINER)."
fi
