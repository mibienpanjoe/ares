---
name: graphify-query-craft
description: |
  Use `graphify query "<question>"` to traverse the project's code-structure
  graph for structural questions ("who calls X", "what depends on Y", "where
  is the entry point") at ~1.8k tokens per query — 88.1× cheaper than
  lifting the full source tree into context (verified on MISHKAN harness,
  POC 2026-06-07). Use BEFORE grep / Read on source files whenever the
  question is about code STRUCTURE rather than code SEMANTICS.
  For Hizkiah, Salma, Nathan, Zadok, Oholiab (per D-009).
---

# Graphify query craft

## When to call

The crisp test from D-008's epistemological frontier:

> **Structure question → Graphify.**
> **Semantic question → Cognee work.**

Examples of **structure** questions you should answer with a `graphify
query` BEFORE reading any file:

- "Who calls `process_payment`?"
- "What depends on the `User` model?"
- "Where is the main entry point?"
- "What is the call graph for the auth flow?"
- "What are the god nodes in this codebase?"
- "What connects the data layer to the API?"
- "Show me everything that imports `pandas`."

Examples of **semantic** questions that go to Cognee work, not Graphify:

- "Why was X deprecated?"  → ADR in Cognee work
- "What did we decide about Y last sprint?" → decision in Cognee work
- "How does the team handle Z?" → runbook in Cognee work

If you can't tell which side of the line you're on, prefer Graphify
first — its answer is cheaper and structurally precise. Cognee work is
the right second hop when the Graphify answer is structurally correct
but the engineer needs the WHY.

## How to call

The graphify CLI lives outside Claude Code (installed via
`uv tool install "graphifyy>=0.8.33"` — pin matters: 0.8.33 fixed the
test-file-orphan bug; earlier 0.8.x silently dropped test edges).
It writes graphs into `<project>/graphify-out/` and the queries
traverse `graphify-out/graph.json`.

```bash
# First, make sure the graph is current — fast on warm cache:
graphify update .

# Then ask the question:
graphify query "who calls process_payment"
```

### Pick the right traversal

- **`query`** (default BFS, ~2k tokens) — for "what surrounds this
  concept" questions. Fans out from the seed.
- **`query --dfs`** — for **tracing a flow** when you already know the
  entry node. Returns the call chain rather than the surrounding cluster.
  Example: `graphify query "process_payment" --dfs` walks the call chain
  from `process_payment` outward, single-thread.
- **`affected <node> --depth N --relations calls,imports`** — reverse
  BFS. Pre-commit blast-radius check. Use BEFORE editing a function
  whose downstream impact you don't fully know.
- **`path A B`** — directional shortest path. Add `--calls "[A]-->[B]"`
  to constrain to a specific edge family. Answers "does X ever reach Y?"
  without grep.
- **`explain <node>`** — node + neighbors + community context. Use when
  you have a known symbol and want a quick map of its surroundings —
  cheaper than `query`.

### Always pass `--context` explicitly

Graphify's heuristic edge-type detection is brittle on mixed-language
repos (well-documented community gotcha). When you know the question is
structural-calls, say so:

```bash
graphify query "who handles payment events" --context call --context import
graphify affected "User" --relations imports
```

This consistently outperforms heuristic-detection on the MISHKAN harness
and avoids the "why didn't it find that obvious caller" trap.

### Budget is rarely the dial you want

Default `--budget 2000` stays near 2k tokens even on 500k-word corpora.
Raising past ~8k almost always means **wrong seed** rather than budget
shortage. If the answer feels thin, re-seed (better question) before
re-budgeting.

The output is plain text that lists the graph path + the relevant
`file:line` citations. Cite them in your answer — per D-008
"citation discipline":

> When an agent answers from Graphify, it cites the graph node id and
> the source `file:line`. No "according to the graph" without an id.

## Cite, then optionally Read

A Graphify answer typically narrows the relevant set from "the whole
repo" (158k tokens) to "5-10 file:line citations" (~1.8k tokens). When
the engineer needs prose context for ONE of those citations, THEN you
Read that single file. The savings come from not Read-ing the other 200
files just to find the relevant ones.

Worked example, full flow:

```
1. Engineer: "Refactor process_payment to use the new TransactionContext."

2. You (Hizkiah / Salma / Nathan / Zadok / Oholiab):
   $ graphify query "who calls process_payment"
   → 7 file:line citations returned, ~1.8k tokens spent.

3. You: Read the 7 cited files (selective, not bulk).

4. You: Edit each call site to thread TransactionContext.
```

Without Graphify, step 2 becomes "grep recursively + Read every match"
which on a 158k-token corpus is ~80k+ tokens minimum and frequently
misses indirect dispatch.

## What graphify CAN'T do

- It does not understand call dispatch via dynamic strings (`getattr`,
  `eval`, `dict-of-callables`). Those edges are invisible.
- It does not capture runtime configuration (env vars, feature flags).
  Those are not in the AST.
- It does not understand cross-language boundaries (a Python call to a
  Node script via subprocess). Each language's AST is its own island.

When the question requires those, fall back to grep + Read with a
narrowed file set, or escalate to Cognee work for the documented
intent.

## Fail-open

If `graphify-out/graph.json` is missing or stale, run `graphify update
.` first (sub-second on warm cache). If the project doesn't use
Graphify at all (no `graphify-out/` dir), proceed with grep + Read as
normal — no graph means no Graphify query path, that's fine.

## Reference

- D-008 — three-store knowledge surface (Graphify · Cognee work · Cognee
  curated). The epistemological frontier between the three is the source
  of "which question goes where". See `docs/design/MISHKAN_decisions.md`.
- D-009 — graph-first PreToolUse advisory hook for the five code-writing
  specialists. The hook will, in Phase 2, surface a one-line reminder if
  you do a structural Read without consulting Graphify first.
- POC report — `docs/research/graphify-token-saving-poc.md` (88.1×
  average reduction, verified on MISHKAN harness 2026-06-07).
- Upstream Graphify — https://github.com/safishamsi/graphify.
