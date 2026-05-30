# 07 — Troubleshooting

> A cookbook of the issues hit during the build and how they were resolved.
> Each entry: symptom → root cause → fix → commit / file reference.

## cognify errors with `Status code: 422`

The 422 is cognee's generic wrapper; the actual cause is upstream. Two distinct
classes:

### (a) Embedding 422 — `Failed to index data points using model nomic-embed-text`

**Symptom**

```
EmbeddingException: Failed to index data points using model nomic-embed-text:latest (Status code: 422)
```

repeated in a retry loop on the same data item.

**Causes (in order of likelihood)**

1. A chunk exceeds the model's input limit (8,192 tokens for nomic). Cognee
   keeps retrying the same offending chunk.
2. Ollama transiently failed to load the embedding model (resource pressure)
   and is still warming back up.

**Fix**

- Identify the failing document. Most often it's the largest in the dataset.
- Either tag it out of selective ingest (see [05](./05-selective-ingest.md))
  or reduce cognee's chunk target by lowering `LLM_MAX_TOKENS` in `.env`.
- For transient Ollama load failures, wait, then re-run cognify — the persistent
  storage fix (commit `e24fabf`) means progress sticks across retries.

### (b) LLM 422 — `Pipeline run failed. Data item could not be processed.`

**Symptom**

```
PipelineRunFailedError: Pipeline run failed. Data item could not be processed. (Status code: 422)
```

**Causes**

- Free-tier cloud LLM hit per-minute or per-day cap → 429 wrapped as 422.
- Thinking model emitting reasoning before the structured output → instructor
  fails to parse JSON.

**Fix**

- Per-minute: enable the throttle (`LLM_RATE_LIMIT_ENABLED=true`,
  `LLM_RATE_LIMIT_REQUESTS=8`, `LLM_RATE_LIMIT_INTERVAL=60`). See commit
  `70d3c2e`.
- Per-day: see [Daily quota wall](#daily-quota-rpd-wall) below.
- Thinking model: switch to a non-thinking model on the same key (e.g.
  `meta/llama-3.3-70b-instruct` on NVIDIA Catalog). See
  [LLM providers — thinking-model trap](./06-llm-providers.md#the-thinking-model-trap).

## Cognify stuck on the last doc

**Symptom** — pipeline runs are mostly COMPLETED, one stuck as STARTED for
half an hour, graph not advancing.

**Diagnosis** — check what cognee is actually doing:

```bash
# is the LLM endpoint being called at all?
docker logs --since 5m mishkan-cognee-mcp 2>&1 | grep -iE "extraction|nodes_extracted|429|timeout|embedding"

# the cognee internal log file (more detail)
docker exec mishkan-cognee-mcp sh -c 'tail -300 /home/cognee/.cognee/logs/$(ls -t /home/cognee/.cognee/logs/ | head -1)' \
  | grep -iE "error|exception|retry|429" | tail -20
```

**Common root causes**

- Embedding 422 retry loop on one chunk (above).
- Stale `DATASET_PROCESSING_STARTED` row blocking re-runs (below).
- Daily quota exhausted mid-run (below).

## Stale pipeline lock — `Dataset is already being processed`

**Symptom** — `cognee.cognify(datasets=[...])` returns immediately, logs say
*"Dataset is already being processed"*. The work graph doesn't grow.

**Cause** — a previous cognify died (timeout, OOM, interrupted) without
clearing its `DATASET_PROCESSING_STARTED` row in `pipeline_runs`. Cognee's
qualification check refuses to start a new run while one is "in progress".

**Fix**

```bash
docker exec mishkan-cognee-pg psql -U cognee -d cognee_db -c \
  "UPDATE pipeline_runs SET status='DATASET_PROCESSING_ERRORED'
   WHERE status='DATASET_PROCESSING_STARTED'
     AND created_at < NOW() - INTERVAL '5 minutes';"
```

Then re-run cognify. The dataset and its data items are intact; only the stale
lock row is cleared.

## Storage wiped on every `docker compose up --force-recreate`

**Symptom** — re-running cognify on an existing dataset errors with

```
FileNotFoundError: Storage directory does not exist
```

even though the data items are still listed in `datasets`.

**Cause** — cognee's default data + system root is venv-relative inside the
container (`.venv/.../cognee/.cognee_data` and `.cognee_system`), which is the
container's ephemeral layer. The Docker volume that ships with the compose was
mounted at `/app/cognee-mcp/.cognee_system` but cognee didn't write there by
default — so every recreate wiped the ingested source files.

**Fix (already in payload from commit `e24fabf`)** — point cognee at the
mounted volume via `.env`:

```
DATA_ROOT_DIRECTORY=/app/cognee-mcp/.cognee_system/data
SYSTEM_ROOT_DIRECTORY=/app/cognee-mcp/.cognee_system/system
```

The Dockerfile now pre-creates `.cognee_system` as the `cognee` user (uid
10001), so a fresh named volume inherits writable ownership without a manual
chown.

**If you upgrade from a pre-`e24fabf` install** — the existing volume is
root-owned. Chown it once:

```bash
docker run --rm -u 0 -v mishkan-cognee_cognee_data:/v busybox \
  sh -c 'chown -R 10001:10001 /v'
docker compose ... up -d --force-recreate cognee-mcp
```

## Curated library is showing inside the work UI

**Symptom** — the Cognee UI at `:7724` (work backend) shows `CuratedResource`
nodes mixed with project data.

**Cause** — the curated library got seeded into the work store (incorrect).
Real fix: physical separation per D-007. Was hit during the build (the seed
initially ran against the work box) and is what the curated box exists for.

**Fix**

1. Ensure the curated box is running (`scripts/ensure-curated-box.sh`).
2. Re-run the curated seed against `mishkan-curated-mcp` (the script's default
   container since commit `086e80e`).
3. Delete the `CuratedResource` and `Team` labels from the work Neo4j:
   ```bash
   P='<work neo4j password from .env>'
   docker exec mishkan-cognee-neo4j cypher-shell -u neo4j -p "$P" \
     "MATCH (n:CuratedResource) DETACH DELETE n;"
   docker exec mishkan-cognee-neo4j cypher-shell -u neo4j -p "$P" \
     "MATCH (n:Team) DETACH DELETE n;"
   ```
4. Drop the stray `curated_library` dataset row from the work cognee_db via
   cognee's `delete_dataset` API (see commit `418d10a` for the exact cleanup
   pattern used during the build).

`claude_code_memory` is **not** stray — it is the per-client memory dataset.
Don't delete it.

## Neo4j Browser "Could not perform discovery. No routing servers available"

**Symptom** — Neo4j Browser on `:7716` (or `:7731`) loads, but connecting to
`neo4j://localhost:7709` fails with the routing error.

**Cause** — the `neo4j://` URI scheme triggers cluster routing discovery, which
fails over a single-instance bolt connection and over SSH tunnels.

**Fix** — use the `bolt://` scheme:

```
Connect URL: bolt://localhost:7709     # work
             bolt://localhost:7732     # curated
```

## `tsh` tunnel: `Failed to bind to 127.0.0.1:NNNN: address already in use`

**Cause** — a previous tsh forward is still alive on your laptop holding the
port; tsh aborts the whole tunnel on any one bind failure.

**Fix on your laptop**

```bash
lsof -nP -iTCP:7724 -sTCP:LISTEN     # find what's holding it
pkill -f 'tsh ssh'                   # kill the stale tunnel(s)
```

Then re-run the full tunnel command.

## Daily quota (RPD) wall

**Symptom** — every retry of cognify returns `429 RESOURCE_EXHAUSTED` instantly,
including the first one of the run. Cognee's throttle has no effect.

**Cause** — the cloud free tier's **daily** request budget is exhausted. The
throttle controls per-minute rate; it cannot rescue a daily cap.

**Fix** — pick one:

- Wait for the cap to reset (24 h on most free tiers).
- Switch to a more generous free tier (NVIDIA API Catalog).
- Switch the work box to local Ollama (Profile A — zero cost, no quota, slow).
- Move to a paid tier on the same provider.

This is precisely why the harness recommends **local Ollama for the work store**
(see [LLM providers](./06-llm-providers.md)) when project data has PII or is
voluminous.

## Auto-mode classifier blocks writing `.claude/settings.json` / `.mcp.json`

**Symptom** — the Claude Code auto-mode classifier denies the agent's write to
agent-config files even when invoked by `/mishkan-init`.

**Cause** — the classifier treats `.claude/settings.json`, `.mcp.json`,
`settings.local.json`, and (sometimes) `CLAUDE.md` as **self-modification**
and refuses autonomous writes.

**Fix** — pick one:

- Approve each write at the prompt.
- Disable the auto-mode classifier for this session, then re-run init.
- Add a permission rule that allows these specific writes.

There is no harness change needed; this is a Claude Code platform guard doing
its job, not a MISHKAN bug.

## `afplay: not found` Stop-hook error on Linux

**Symptom** — every turn ends with

```
Stop hook error: Failed with non-blocking status code: /bin/sh: 1: afplay: not found
```

**Cause** — the personal sound hooks in `~/.claude/settings.json` use `afplay`
(macOS-only). On Linux, that command doesn't exist.

**Fix** — make the command portable. Replace the hook command string with:

```sh
sh -c 'F="<path-to-mp3>"; { command -v afplay >/dev/null 2>&1 && afplay -v 0.1 "$F"; } || { command -v ffplay >/dev/null 2>&1 && ffplay -nodisp -autoexit -loglevel quiet -volume 10 "$F"; } || true'
```

Tries `afplay` first (macOS), falls back to `ffplay` (Linux), silently no-ops
if neither is present. These are *your personal* sound hooks, not part of the
MISHKAN payload — feel free to remove them outright if you don't want audio
cues.

## "Ghost subnet" — cognee containers can't reach each other

**Symptom** — fresh `docker compose up` fails with networking errors; the
containers come up but communication times out.

**Cause** — a leftover Docker network from a previous teardown with the same
IP range collides with what Compose tries to allocate. Iptables nat
PREROUTING rules from the dead bridge persist.

**Fix**

```bash
# identify the ghost
docker network ls
ip rule show
iptables -t nat -L PREROUTING -n -v | grep -B1 -A2 br-

# remove the offending leftover network if present
docker network rm <ghost-net-id>

# bring the stack back up
cd ~/.claude/mishkan/cognee
docker compose ... up -d
```

The fully-self-hosted compose pins the network subnet (`172.51.0.0/16`) to
avoid this collision class going forward (decision recorded in commit
`2262ea8`).

## Useful inspection one-liners

```bash
# container health
docker ps --filter 'name=mishkan-' --format '{{.Names}}\t{{.Status}}'

# pipeline run status (work store)
docker exec mishkan-cognee-pg psql -U cognee -d cognee_db -tc \
  "SELECT status, count(*) FROM pipeline_runs GROUP BY status;"

# graph topology (any store)
docker exec mishkan-cognee-neo4j cypher-shell -u neo4j -p '<pw>' \
  "MATCH (n) RETURN labels(n) AS l, count(*) AS n ORDER BY n DESC;"

# what's actually listening on the host
ss -tlnp 2>/dev/null | grep -E '127.0.0.1:77[0-9][0-9]'

# Ollama model list and embed endpoint sanity
docker exec mishkan-ollama ollama list
docker exec mishkan-cognee-mcp sh -c \
  'python3 -c "import urllib.request,json; r=urllib.request.urlopen(urllib.request.Request(\"http://ollama:11434/api/embed\", data=json.dumps({\"model\":\"nomic-embed-text:latest\",\"input\":\"hi\"}).encode(), headers={\"Content-Type\":\"application/json\"}), timeout=10); print(r.status)"'
```

## See also

- [Memory layer](./04-memory-layer.md) — backups and volume layout.
- [LLM provider profiles](./06-llm-providers.md) — switching providers.
- [Selective ingest](./05-selective-ingest.md) — controlling what enters
  memory.
- The build's hard-won fixes are anchored in commits: `e17f2a9`, `70d3c2e`,
  `e24fabf`, `418d10a`, `086e80e`, `2262ea8`.
