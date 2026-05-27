# cognee-mcp — MISHKAN knowledge graph

Local Docker deployment of `cognee-mcp` — the MCP server that exposes the
[Cognee](https://docs.cognee.ai) knowledge graph to Claude Code (decision D-001).
Cognee core is a Python library; this container runs `cognee-mcp` in **HTTP
transport on port 7777** (endpoint `/mcp`). Optional: agents run without it; only
graph persistence is deferred until it's up.

New to Cognee setup? Run the **cognee-quickstart** skill first — it walks the
Python env, provider keys, and backend choices.

## Bring it up

```bash
cd ~/.claude/mishkan/cognee

# 1. secrets (SOPS-managed; never commit plaintext .env)
cp .env.example .env
#    set LLM_API_KEY, set COGNEE_MCP_REF to a pinned cognee git tag/commit, decrypt via sops

# 2. build + start with the hardening overlay (always)
docker compose -f docker-compose.yml -f docker-compose.hardening.yml up -d --build

# 3. confirm it's listening on 7777
nc -z localhost 7777 && echo "cognee-mcp up on :7777"

# 4. seed the curated reference library (96 nodes)
~/.claude/mishkan/scripts/seed-curated-library.sh
```

## How agents reach it

Claude Code connects via the project's `.mcp.json` (seeded by `/mishkan-init`
from `~/.claude/mishkan/templates/mcp.json`). The default entry is HTTP transport
to `http://localhost:7777/mcp`. A **zero-container stdio alternative** is included
in that template (`_stdio_alternative`): it launches `cognee-mcp` directly via
`uv --directory <path-to-cognee-mcp> run cognee-mcp` with `LLM_API_KEY` — no
container, no port. Use whichever fits.

## Transports (per cognee docs)

| Transport | Command | Endpoint |
|---|---|---|
| stdio (default) | `uv run cognee-mcp` | — (Claude Code spawns it) |
| http | `uv run cognee-mcp --transport http --host 0.0.0.0 --port 7777` | `/mcp` |
| sse | `uv run cognee-mcp --transport sse --host 0.0.0.0 --port 7777` | `/sse` |

This deployment uses **http** on 7777.

## Rules this deployment follows

- **Built locally** from a pinned `Dockerfile` (`COGNEE_MCP_REF` required) — no
  blind image pull, no `:latest`.
- **SOPS/age** for the `.env` (`LLM_API_KEY` etc.); only an encrypted `.env.enc`
  is committed.
- **Hardening overlay re-applied on every recreate** (`docker-compose.hardening.yml`):
  `no-new-privileges`, `cap_drop: ALL`, tmpfs `/tmp`.
- **Healthcheck** = TCP connect on 7777 (HTTP `/mcp` may 405 on GET).
- **Bound to `127.0.0.1`** — not exposed beyond the host.
- **Resource limits** on the service.

## Backends (self-hosted, swappable by env var)

Each layer defaults to local/embedded — zero extra services — swapped via one env
var (accepted values per the Cognee docs):

| Layer | Env var | Default | Options |
|---|---|---|---|
| Relational | `DB_PROVIDER` | `sqlite` | `sqlite`, `postgres` |
| Vector | `VECTOR_DB_PROVIDER` | `lancedb` | `lancedb`, `pgvector`, `qdrant`, `weaviate` |
| Graph | `GRAPH_DATABASE_PROVIDER` | `networkx` (file `.pkl`) | `networkx`, `kuzu`, `neo4j` |

Low-ops fit if you already run Postgres + pgvector: `DB_PROVIDER=postgres`,
`VECTOR_DB_PROVIDER=pgvector`, `GRAPH_DATABASE_PROVIDER=kuzu` (embedded, no server).

## Visualising the graph

- **Static HTML (zero infra):** `visualize_graph("./graph.html")` from
  `cognee.api.v1.visualize.visualize` writes an interactive HTML file (drag, zoom,
  hover; color-coded nodes + weighted edges). Publish it as a Sefer artifact, e.g.
  `docs/diagrams/graph.html`.
- **Cognee UI (Graph Explorer):** web workspace that visualises the *reasoning
  subgraph* used to answer a query. Self-hosted via the optional
  `docker-compose.ui.yml` overlay (profile `ui`) — see below.

### Graph Explorer (UI) — optional overlay

The UI shows the graph **only if it shares a backend with `cognee-mcp`** (default
file backends are per-process silos). The overlay runs **Neo4j as the shared graph
backend** and points both `cognee-mcp` and the UI's cognee backend at it.

```bash
# .env: GRAPH_DATABASE_PROVIDER=neo4j, GRAPH_DATABASE_URL=bolt://neo4j:7687,
#       GRAPH_DB_USERNAME/PASSWORD (sops), COGNEE_SRC=/path/to/cloned/cognee
docker compose -f docker-compose.yml -f docker-compose.hardening.yml \
               -f docker-compose.ui.yml --profile ui up -d --build
# UI       http://localhost:7724     backend http://localhost:7737
# Neo4j    http://localhost:7716      (Neo4j's own graph browser too)
```

Ports are local-bound and configurable. The UI backend + frontend build from a
**cloned cognee repo** (`COGNEE_SRC`). The Cognee UI is "work in progress"
upstream — confirm build contexts and env keys against the docs and repo compose.

## Data

- `cognee_data` — Docker-managed volume (cognee's local graph/vector/sqlite when
  using default backends). Runtime state, not shipped with the harness.
- `curated-resources.jsonl` — produced by the seed script; runtime output.
