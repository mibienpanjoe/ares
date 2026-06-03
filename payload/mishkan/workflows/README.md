# MISHKAN workflows

Seven dynamic-workflow scripts that codify the orchestrations where
parallel scale + repeatability justify a script. Each maps to one or
more of the nine canonical workflow patterns from
[Anthropic's reference](https://code.claude.com/docs/en/workflows) and the
[community patterns catalogue](https://github.com/ray-amjad/claude-code-workflow-creator/blob/main/references/patterns.md).

These run from the **main session only** (subagents cannot invoke
`Workflow`). Skills wire the invocation paths.

## Catalogue

| Script | Pattern combo | Real problem it solves | When to invoke |
|---|---|---|---|
| [`mishkan-sprint-close.js`](mishkan-sprint-close.js) | barrier `parallel()` + aggregator | The six Team Reporters need to emit at once and Nehemiah needs the complete set to surface cross-team handoffs | At `/sprint-close` |
| [`mishkan-deep-research.js`](mishkan-deep-research.js) | pipeline + adversarial verify + barrier | The research pipeline's six stages with 3-vote refute per finding; replaces sequential Task delegation when false-confident answers are costly | Any unknown where verification matters |
| [`mishkan-codebase-audit.js`](mishkan-codebase-audit.js) | multi-modal sweep + fan-out + dedup + adversarial verify | Bug / security / hardening / perf / a11y / contract sweep across a whole project; one auditor lens per file class | Periodic audits; pre-release reviews; post-incident hardening |
| [`mishkan-migration-wave.js`](mishkan-migration-wave.js) | pipeline (find → transform → review → verify) + worktree isolation + judge panel on review | Refactors / framework swaps / contract renames across many files; per-file independence with 2-reviewer accept gate | Refactors, deprecations, framework swaps |
| [`mishkan-architecture-panel.js`](mishkan-architecture-panel.js) | judge panel + impact-fanout + synthesis | Architecture decisions with a wide answer space; 3 Nathan runs from cost/scale/simplicity priors; Zadok+Phinehas+Shallum score; Bezalel synthesises | High-leverage architecture decisions |
| [`mishkan-release-readiness.js`](mishkan-release-readiness.js) | barrier `parallel()` + structured pass/fail + nested workflow | Pre-deploy gate: tests + security + dependency + SLO + pipeline shape, all at once → single go/no-go | Before every staging-to-prod deploy |
| [`mishkan-init.js`](mishkan-init.js) | pipeline with overlap (PRD → SRS → CONTRACT+ARCH in parallel → THREAT+C4 in parallel → settle) | Cut project init from hours to minutes without violating the sequence rule | Once per project at `/mishkan-init` |

## The patterns each script uses

| Pattern | Used by |
|---|---|
| Fan-out → synthesize | `codebase-audit`, `release-readiness`, `architecture-panel` |
| Pipeline (overlapping) | `deep-research`, `migration-wave`, `init` |
| Barrier `parallel()` | `sprint-close`, `release-readiness`, `architecture-panel` (Vote stage) |
| Adversarial verification (3-vote refute) | `deep-research`, `codebase-audit` |
| Judge panel | `architecture-panel`, `migration-wave` (2-reviewer accept) |
| Nested workflow | `release-readiness` → `codebase-audit` |
| Loop-until-X | — (mechanism inside scripts when needed; no top-level loop workflows yet) |

## Cost discipline

Workflows are expensive. The community baseline is **3–6 workflows per
production team**. Seven is the working ceiling — adding more
typically means the new use case is better served by Task delegation
or a skill.

Cost expectations per run (subagent-tokens, rough orders of
magnitude):

| Script | Typical cost | Notes |
|---|---|---|
| `mishkan-sprint-close` | low | 6 reporters; bounded by team count |
| `mishkan-deep-research` | medium | 6 stages × per-sub-question fan-out; verify multiplies |
| `mishkan-codebase-audit` | high | `files × lenses` audits, plus 3-vote per finding |
| `mishkan-migration-wave` | very high | `files × (1 transformer + N reviewers + verify)`; the Bun-shape |
| `mishkan-architecture-panel` | medium | 3 proposals × 3 reviewers + synthesis |
| `mishkan-release-readiness` | low-medium | 7–8 parallel checks; nested audit if enabled |
| `mishkan-init` | medium | 6 artefacts pipelined |

Run on a small slice first (one directory; one phase) before
committing to a full wave.

## Where these get invoked from

The Skills that wire main-session invocation paths:

- `nehemiah-pm-craft` — `mishkan-sprint-close`, `mishkan-release-readiness`
- `bezalel-cto-craft` — `mishkan-architecture-panel`, `mishkan-release-readiness`
- `phinehas-cto-craft` (via `team-lead-craft`) — `mishkan-codebase-audit`
- `eliashib-cto-craft` (via `team-lead-craft`) — `mishkan-release-readiness`
- `jehoshaphat-cto-craft` (via `team-lead-craft`) — `mishkan-init`
- The research pipeline agents reach the deep-research workflow via the orchestrator path

## Adding a workflow

Don't, unless:

1. The task runs ≥ 10 times per quarter (justifies codification).
2. The parallel agent count is ≥ 6 (justifies the workflow runtime over Task delegation).
3. The repeatability is real (same orchestration each time, just different inputs).

Otherwise: Task fan-out from the main session is the right answer.
The seven workflows above were picked precisely because each clears
all three bars.

## Constraints (reminders)

- Workflows are main-session-only.
- Nesting limit: one level. `release-readiness` can call `codebase-audit`; `codebase-audit` cannot call another workflow.
- Concurrency cap: `min(16, cpu-2)` per run; shared across nested.
- Cap of 1,000 agents per run (Anthropic platform limit).
- Date/random functions disabled inside scripts. Pass timestamps via `args` if needed.
