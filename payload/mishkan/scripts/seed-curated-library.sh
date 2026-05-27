#!/usr/bin/env bash
# MISHKAN — seed the curated library into Cognee.
# Reads config/curated-library.yaml and emits one CuratedResource node per entry.
# If the Cognee MCP/endpoint is reachable it ingests directly; otherwise it
# writes a ready-to-ingest JSONL so the seed runs the moment Cognee is up.
#
# One-time bootstrap. Idempotent: re-running replaces the JSONL.
set -euo pipefail

MISHKAN="${HOME}/.claude/mishkan"
LIB="${MISHKAN}/config/curated-library.yaml"
OUT="${MISHKAN}/cognee/curated-resources.jsonl"
COGNEE_URL="${COGNEE_URL:-http://localhost:7777}"

command -v python3 >/dev/null 2>&1 || { echo "python3 required" >&2; exit 1; }
[ -f "$LIB" ] || { echo "curated library not found: $LIB" >&2; exit 1; }
mkdir -p "${MISHKAN}/cognee"

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

# Attempt direct ingestion if Cognee is reachable.
if curl -fsS --max-time 2 "${COGNEE_URL}/health" >/dev/null 2>&1; then
  echo "Cognee reachable at ${COGNEE_URL} — ingesting..."
  # Ingestion call shape depends on the deployed Cognee API; left as the single
  # integration point to wire when the container is up (D-001).
  echo "TODO: POST ${OUT} to Cognee ingest endpoint (wire to deployed API)."
else
  echo "Cognee not reachable at ${COGNEE_URL}. JSONL is ready at ${OUT};"
  echo "re-run this script (or POST the JSONL) once the Cognee container is up."
fi
