# MISHKAN — Threat Model

Threats to the harness itself and the local services it provisions (cognee work +
curated stores, the observability daemon, the model-routing hook). Per-project
threat models are authored separately at `/mishkan-init` (Benaiah). This file
tracks harness-level threats. STRIDE categories; each entry names asset, vector,
impact, root cause(s), mitigation, and status.

---

## Data isolation / knowledge graph

### T-001 — Cross-tenant cognee work-graph bleed

- **Category:** Information Disclosure (STRIDE).
- **Asset:** per-project knowledge graphs — ingest includes code, docs, and can
  include credentials / API keys / PII.
- **Attack vector:** internal — any agent within a MISHKAN session querying the
  shared work store.

**Description.** When cognee-mcp instances share a single Neo4j backend and
`ENABLE_BACKEND_ACCESS_CONTROL=false` (the harness setting, required because
cognee's access control is Neo4j-incompatible), the `datasets=` filter is
**advisory only** — enforced by the cognee Python layer, not by Neo4j. Any agent
that calls `cognee.search()` without a `datasets` restriction (or whose restriction
is ignored, as here) reads nodes and relationships from **all** projects in the
shared graph. Observed in practice: a wisemoney-context query returned an
aiobi-mail audit fragment containing a **live Gemini API key** ingested by a
separate project (verified, cognee v1.1.0 / issue #1023).

**Impact.** Secrets (API keys, tokens, credentials) and business-sensitive context
(financial models, client data, audit records) ingested by one project's agents are
readable by any other project's agents. No authentication boundary exists between
projects while Neo4j is shared.

**Root cause (two layers).**
1. *Applicative:* cognee's multi-tenant isolation relies on a soft `datasets=`
   filter with no enforcement at the graph storage layer (off in access-control-off
   mode).
2. *Infrastructural:* a single shared Neo4j instance is a single trust domain;
   physical graph separation is never enforced.

**Mitigation (primary — ADR D-012).** Per-project physical graph stores:
`GRAPH_DATABASE_PROVIDER=ladybug` with a unique `GRAPH_FILE_PATH` per project, each
cognee-mcp instance (one per project, stdio) writing to its own file-based store.
Processes cannot cross store boundaries at the filesystem layer.

**Mitigation (interim — until D-012 lands).** Treat the shared-Neo4j work store as a
**single trust domain**: do not ingest secrets, credentials, or PII from any project
into cognee. Opt-in ingest only, with explicit scrubbing of secrets from documents
before ingest (no `.env` files, private keys, or raw audit logs). Loud advisory
warning surfaced at the boundary (`.env.example`, cognee `README.md`, `mcp.json`,
`mishkan-ingest`).

**Remediation of the existing exposure.** The leaked Gemini key must be
**revoked/rotated** (engineer, in the owning console) and the leaked node **purged**
from the work graph (engineer-run, Mishmar-specified scope) — revoke before purge.

**Status:** open — D-012 adopted, provisioning migration pending (follow-on plan).
