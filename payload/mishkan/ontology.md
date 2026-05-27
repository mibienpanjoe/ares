# MISHKAN — Cognee Graph Ontology

The schema for the shared knowledge graph. Entity types are nodes; relationship
types are edges. The graph starts near-empty and grows through working sessions —
nothing is pre-seeded except the curated library (Phase 8).

This ontology is versioned in `harness/` so changes are reviewable. Schema drift
is expected; amend with a dated entry rather than rewriting silently.

---

## Entity types (nodes)

| Entity | Description | Key properties |
|---|---|---|
| **Agent** | One of the 45 MISHKAN agents | `alias`, `team`, `role`, `model_tier` |
| **Team** | One of the six teams | `name`, `hebrew`, `domain`, `lead_alias` |
| **Project** | A repo MISHKAN was initialised on | `name`, `path`, `stack`, `created_sprint` |
| **Sprint** | A delivery cycle within a project | `id` (S0, S1…), `project`, `started`, `closed`, `milestone` |
| **Task** | A scoped unit of work | `id` (T-N), `sprint`, `description`, `status`, `assigned_team`, `assigned_agent` |
| **Decision** | An architectural or scope decision | `id`, `made_by`, `sprint`, `summary`, `drivers`, `consequences`, `adr_ref` |
| **ResearchOutput** | A resolved research pipeline result | `id`, `agent`, `team`, `query_intent`, `summary`, `outcome`, `applied_to_task` |
| **CaseNode** | A problem solved using a curated resource | `team`, `agent`, `problem_class`, `resource_applied`, `resolution`, `outcome`, `sprint`, `task` |
| **CuratedResource** | A vetted professional reference | `name`, `url`, `team`, `problem_class`, `source_tier` |
| **Incident** | A documented failure + recovery | `id`, `date`, `service`, `root_causes[]`, `resolution`, `postmortem_ref` |
| **ADR** | Architecture Decision Record | `id`, `title`, `date`, `status`, `drivers`, `decision`, `consequences` |
| **RunbookProcedure** | An operational procedure | `id`, `title`, `service`, `trigger`, `steps_ref`, `status` |
| **SecurityFinding** | A finding from Mishmar | `id`, `severity`, `location`, `rule_violated`, `remediation`, `status`, `sprint` |
| **CuratedLibraryHit** | Telemetry: a curated resource was used | `resource`, `team`, `problem_class`, `sprint`, `count` |

---

## Relationship types (edges)

| Edge | From → To | Meaning |
|---|---|---|
| **member-of** | Agent → Team | agent belongs to team |
| **leads** | Agent → Team | agent is the team lead |
| **assigned-to** | Task → Agent / Team | who owns the task |
| **part-of** | Task → Sprint, Sprint → Project | hierarchy |
| **applies-to** | CuratedResource → Task / problem_class | resource is relevant here |
| **supersedes** | ADR → ADR, Decision → Decision, Doc → Doc | replaces a prior |
| **validated-by** | Decision → ResearchOutput / CaseNode | evidence backing a decision |
| **blocks** | Task → Task, SecurityFinding → Task | dependency / gate |
| **derives-from** | Decision → ResearchOutput, ADR → Decision | provenance |
| **escalated-to** | Task / Decision → Agent | who it was escalated to |
| **written-by** | ResearchOutput / Decision / CaseNode → Agent | authorship |
| **references** | any → any | loose citation link |
| **mitigates** | Decision / Task → SecurityFinding / Incident | what addresses a risk |
| **resolved-by** | Incident / SecurityFinding → Task / Decision | closure link |
| **uses** | CaseNode → CuratedResource | which resource solved the case |
| **documents** | ADR / RunbookProcedure → Decision / Incident / Task | doc covers this |

---

## Blast-radius tagging

Every node written to the graph carries a `blast_radius` property used by the
knowledge-promotion model (design §9):

- `agent-private` — stays in subagent MEMORY.md, not promoted to graph
  (these generally do not reach Cognee at all).
- `team-level` — promoted by Team Lead; tagged with `team`.
- `cross-harness` — promoted by Nehemiah + Bezalel at sprint close; visible
  to all agents.

Only `team-level` and `cross-harness` nodes live in Cognee. `agent-private`
knowledge stays in flat MEMORY.md files per the promotion model.

---

## Query patterns the improvement layer relies on

These saved queries (Phase 8) read the graph:

1. **Most expensive agents per sprint** — `Agent` nodes with aggregated
   observability metrics, ordered by cost.
2. **Tools called most per team** — observability metrics grouped by `team`.
3. **Blocker hot spots** — `Task` nodes with `blocks` edges, clustered.
4. **Components accumulating findings** — `SecurityFinding` nodes grouped by
   `location`.
5. **Curated library hit rate per problem class** — `CuratedLibraryHit`
   aggregated by `problem_class`, joined to `CuratedResource`.

---

*Ontology v1, locked May 2026. Amend with dated entries on schema drift.*
