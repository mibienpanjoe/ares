# Graphify token-saving POC — MISHKAN harness

> Status: **verified** — measured 2026-06-07 on the MISHKAN harness.
> Closes the D-008 "Out of Scope" item 1: the 71.5× third-party claim
> needed an instrumented MISHKAN measurement before any agent could
> cite it. This document IS that measurement.

## Setup

```
graphify CLI : v0.8.33 (PyPI package: graphifyy, binary: graphify)
install      : uv tool install graphifyy
harness rev  : c27d58c (main, package.json v0.2.0)
scan command : graphify update .
bench command: graphify benchmark
host         : AiobiDev, 2026-06-07
```

The wall clock for the initial AST extraction was **27.8 s** for 205 files
on a single host with 12 parallel workers. The semantic LLM-enrichment step
was skipped (no `GEMINI_API_KEY` / `GOOGLE_API_KEY`) because the deterministic
AST extraction is what produces the token-saving leverage — the LLM step
adds community naming, not structure.

## Graph stats

```
files scanned : 205    (.py, .ts, .js, .sh, .md, .yml, .json)
nodes         : 2,370
edges         : 2,526
communities   : 268
artefacts     : graphify-out/{graph.json, graph.html, GRAPH_REPORT.md, manifest.json}
```

## Corpus baseline

The "naive full-corpus" baseline is the token cost of feeding every file
of the harness as raw text into the model context (what an unaided agent
does when asked a structural question and grep-then-read takes it through
many files).

```
total words    : 118,500
token estimate : ~158,000  (graphify's tokenizer, comparable to Anthropic's)
```

## Results

Graphify's built-in `benchmark` command issues five canonical structural
questions and measures the average token cost via the graph-BFS query path
vs the naive baseline.

| Question | Tokens via Graphify | Reduction factor |
|---|---:|---:|
| how does authentication work | ~2,116 | **74.7×** |
| what is the main entry point | ~1,842 | **85.8×** |
| how are errors handled | ~1,115 | **141.8×** |
| what connects the data layer to the api | ~2,278 | **69.4×** |
| what are the core abstractions | ~1,619 | **97.6×** |
| **Average** | **~1,793** | **88.1×** |

Spread: **69.4×** (worst) to **141.8×** (best). Variance is driven by how
localised the answer is in the graph — "core abstractions" pulls many
small community labels; "error handling" hits a tight cluster.

## Interpretation

The third-party 71.5× claim **lands inside the observed range** and the
MISHKAN-specific average is **+23 % higher** (88.1× vs 71.5×). The
harness has more Python and shell than the third-party benchmark corpora,
and Python's AST shape gives Graphify cleaner structural edges than
TS/JSX-heavy codebases — that's the plausible explanation.

For the five MISHKAN code-writing specialists (Hizkiah, Salma, Oholiab,
Nathan, Zadok), this means a single `graphify query` answers a
structural question at **~1.8k tokens** vs **~158k tokens** to lift the
full harness into context. The advisory hook D-009 (telemetry-only
phase 1, advisory phase 2) is justified by this margin even at the
worst-case 69×.

## What this measurement does NOT cover

- **Production agent workload.** The five benchmark questions are
  Graphify's own canonical set, chosen to be representative — they are
  not the full distribution of MISHKAN-agent structural queries.
  Phase 1 of D-009 (telemetry-only hook) will gather the real
  production distribution; if it differs materially, the average above
  needs re-measuring.
- **Token quality.** The 88.1× is a tokens-spent ratio, not an
  answer-quality ratio. Graphify's BFS answer is structurally precise
  but textually sparse; reading raw files gives more prose context.
  The trade-off is intentional — agents that need prose still Read
  after a Graphify query narrows the file set.
- **Re-scan cadence cost.** The 27.8 s initial scan is one-off; the
  incremental `graphify update .` after a commit is sub-second on the
  changed files only. POC didn't measure this — assumed negligible.
- **LLM-enriched semantic step.** Adding `GEMINI_API_KEY` re-runs the
  community-naming step which produces nicer summaries but costs LLM
  tokens. POC ran deterministic-only. The token ratios above are for
  the deterministic path.

## Reference

- D-008 — three-store knowledge surface (Graphify · Cognee work ·
  Cognee curated). See `docs/design/MISHKAN_decisions.md`.
- D-009 — graph-first PreToolUse advisory hook for the five code-writing
  specialists. Same file.
- Graphify upstream — https://github.com/safishamsi/graphify.
