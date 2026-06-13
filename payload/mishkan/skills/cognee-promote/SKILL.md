---
name: cognee-promote
description: Promote knowledge into Cognee by blast radius. Routes a learning to the right tier — agent-private (stays in MEMORY.md), team-level (team rules + topic files, Team Lead decides), or cross-harness (Cognee project graph, Nehemiah + Bezalel at sprint close). Use when an agent has a learning worth keeping.
---

# cognee-promote

Promote a learning to the correct tier. Promotion is orchestrated, not automatic
(noise floods the graph) and not manual (signal gets lost). Blast radius decides.

## Decide the tier

Ask: **does this learning affect only me, my team, or everyone?**

| Blast radius | Destination | Who decides | When |
|---|---|---|---|
| agent-private | subagent `MEMORY.md` | the agent | autonomous, anytime |
| team-level | team rules + shared topic file | Team Lead | on trigger or at milestone |
| cross-harness | Cognee project graph node | Nehemiah + Bezalel | at sprint close (or immediately if high blast radius) |

These three tiers all write to **work-store knowledge** — the project's own graph
(per-project Ladybug, D-012) or its cross-harness equivalent. They are about *what we
learned and decided*.

**Distinct tier — the curated library (D-016).** A vetted, reusable *external
resource* (a vendor doc, a spec, a primary reference) found during research belongs
in the shared **curated library** (`cognee-curated`, :7730), not the work store. That
path is separate and **engineer-gated**: Shemaiah nominates a `curated_promotion_candidate`,
Baruch queues it, and the engineer approves at `mishkan knowledge curate` (additive
write, no prune, dedup by url). Do not route a `CuratedResource` through the work-store
tiers above, and never write to curated from an agent — it is read-only at the agent
layer by design.

## Two triggers

- **Immediate** — the learning affects another agent's *current* work. The agent
  flags it to its Team Lead. Team Lead promotes to team-level (topic file) or
  cross-harness (write to Cognee now). High signal, low volume.
- **Milestone** — the Team Reporter collects sprint learning; resolved research
  and decisions are promoted to Cognee at `/sprint-close`.

## Writing to Cognee

Conform to `~/.claude/mishkan/ontology.md`: pick the entity type (ResearchOutput,
Decision, CaseNode, SecurityFinding, ADR, Incident…), set `blast_radius`, and
add the relationship edges (validated-by, derives-from, supersedes, mitigates…).
Only `team-level` and `cross-harness` nodes go to Cognee; `agent-private` stays
in MEMORY.md.

## Constraints

No fabricated facts. Cross-harness promotion is gated by Nehemiah + Bezalel.
English only.
