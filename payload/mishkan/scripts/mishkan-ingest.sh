#!/usr/bin/env bash
# MISHKAN — selectively ingest docs into the project's work cognee store.
# Default: nothing enters memory unless tagged (`mishkan: ingest` frontmatter)
# or explicitly listed — preventing PII bleed and oversized-doc errors.
# Runs cognee.add -> cognify -> memify (extraction + enrichment).
#
#   mishkan-ingest.sh --tagged-only                # walk ./docs/ for tagged
#   mishkan-ingest.sh docs/SECURITY.md docs/ROADMAP.md
#   mishkan-ingest.sh --dataset=research docs/research.md
set -euo pipefail

TAGGED_ONLY=false
DATASET="$(basename "$PWD")"
PATHS=()
CONTAINER="${COGNEE_CONTAINER:-mishkan-cognee-mcp}"

while [ $# -gt 0 ]; do
  case "$1" in
    --tagged-only) TAGGED_ONLY=true; shift ;;
    --dataset=*) DATASET="${1#--dataset=}"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) PATHS+=("$1"); shift ;;
  esac
done

[ ${#PATHS[@]} -eq 0 ] && PATHS=("./docs")

docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" \
  || { echo "work cognee container '$CONTAINER' is not running" >&2; exit 1; }

# Collect candidate files (md only).
FILES=()
for p in "${PATHS[@]}"; do
  if [ -d "$p" ]; then
    while IFS= read -r f; do FILES+=("$f"); done < <(find "$p" -type f -name "*.md")
  elif [ -f "$p" ]; then
    FILES+=("$p")
  else
    echo "warn: skipping (not found): $p" >&2
  fi
done

# Filter to tagged docs if requested. A doc is tagged when its YAML frontmatter
# (the block between the first two `---` lines) contains `mishkan: ingest`.
if $TAGGED_ONLY; then
  KEPT=()
  for f in "${FILES[@]}"; do
    if awk '
      BEGIN{infm=0;ok=0}
      NR==1 && $0=="---"{infm=1;next}
      infm && $0=="---"{exit}
      infm && /^[[:space:]]*mishkan:[[:space:]]*ingest[[:space:]]*$/{ok=1;exit}
      NR>50 && !infm{exit}
      END{exit !ok}
    ' "$f"; then KEPT+=("$f"); fi
  done
  FILES=("${KEPT[@]}")
fi

if [ ${#FILES[@]} -eq 0 ]; then
  echo "no docs selected (tagged_only=$TAGGED_ONLY, paths='${PATHS[*]}')"
  exit 0
fi

echo "ingesting ${#FILES[@]} file(s) into dataset '${DATASET}':"
printf '  %s\n' "${FILES[@]}"

# Stage files into the container, then run add -> cognify -> memify.
docker exec "$CONTAINER" sh -c 'rm -rf /home/cognee/ingest_buf && mkdir -p /home/cognee/ingest_buf'
for f in "${FILES[@]}"; do
  docker cp "$f" "${CONTAINER}:/home/cognee/ingest_buf/$(basename "$f")"
done

PY_SCRIPT="$(mktemp)"
cat > "$PY_SCRIPT" <<'PY'
import asyncio, glob, sys, cognee
DATASET = sys.argv[1]
FILES = sorted(glob.glob("/home/cognee/ingest_buf/*"))
async def m():
    if not FILES:
        print(">> no files"); return
    await cognee.add(FILES, dataset_name=DATASET)
    print(f">> added {len(FILES)} file(s) -> {DATASET}", flush=True)
    await cognee.cognify(datasets=[DATASET])
    print(">> cognified", flush=True)
    await cognee.memify(dataset=DATASET)
    print(">> memified", flush=True)
asyncio.run(m())
PY
docker cp "$PY_SCRIPT" "${CONTAINER}:/home/cognee/_mishkan_ingest.py"
rm -f "$PY_SCRIPT"
docker exec -i -w /app/cognee-mcp "$CONTAINER" uv run python -u /home/cognee/_mishkan_ingest.py "$DATASET"
