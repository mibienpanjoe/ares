---
description: Manually promote a learning into Cognee at an explicit blast-radius tier.
argument-hint: "<agent-private|team-level|cross-harness> <what to promote>"
---

Manually promote a learning using the **cognee-promote** skill.

Requested promotion: $ARGUMENTS

Parse the first token as the blast-radius tier and the rest as the learning.

- `agent-private` → record in the agent's `MEMORY.md`; do **not** write Cognee.
- `team-level` → Team Lead decision; update team rules / shared topic file, and
  write a `team-level` Cognee node.
- `cross-harness` → requires Nehemiah + Bezalel sign-off; write a `cross-harness`
  Cognee node per `~/.claude/mishkan/ontology.md` with the correct entity type and edges.

If the tier is ambiguous, ask: does this affect only the agent, the team, or
everyone? No fabricated facts. English only.
