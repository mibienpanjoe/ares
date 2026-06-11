# 04 — Memory layer (cognee)

> Goal: explain what the harness stores, where, how it gets there, and how
> agents query it. This is the layer that makes MISHKAN *accumulate* rather
> than just function.

## Three physically-isolated pillars (decisions D-007 + D-012)

Cognee runs locally on the host as a Docker stack. The current architecture
has three pillars (D-007 separated work from curated; D-012 further split
per-project work stores from the shared session-memory box; both documented in
[`docs/design/MISHKAN_decisions.md`](../design/MISHKAN_decisions.md)):

```
  shared Ollama (embeddings, local) ─┐ stateless, serves all pillars
  shared Postgres server ────────────┤ separate databases
                                      │
  Per-project WORK store              MEMORY box  :7777  (cognee-memory)    CURATED box  :7730  (cognee-curated)
  mishkan-work-<slug>                 Neo4j + cognee_db                      own Neo4j + curated_db
  embedded Ladybug graph              ── shared per-client session memory ── ── cross-project reference ──
  own port + volume                   • claude_code_memory (never prune)     • curated_library (96 nodes seed)
  ── isolated project knowledge ──    • cross-project by design              • read-mostly
  provisioned by ensure-work-store.sh UI :7724 · Neo4j :7716/:7709           UI :7734 · Neo4j :7731/:7732
```

Why physical separation and not logical datasets?

- **PII isolation.** Project ingestion pulls in code and docs that can contain
  PII (real email addresses in incident reports were the trigger during the
  build). The cross-project curated library and session-memory box must stay clean.
- **`datasets=` filter is advisory-only on Neo4j.** With `ENABLE_BACKEND_ACCESS_CONTROL=false`
  (the only mode that works against Neo4j Community), cognee ignores the
  `datasets=` filter and searches the whole graph — verified against cognee
  v1.1.0 / issue #1023. Logical tags alone do not isolate.
- **Physical separation = topology.** Each project work store is a separate
  container + volume + on-disk graph file. Cross-project reads are impossible
  by construction.

The `claude_code_memory` dataset is the **per-client session memory**, held in
the `cognee-memory` (`:7777`) box. It is shared across all your work — one
continuous thing, not re-derivable — and **must never be pruned** (D-012).
Keep it scrubbed of project-specific secrets and PII because it is
cross-project by nature.

### Per-project work stores (decision D-012)

D-007 separated *work* from *curated*. **D-012** extends the same physical-
separation principle one axis further: each project gets its **own** work store,
not a shared dataset in one box. The trigger was a confidentiality bug — with
`ENABLE_BACKEND_ACCESS_CONTROL=false` (required on Neo4j) cognee's `datasets=`
filter is **advisory only**: it is silently ignored and search runs the whole
graph, so a query scoped to one project returned another project's data (with a
live API key among it). Verified against cognee v1.1.0 / issue #1023.

The fix: each project runs its own lightweight cognee-mcp container with an
**embedded Ladybug** graph (no Neo4j) and its own volume — `mishkan-work-<slug>`
on its own port, provisioned by `ensure-work-store.sh` at `/mishkan-init`.
Isolation is by topology (container + volume + on-disk graph file), never the
`datasets=` filter.

Each project's `.mcp.json` then carries **three doorways** (the alias is the
doorway; the backend behind each differs):

- **`cognee`** → that per-project Ladybug store — isolated project knowledge.
- **`cognee-memory`** → the **kept** Neo4j box on `:7777`, now holding only
  `claude_code_memory` — shared per-client session memory, one continuous thing
  across all your work, not re-derivable, so never fragmented per project or
  pruned. (Cross-project by nature → keep it scrubbed of project secrets/PII.)
- **`cognee-curated`** → the shared reference library (`:7730`).

The shared box's old *project* graphs are discarded (re-derivable from tagged
docs); the box itself is **repurposed** as the session-memory pillar, not retired.

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
  that costs LLM tokens and runs into rate caps. Each work store attaches the
  **MISHKAN ontology** (`ontology.ttl`, the machine form of `ontology.md` — ADR
  D-013) to cognify via the container's env config (`ONTOLOGY_FILE_PATH` +
  `rdflib`/`fuzzy`, staged by `ensure-work-store`): entities whose extracted type
  matches a schema class are validated (`ontology_valid: true`) and enriched with
  parent-class / object-property edges. Fails open — a missing ontology ingests
  unconstrained.
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

Every MISHKAN-initialised project declares **three** servers in `.mcp.json`
(written by `ensure-work-store.sh` at `/mishkan-init`):

```json
{
  "mcpServers": {
    "cognee":         { "type": "http", "url": "http://localhost:<per-project-port>/mcp" },
    "cognee-memory":  { "type": "http", "url": "http://localhost:7777/mcp" },
    "cognee-curated": { "type": "http", "url": "http://localhost:7730/mcp" }
  }
}
```

The `<per-project-port>` is assigned by `ensure-work-store.sh` at init time
and recorded in the project's `.mcp.json`. It is NOT `:7777`.

So when an agent searches, it targets the right pillar explicitly:

- `cognee` — read+write the project's own isolated Ladybug graph (typical for
  project knowledge retrieval and ingest).
- `cognee-memory` — read+write per-client session memory (`claude_code_memory`)
  shared across all work. Use when the agent needs to recall or record
  cross-session context.
- `cognee-curated` — read the cross-project reference library (typical for
  Shemaiah cross-referencing curated resources).

MCP servers connect at **session start**. A fresh session is needed for
`/mishkan-init`-written `.mcp.json` to take effect.

## Datasets — a label inside a store, NOT an isolation boundary

Within a single store, `datasets` is cognee's logical *label* — by convention the
project dir name (plus `claude_code_memory` for per-client session memory). It is
**not a security boundary**: with access control off (the only mode that works on
Neo4j), `datasets=[...]` on `cognee.search` is **advisory only** — cognee ignores
it and searches the whole graph (verified, cognee v1.1.0 / issue #1023). Do not
rely on it to keep one project's retrieval clean of another's.

Real isolation is **physical — separate stores**:

- Curated is a separate store from work (**D-007**).
- Each project is a separate work store from every other (**D-012** — per-project
  embedded Ladybug containers).

So with per-project stores, a project's `cognee` store contains only that
project's data; the dataset label is cosmetic and a cross-project read is
impossible by construction. The curated store holds one dataset
(`curated_library`), the cross-project reference seed.

## Visualising the graph

Two ways for each store:

Per-project work stores use an embedded Ladybug graph (no Neo4j, no UI).
The Neo4j-backed pillars (`cognee-memory` and `cognee-curated`) have UIs:

### Cognee Graph Explorer UI

- **cognee-memory** (`:7777`, session memory): `http://localhost:7724`, backend `:7737`.
  Login = `DEFAULT_USER_EMAIL` / `DEFAULT_USER_PASSWORD` from `.env`.
- **cognee-curated** (`:7730`, reference library): `http://localhost:7734`, backend `:7733`
  (added in commit `751f95e`).
  Login = `DEFAULT_USER_EMAIL` / `DEFAULT_USER_PASSWORD` from `.env.curated`.

### Neo4j Browser (raw graph)

| Pillar | HTTP | Bolt | Credentials |
|---|---|---|---|
| cognee-memory (`:7777`) | `http://localhost:7716` | `bolt://localhost:7709` | `neo4j` + work `GRAPH_DATABASE_PASSWORD` |
| cognee-curated (`:7730`) | `http://localhost:7731` | `bolt://localhost:7732` | `neo4j` + curated `GRAPH_DATABASE_PASSWORD` |

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

**Per-project work stores have no web UI to tunnel.** They use an embedded
Ladybug graph (a file, no server) — there is no Graph Explorer or Neo4j browser
for them. The ports above are the shared **`cognee-memory`** (`:77xx`) and
**`cognee-curated`** (`:773x`) UIs only. To inspect a project's own graph, use
cognee's static-HTML `visualize_graph("./graph.html")` export on the host.

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

- `cognee-memory` box (`:7777`) env: `~/.claude/mishkan/cognee/.env` (gitignored, mode 600).
- Curated box env: `~/.claude/mishkan/cognee/.env.curated` (gitignored, mode 600).
- Per-project work store provisioner: `scripts/ensure-work-store.sh` (run at `/mishkan-init`; idempotent).
- Compose entrypoint: `docker-compose.yml` + overlays (`hardening`, `selfhosted`,
  `ui`, `curated`, `curated-ui`).
- Curated singleton helper: `scripts/ensure-curated-box.sh` (idempotent).
- Selective seeding from a project: `scripts/mishkan-ingest.sh` (see
  [chapter 05](./05-selective-ingest.md)).

## See also

- The three-pillar rationale: [D-007](../design/MISHKAN_decisions.md) (work vs curated split),
  [D-012](../design/MISHKAN_decisions.md) (per-project work stores), commit `418d10a`.
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
