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

# cognify()/memify() return {dataset_id: PipelineRunInfo} (cognee v1.1.0, the ref
# this image pins) and do NOT raise on a per-dataset pipeline failure — they
# return a run-info object whose .status is "PipelineRunErrored" (e.g. a mid-run
# Neo4j timeout surfaces as status 422 -> errored, not an exception). Inspect the
# status and FAIL LOUD, so a partial ingest can never print ">> cognified" and
# exit 0, reading as a clean "done". Known terminal statuses in v1.1.0:
#   PipelineRunCompleted / PipelineRunAlreadyCompleted (ok) · PipelineRunErrored
#   (fail) · PipelineRunStarted / PipelineRunYield (intermediate, not a result).
OK = {"PipelineRunCompleted", "PipelineRunAlreadyCompleted"}
INTERMEDIATE = {"PipelineRunStarted", "PipelineRunYield"}

def failures(result, stage):
    if isinstance(result, dict):
        runs = list(result.values())
    elif isinstance(result, (list, tuple)):
        runs = list(result)
    else:
        runs = [result]
    bad = []
    for r in runs:
        status = getattr(r, "status", None)
        if status is None or status in OK or status in INTERMEDIATE:
            continue
        bad.append((stage, getattr(r, "dataset_name", "?"), status, repr(r)))
    return bad

async def m():
    if not FILES:
        print(">> no files"); return
    await cognee.add(FILES, dataset_name=DATASET)
    print(f">> added {len(FILES)} file(s) -> {DATASET}", flush=True)

    bad = []
    bad += failures(await cognee.cognify(datasets=[DATASET]), "cognify")
    print(">> cognified", flush=True)
    bad += failures(await cognee.memify(dataset=DATASET), "memify")
    print(">> memified", flush=True)

    if bad:
        print(f"!! MISHKAN ingest FAILED — {len(bad)} errored pipeline run(s); the "
              f"dataset is PARTIAL, not complete:", file=sys.stderr)
        for stage, ds, status, detail in bad:
            print(f"   [{stage}] dataset={ds} status={status}\n       {detail}", file=sys.stderr)
        sys.exit(1)

asyncio.run(m())
PY
# mktemp creates the runner 0600; docker cp preserves mode + host uid, so the
# container's non-root user can't read it (Errno 13 Permission denied). Make it
# world-readable before staging — this was silently blocking ingest fleet-wide.
chmod 0644 "$PY_SCRIPT"
docker cp "$PY_SCRIPT" "${CONTAINER}:/home/cognee/_mishkan_ingest.py"
rm -f "$PY_SCRIPT"
docker exec -i -w /app/cognee-mcp "$CONTAINER" uv run python -u /home/cognee/_mishkan_ingest.py "$DATASET"
