---
name: code-graph
description: Inspect, refresh, or open the Graphify code-structure graph for the current project. Wraps `npx mishkan-harness code-graph` so it's reachable from any Claude Code session. Three subcommands — `status` (default, prints nodes/edges/last-scan), `scan` (runs `graphify update .` to refresh the index), `open` (opens graph.html in the browser). Use when you need to know the current state of the code graph, when you've made code changes and want a fresh index, or when you want to visually browse the call structure.
---

# /code-graph

Wrapper for the harness's code-graph (Graphify) inspection. Runs the
`npx mishkan-harness code-graph` CLI subcommand on behalf of the user.

## Subcommands

```bash
npx mishkan-harness code-graph status   # default — nodes/edges/last-scan
npx mishkan-harness code-graph scan     # refresh the index (graphify update .)
npx mishkan-harness code-graph open     # open graph.html in browser
```

## When to suggest each

- **`status`** — first action when the user asks "is graphify up to date" or "how big is my graph". Cheap, no side effects.
- **`scan`** — after a meaningful round of code edits (refactor, new module, dependency added). Or when the advisory hook fires and the agent isn't sure whether the graph reflects current state.
- **`open`** — when the user asks to "see" or "visualise" the call graph. Opens the static HTML Graphify writes alongside `graph.json`.

## Behaviour

- Looks for `graphify-out/` in the current project root. If missing, surfaces the install hint (`graphify update .` to create one, or `uv tool install "graphifyy>=0.8.33"` if graphify itself isn't installed).
- Always succeeds with output even when the graph is empty or stale — the CLI is designed to be informative, not gating.
- Stateful: `scan` modifies `graphify-out/`. `status` and `open` are read-only.

## See also

- ADR `D-008` and `D-009` — the cost rationale and the advisory-hook design
- `docs/usage/11-graphify.md` — full usage chapter
- `graphify-query-craft` skill — when and how the 20 code-touching agents query
