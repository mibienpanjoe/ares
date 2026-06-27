---
description: Manually promote a learning into native memory/docs or Cognee at an explicit blast-radius tier.
argument-hint: "<agent-private|team-level|cross-harness> <what to promote>"
---

Manually promote a learning. Check the project state's `Memory backend` first.

Requested promotion: $ARGUMENTS

Parse the first token as the blast-radius tier and the rest as the learning.

- `agent-private` → record in native agent/runtime memory or the agent's
  `MEMORY.md`; do **not** write Cognee.
- `team-level` → Team Lead decision; update team rules / shared topic file, and
  if Cognee is enabled, write a `team-level` Cognee node.
- `cross-harness` → requires Nehemiah + Bezalel sign-off; update the durable
  docs/rules. If Cognee is enabled, write a `cross-harness` Cognee node per
  `~/.claude/mishkan/ontology.md` with the correct entity type and edges.

If the tier is ambiguous, ask: does this affect only the agent, the team, or
everyone? No fabricated facts. English only.
