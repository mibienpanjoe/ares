---
name: research-pipeline
description: MISHKAN shared research pipeline. Use when any agent faces an unknown and must research it. Orchestrates Jakin (clarify) → Ezra (formulate) → Caleb (web research) → Shaphan (summarise) → Shemaiah (evaluate) → Baruch (report). Produces a research-log.json entry and, on resolve, a Cognee node. Invokable by any agent at any time.
---

# Research Pipeline

The shared research workflow. Any agent that hits an unknown invokes this rather
than guessing. The pipeline is six stages, run in order, each a separate subagent.

## When to use

- An agent faces a problem it cannot resolve from its own knowledge or the
  curated library.
- the engineer explicitly requests research.

## Stages

1. **Jakin** (clarificator) — raw query → clarified intent + open questions.
   If intent is unclear, resolve open questions with the caller before proceeding.
2. **Ezra** (formulator) — clarified intent → research brief. Checks the curated
   library / Cognee first; if matched, short-circuit and skip to step 6 with
   `curated_library_match: true`.
3. **Caleb** (web researcher) — brief → raw findings with sources. Plans first
   if the brief is multi-source.
4. **Shaphan** (summariser) — raw findings → tight summary, sources preserved.
5. **Shemaiah** (evaluator) — summary → verdict (resolved/partial/blocked) +
   confidence + gaps + curated-library agreement.
6. **Baruch** (reporter) — emits the `research-log.json` entry and, on resolve
   with cross-harness blast radius, writes a Cognee node.

## How to run it

Invoke each stage as a subagent via the Task tool, passing the prior stage's
output as input. Do not collapse stages — generation and evaluation stay separate
(Shaphan summarises, Shemaiah judges, Baruch records; none of them do each
other's job).

## Output contract

The pipeline returns one `research-log.json` object validating against
`~/.claude/mishkan/templates/research-log.schema.json`, plus a `cognee_node_id`
when a node was written. The calling agent attaches this log to its task; the
Team Reporter collects it at milestone.

## Model tiers

Jakin, Ezra, Caleb run on Sonnet. Shaphan, Shemaiah, Baruch run on Haiku. No
local models — Claude Code routes tiers natively per each agent's frontmatter.

## Constraints

Every stage obeys the universal constraints: stateful operations hard stop,
scope boundary, no fabricated facts, English output. The pipeline never executes
stateful operations — it only researches.
