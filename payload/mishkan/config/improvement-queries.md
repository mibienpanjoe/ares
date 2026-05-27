# MISHKAN — Improvement Layer Queries

Saved queries the improvement layer runs against Cognee (and the observability
aggregate) to make MISHKAN better over time. Run after `/sprint-close`, once two
or three sprints of data exist.

These are intent specifications; the concrete query syntax binds to the deployed
Cognee API (D-001). Each maps to an action.

| # | Query intent | Reads | Action it drives |
|---|---|---|---|
| 1 | **Most expensive agents per sprint** | observability aggregate (cost, tokens) + `Agent` nodes | Prompt-optimisation targets; retier a costly Sonnet→Haiku where quality allows |
| 2 | **Tools called most per team** | observability aggregate (tool_calls) grouped by team | MCP access refinement; prune unused tool grants, keep the <10 MCP / <80 tool budget |
| 3 | **Blocker hot spots** | `Task` nodes with `blocks` edges, clustered | Workflow bottleneck detection; resequence or split tasks |
| 4 | **Components accumulating findings** | `SecurityFinding` nodes grouped by `location` | Structural risk surfacing; flag a component for refactor/threat-review |
| 5 | **Curated library hit rate per problem class** | `CuratedLibraryHit` joined to `CuratedResource` | Identify under-used resources (prune) and high-value ones (promote); detect gaps where the web pipeline is used because the library lacks coverage |
| 6 | **Cache hit rate per agent** | observability aggregate (tokens_cached / tokens_input) | Validate the token-optimisation layer; fix agents whose static prefix is not caching |
| 7 | **Research outcome ratio** | `ResearchOutput` nodes (resolved/partial/blocked) | Detect problem classes the pipeline repeatedly fails; seed the curated library |

## Cadence

- Per sprint close: run queries 1–3, 6 (cost + flow health).
- Every ~3 sprints: run queries 4, 5, 7 (structural + library health).

## Owner

Nehemiah + Bezalel review the outputs at sprint close and decide actions
(retiering, MCP pruning, library updates, refactor flags). The improvement layer
surfaces; the orchestrators act.
