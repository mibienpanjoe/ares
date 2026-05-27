---
name: context-compress
description: Cognee offloading helper. Writes a full artifact (research output, decision record, long finding) to the Cognee graph and returns a compact summary plus the node id for the context window. Use to keep context lean — full content in the graph, summaries in context.
---

# context-compress

Keep the context window lean. Full content lives in Cognee; only summaries enter
context. Nothing gets dumped raw into the window.

## When to use

- A research output, decision record, audit, or long finding would otherwise sit
  verbatim in context.
- An agent needs to hand a large artifact to another agent without inlining it.

## Steps

1. Take the full artifact.
2. Write it to Cognee as the appropriate entity (per `~/.claude/mishkan/ontology.md`),
   returning a `cognee_node_id`.
3. Produce a compact summary (the signal: what it is, the conclusion, the node id).
4. Return only the summary + node id to the caller. The caller (or a downstream
   agent) queries Cognee for full detail on demand.

## Output

```
summary: <compact>
cognee_node_id: <id>
```

## Constraints

No information loss in the graph (full fidelity stored). The summary must carry
enough to decide whether to fetch the full node. English only.
