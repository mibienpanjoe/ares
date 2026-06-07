# 11 — Graphify (code-structure graph)

> Goal: use Graphify as the **structural** layer of the MISHKAN
> three-store knowledge stack (Graphify · Cognee work · Cognee curated)
> so that "who calls X" / "what depends on Y" questions cost ~1.8k
> tokens instead of lifting the whole repo into context.

## What it is

[Graphify](https://github.com/safishamsi/graphify) is a tree-sitter
based code-graph extractor with a query path that traverses the graph
to answer structural questions. MIT, Python, `uv tool install`-able.
Per D-008 of the MISHKAN decision log, Graphify is the third store of
the knowledge stack:

| Store | Question it answers | Source |
|---|---|---|
| **Graphify** | *How is the code structured?* | tree-sitter AST + optional LLM enrichment, deterministic, re-derivable |
| **Cognee work** | *Why does this code exist and what did we decide?* | agent-ingested ADRs, runbooks, resolved research |
| **Cognee curated** | *What did we learn on other projects?* | seeded, read-only from projects |

These are non-overlapping by design: one writer per store, one
question type per store, no semantic mixing. The crisp test:
**structure → Graphify, semantics → Cognee work.**

## Install

```bash
uv tool install "graphifyy>=0.8.33"
graphify --version
```

The PyPI package is `graphifyy` (double-y), the binary is `graphify`.
The `>=0.8.33` pin matters — earlier 0.8.x had a test-file-orphan bug
(test imports didn't resolve to file-level edges, so test files looked
disconnected from the source they covered). Fixed in 0.8.33.

Useful soft-breaking change in 0.8.29 to be aware of: project-local
providers under `./.graphify/providers.json` no longer auto-load by
default. Set `GRAPHIFY_ALLOW_LOCAL_PROVIDERS=1` if you use per-project
LLM providers (the deterministic AST path doesn't need this).

## Bring up the graph for a project

From the project root:

```bash
graphify update .
```

First run on the MISHKAN harness: **205 files → 2,370 nodes → 27.8 s**.
Subsequent `graphify update .` runs are incremental and sub-second on
warm cache.

**Keep the graph fresh — install the git hooks.** The canonical
maintenance path (recommended by the upstream community, not cron):

```bash
graphify hook install   # registers post-commit / post-checkout / post-merge / post-rewrite
                        #   + a `graphify-json` git merge driver so the graph
                        #     union-merges on parallel branches (no conflicts)
graphify hook status
graphify hook uninstall # later, if you want to remove them
```

Without the hooks the graph drifts vs HEAD silently — symptoms (from
upstream issues): `graphify query` returns stale `file:line` citations,
`GRAPHIFY_OUT/GRAPH_REPORT.md` stays at the old node count after a
refactor. The hooks rebuild incrementally in milliseconds; the merge
driver makes `graph.json` conflict-free across branches.

Output lives in `<project>/graphify-out/`:

```
graphify-out/
├── graph.json          # the AST graph (consumed by `graphify query`)
├── graph.html          # interactive visualisation, open in a browser
├── GRAPH_REPORT.md     # god-nodes + anomalies + community summary
└── manifest.json       # quick stats (nodes / edges / communities)
```

> `graphify-out/` is gitignored in this repo (project-local artefact,
> re-derivable). On your own projects, decide per-project whether to
> commit it; the harness convention is to NOT commit it.

## Querying

```bash
graphify query "who calls process_payment"
graphify query "what depends on the User model" --budget 1500
graphify affected "process_payment" --depth 3
graphify path "ClassA" "ClassB"
graphify explain "MishkanWatch"
```

Default budget is 2000 tokens; the answer is plain text with `file:line`
citations.

POC numbers on the MISHKAN harness (2026-06-07):

| Question | Tokens | Ratio vs naive baseline |
|---|---:|---:|
| how does authentication work | ~2,116 | 74.7× |
| what is the main entry point | ~1,842 | 85.8× |
| how are errors handled | ~1,115 | 141.8× |
| what connects the data layer to the api | ~2,278 | 69.4× |
| what are the core abstractions | ~1,619 | 97.6× |
| **average** | **~1,793** | **88.1×** |

Naive baseline = lifting all 118,500 words / ~158,000 tokens of source
into the model context (Graphify's own README methodology). Full
method: `docs/research/graphify-token-saving-poc.md`.

> **Important footnote on the 88.1×.** This is a *mixed-corpus,
> naive-baseline* ratio — the same methodology as Graphify's upstream
> 71.5× claim. Third-party measurements on *real Claude / Cursor
> sessions* (where the assistant already scopes) report much smaller
> reductions: roughly **7-8×** on small targeted sessions, **7-30×**
> on real codebases. Treat 71.5× / 88.1× as **directional**, not
> spec-grade: they prove "Graphify costs orders of magnitude less than
> reading everything" — they don't prove "your next chat session costs
> 88× fewer tokens." The advisory hook (D-009) measures the real-session
> ratio in Phase 1 so we can tighten this claim.

## How MISHKAN agents use it

The five code-writing specialists (Hizkiah, Salma, Oholiab, Nathan,
Zadok) load the **graphify-query-craft** skill. Its core rule:

> Structure question → `graphify query`.
> Semantic question → Cognee work.

The PreToolUse hook **`pre-tool-graphify-nudge.py`** (per D-009) runs
in two phases:

- **Phase 1 (current)** — telemetry-only. Counts every structural Read
  / bare-identifier Grep without blocking or injecting advisory text.
  Used to baseline the rate before Phase 2 lands.
- **Phase 2 (future ADR)** — advisory injection. When a structural
  Read fires for one of the five specialists, a one-line reminder is
  attached to the tool input's permissionDecisionReason field saying
  "Consider `graphify query` first." Never blocks; opt-out via
  `tool_input.metadata.skip_graphify_nudge = true` (per-call) or
  `MISHKAN_GRAPHIFY_NUDGE=off` (per-session).

Performance contract for the hook: ≤50 ms p95, fail-open everywhere.

## Knowledge-tab observability

The TUI's **Knowledge** tab surfaces Graphify activity alongside Cognee
in the "Recent ops" panel:

- `graphify_scan` events fire when `graphify-out/graph.json` mtime
  changes (i.e. after `graphify update .` completes). The event payload
  carries `nodes`, `edges`, `communities` from the manifest.
- `graphify_query` events fire when `graphify save-result` lands a new
  file under `graphify-out/memory/`. The payload carries the question
  + a 200-char excerpt of the answer.

Both events come from the daemon source `graphify_tail` (Python
asyncio, polls every 5 s, fail-open).

## When NOT to use Graphify

Per D-008's "what NOT to do" list:

- Don't use Graphify to answer SEMANTIC questions ("why is this
  deprecated?"). Those go to Cognee work.
- Don't use it on a project that doesn't have a `graphify-out/` dir —
  the cost of an initial scan (~28 s on a 200-file repo) is not paid
  for a single one-off structural question. Fall back to grep / Read.
- Don't cite a graph answer without the `file:line` citations from the
  query output — "according to the graph" without an id is fabrication.

## Known limitations (community-sourced)

- **Dynamic dispatch / reflection** — `getattr`, `eval`,
  dict-of-callables, runtime monkey-patching are invisible to AST.
  Recent 0.8.x added cross-language type-reference edges that recover
  *some* missing links via type context, but the gap stays.
- **Runtime configuration** (env vars, feature flags, DI containers,
  Spring-like wiring) — not in the AST. Community recipe: feed the YAML/
  JSON config files as docs into the same graph; Graphify's multi-modal
  ingest will surface them as nodes.
- **`GRAPHIFY_OUT` env var ignored by `query` / `path` / `explain`** —
  upstream issue still open at research time. If you relocate
  `graphify-out/`, pass `--graph <path>` explicitly instead.
- **`./.graphify/providers.json` no longer auto-loads** (0.8.29
  soft-break). Set `GRAPHIFY_ALLOW_LOCAL_PROVIDERS=1` if you use
  per-project provider configs.

## Project init

`/mishkan-init` (per the updated skill) optionally runs the initial
`graphify update .` after the spec chain lands, so the project has a
graph from sprint S0 onwards. Skipped automatically on projects that
opted out of the structural layer.

## See also

- [D-008](../design/MISHKAN_decisions.md#d-008) — three-store knowledge
  epistemology.
- [D-009](../design/MISHKAN_decisions.md#d-009) — graph-first PreToolUse
  advisory hook (Phase 1 telemetry-only at v0.2.3, Phase 2 advisory
  injection planned).
- [POC report](../research/graphify-token-saving-poc.md) — verified
  88.1× reduction on the MISHKAN harness, 2026-06-07.
- [Memory layer](./04-memory-layer.md) — the Cognee work and curated
  stores that complete the three-store stack.
- Upstream — https://github.com/safishamsi/graphify.
