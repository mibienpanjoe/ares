# 04 — Memory layer (cognee)

> Goal: explain what the harness stores, where, how it gets there, and how
> agents query it. This is the layer that makes MISHKAN *accumulate* rather
> than just function.

## Two physically-isolated stores (decision D-007)

Cognee runs locally on the host as a Docker stack. The core architectural
choice (introduced in commit `418d10a`, documented in
[`docs/design/MISHKAN_decisions.md`](../design/MISHKAN_decisions.md) §D-007):

```
        shared Ollama (embeddings, local) ─┐ stateless, serves both
        shared Postgres server ────────────┤ separate databases
                                            │
  WORK box  :7777  (cognee)                 CURATED box  :7730  (cognee-curated)
  own Neo4j + cognee_db                     own Neo4j + curated_db
  ── per-project knowledge ──               ── cross-project reference ──
  • aiobi-mail        (project dataset)     • curated_library (96 nodes seed)
  • claude_code_memory (per-client memory)  • read-mostly
  UI :7724 · Neo4j :7716/:7709              UI :7734 · Neo4j :7731/:7732
```

Why two stores and not one?

- **PII isolation.** Project ingestion pulls in code and docs that can contain
  PII (real email addresses in incident reports were the trigger during the
  build). The cross-project curated library must stay clean.
- **Logical tags aren't enough on Neo4j Community.** Community Edition allows
  only one database per Neo4j instance, and with cognee's access control
  disabled (the only mode that works against Neo4j today) all datasets share
  one graph. So logical dataset tags commingle in one store. Physical
  separation = a separate Neo4j container.

The `claude_code_memory` dataset is the **per-client session memory**, created
on demand by cognee-mcp when Claude Code connects. **It belongs in the work
store and must never be pruned** (D-007 calls this out explicitly).

## The data flow

```
docs / project content                          curated resources (small, static)
       │                                                  │
       ▼                                                  ▼
   cognee.add()    ← raw files staged              add_data_points()  ← structured
       │                                                  │
   cognify()       ← LLM extracts entities          (no LLM — embeddings only)
       │             + relationships                     │
       ▼                                                  ▼
   memify()        ← embeds the triplet layer       memify() optional
       │             into the vector store
       ▼
   search()        ← retrieval (vector + graph)
```

Each phase, in words:

- **`add`** stages files for processing. The raw file content is stored under
  the cognee data root (must be on a volume — see [Troubleshooting](./07-troubleshooting.md)
  and commit `e24fabf`).
- **`cognify`** is the LLM-heavy step. It chunks each document, calls the LLM
  to extract entities and relationships as structured output (instructor mode),
  embeds chunks + entities, and writes to Neo4j + pgvector. This is the step
  that costs LLM tokens and runs into rate caps.
- **`memify`** is the enrichment step that runs **after** cognify. The default
  enrichment embeds the **edge / triplet** layer into the vector store
  (`EdgeType_relationship_name` and `graph_relationship_ledger` tables in
  pgvector). After memify, retrieval becomes **relationship-aware** — graph
  topology in Neo4j is unchanged; the vector store gains the triplet index.
- **`search`** retrieves (vector + optionally graph) and is exposed via the
  cognee MCP. Agents call it.

The session's wiring commit (`210f92b`) makes `cognify → memify` automatic in
the curated seed and in `/mishkan-init` step 8 — extraction is always followed
by enrichment, never manually.

## The MCP — how agents reach memory

Every MISHKAN-initialised project declares **both** servers in `.mcp.json`:

```json
{
  "mcpServers": {
    "cognee":          { "type": "http", "url": "http://localhost:7777/mcp" },
    "cognee-curated":  { "type": "http", "url": "http://localhost:7730/mcp" }
  }
}
```

So when an agent searches, it can target either store explicitly:

- `cognee` — read+write the project's own graph (typical).
- `cognee-curated` — read the cross-project reference library (typical for
  Shemaiah cross-referencing curated resources).

MCP servers connect at **session start**. A fresh session is needed for
`/mishkan-init`-written `.mcp.json` to take effect.

## Datasets — the logical layer inside each store

Datasets are cognee's logical partitioning. In the work store, every project
gets its own dataset (named after the project directory by convention). A
typical work store after a few projects:

```
datasets (work / cognee_db)
├── aiobi-mail              (14 docs, project knowledge)
├── claude_code_memory      (per-client session memory)
└── <next-project>          (created on its first ingest)
```

In the curated store there is one dataset (`curated_library`) — the cross-project
reference seed.

To query a specific dataset, pass `datasets=[...]` to `cognee.search`. This is
the only way to keep retrieval *logically* clean within a store; the *physical*
isolation between work and curated is by separate Neo4j containers.

## Visualising the graph

Two ways for each store:

### Cognee Graph Explorer UI

- **Work**: `http://localhost:7724`, backend `:7737`.
  Login = `DEFAULT_USER_EMAIL` / `DEFAULT_USER_PASSWORD` from `.env`.
- **Curated**: `http://localhost:7734`, backend `:7733` (added in commit `751f95e`).
  Login = `DEFAULT_USER_EMAIL` / `DEFAULT_USER_PASSWORD` from `.env.curated`.

### Neo4j Browser (raw graph)

| Store | HTTP | Bolt | Credentials |
|---|---|---|---|
| Work | `http://localhost:7716` | `bolt://localhost:7709` | `neo4j` + work `GRAPH_DATABASE_PASSWORD` |
| Curated | `http://localhost:7731` | `bolt://localhost:7732` | `neo4j` + curated `GRAPH_DATABASE_PASSWORD` |

Important: use the `bolt://` scheme in the browser's connect URL, **not**
`neo4j://`. The `neo4j://` scheme triggers routing discovery that fails over an
SSH tunnel — a real gotcha from the build (see
[Troubleshooting](./07-troubleshooting.md)).

A good Cypher to render the curated structure:

```cypher
MATCH (t:Team)-[r:resources]->(c:CuratedResource) RETURN t, r, c
```

## Tunnelling from a remote host

If cognee runs on a remote VPS, forward the relevant ports:

```bash
tsh ssh -N \
  -L 7724:127.0.0.1:7724 -L 7737:127.0.0.1:7737 \
  -L 7716:127.0.0.1:7716 -L 7709:127.0.0.1:7709 \
  -L 7734:127.0.0.1:7734 -L 7733:127.0.0.1:7733 \
  -L 7731:127.0.0.1:7731 -L 7732:127.0.0.1:7732 \
  <user>@<host>
```

Only what you want to look at. The MCP itself doesn't need a tunnel — the
agent runs on the host where cognee is, and the cognee MCP listens on
`127.0.0.1` already.

## What gets written when, and what to back up

| Layer | Where | Persistence | Back up? |
|---|---|---|---|
| Graph (Neo4j) | volumes `cognee_neo4j_data`, `curated_neo4j_data` | docker volume | yes (high value) |
| Vector + relational (Postgres) | volume `cognee_pgdata` | docker volume | yes |
| Raw ingested files + cognee system metadata | volume `cognee_data` (mounted at `/app/cognee-mcp/.cognee_system`) | docker volume | yes (commit `e24fabf` made this volume-backed; before that, every `up --force-recreate` wiped the raw files) |
| Ollama models | volume `ollama_models` | docker volume | re-pullable |

`docker volume inspect mishkan-cognee_cognee_data` shows where on disk the
volume lives. Standard restic / rsync covers it.

## Configuration anchors

- Work box env: `~/.claude/mishkan/cognee/.env` (gitignored, mode 600).
- Curated box env: `~/.claude/mishkan/cognee/.env.curated` (gitignored, mode 600).
- Compose entrypoint: `docker-compose.yml` + overlays (`hardening`, `selfhosted`,
  `ui`, `curated`, `curated-ui`).
- Curated singleton helper: `scripts/ensure-curated-box.sh` (idempotent).
- Selective seeding from a project: `scripts/mishkan-ingest.sh` (see
  [chapter 05](./05-selective-ingest.md)).

## See also

- The two-store rationale: [D-007](../design/MISHKAN_decisions.md) and
  commit `418d10a`.
- Curated UI overlay: commit `751f95e`.
- Storage persistence fix: commit `e24fabf`.
- Curated structured ingestion (low-level): commit `086e80e`,
  `payload/mishkan/cognee/ingest-curated.py`.
- Ontology definitions:
  [`docs/design/MISHKAN_ontology.md`](../design/MISHKAN_ontology.md).
- LLM/embedding strategy:
  [LLM provider profiles](./06-llm-providers.md).
- How to add knowledge: [Selective ingest](./05-selective-ingest.md).
- When things break: [Troubleshooting](./07-troubleshooting.md).
