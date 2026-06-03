# 09 — Dynamic Workflows

> Goal: explain when MISHKAN reaches for a dynamic workflow vs ordinary
> Task delegation, the seven workflows shipped, and the cost gate that
> keeps the count from drifting up.

## What a workflow is, in one paragraph

A dynamic workflow is a JavaScript script the **main session** executes
via the `Workflow` tool. It spawns subagents in parallel (cap:
`min(16, cpu-2)` per run; 1,000 agents per run absolute max), validates
their structured outputs at the tool layer, and returns a single
synthesised result. Workflows are **main-session-only** — a subagent
cannot call `Workflow`. They earn their cost when the alternative
would be sequential Task delegation that wastes wall-clock or hides
errors that adversarial verification would catch.

Reference: [Anthropic docs — orchestrate subagents at scale](https://code.claude.com/docs/en/workflows).

## When to reach for one

The gate MISHKAN applies — **yes only if all three**:

1. The task runs ≥ 10× per quarter (justifies codification).
2. The parallel agent count is ≥ 6 (justifies workflow runtime cost
   over Task delegation).
3. The orchestration is repeatable in shape (same script, different
   inputs).

Anything that fails any of the three is better as Task fan-out from
the main session.

## The seven workflows

| Workflow | Pattern | Invoked by | Args |
|---|---|---|---|
| [`mishkan-sprint-close`](../../payload/mishkan/workflows/mishkan-sprint-close.js) | barrier + aggregator | Nehemiah at `/sprint-close` | `{ sprint }` |
| [`mishkan-deep-research`](../../payload/mishkan/workflows/mishkan-deep-research.js) | pipeline + 3-vote refute | Baruch path; any high-stakes research | `{ intent, agent, team, sprint, applied_to_task? }` |
| [`mishkan-codebase-audit`](../../payload/mishkan/workflows/mishkan-codebase-audit.js) | multi-modal sweep + adversarial verify | Phinehas (security), Huram (a11y/perf), Bezalel (pre-release) | `{ project_root, lenses[], target_glob?, max_files? }` |
| [`mishkan-migration-wave`](../../payload/mishkan/workflows/mishkan-migration-wave.js) | pipeline + worktree + judge panel on review | Lead routes large refactor | `{ project_root, target_glob, transformation, transformer_agent, reviewers, verify_command? }` |
| [`mishkan-architecture-panel`](../../payload/mishkan/workflows/mishkan-architecture-panel.js) | judge panel + impact-fanout + synthesis | Bezalel gates wide-answer architecture decisions | `{ decision, context, horizon? }` |
| [`mishkan-release-readiness`](../../payload/mishkan/workflows/mishkan-release-readiness.js) | barrier + nested workflow | Nehemiah + Bezalel before every prod deploy | `{ project_root, release_tag, verify_commands, audit_security? }` |
| [`mishkan-init`](../../payload/mishkan/workflows/mishkan-init.js) | pipeline with overlap | `/mishkan-init` | `{ project_name, project_root, raw_intent, stack_hint? }` |

## How invocation actually happens

Subagents cannot invoke `Workflow`. The chain:

1. A craft skill (Nehemiah-PM, Bezalel-CTO, Team-Lead, Baruch-research,
   Hizkiah-impl) carries an explicit section saying *"the main session
   invokes Workflow(...) when X"*.
2. When the main session reads that skill in the context of X, it
   issues the `Workflow(...)` call directly.
3. The workflow runs in the background; `/workflows` watches progress.
4. The result lands as a single synthesised object — no turn-by-turn
   transcript in the main session's context.

If a subagent finds itself needing a workflow (e.g. Phinehas wants a
codebase audit), the subagent's response surfaces the recommendation
to the main session, which then decides whether to fire.

## Patterns the seven scripts use

From the [community patterns catalogue](https://github.com/ray-amjad/claude-code-workflow-creator/blob/main/references/patterns.md)
and Anthropic's docs:

| Pattern | Used by |
|---|---|
| Fan-out → synthesize | `codebase-audit`, `release-readiness`, `architecture-panel` |
| Pipeline with overlap | `deep-research`, `migration-wave`, `init` |
| Barrier `parallel()` | `sprint-close`, `release-readiness`, `architecture-panel` (Vote) |
| Adversarial verification (3-vote refute) | `deep-research`, `codebase-audit` |
| Judge panel | `architecture-panel`, `migration-wave` (2-reviewer accept) |
| Nested workflow (1 level) | `release-readiness` → `codebase-audit` |

## Cost — read the numbers, not the hype

Workflows are real money. Some references:

- The bundled `/deep-research` run on a personal-profile sweep this
  session: **98 agents**, **~2.8M subagent tokens**, ~8 min wall.
- The marquee public case (Bun Zig→Rust port): **hundreds of agents
  per workflow**, multiple workflows chained, 750k LoC, 11 days.

Per-workflow expected cost (rough orders of magnitude):

| Workflow | Cost class | Why |
|---|---|---|
| `sprint-close` | low | 6 reporters; bounded |
| `release-readiness` | low–medium | 7–8 parallel checks |
| `deep-research` | medium | 6 stages × per-sub-question fan-out × 3-vote |
| `architecture-panel` | medium | 3 proposals × 3 reviewers + synthesis |
| `init` | medium | 6 artefacts pipelined |
| `codebase-audit` | high | `files × lenses × 3-vote-verify` |
| `migration-wave` | very high | `files × (1 transformer + N reviewers + verify)` |

**Run on a small slice first.** For migration and audit, one directory
before the whole repo, one lens before all lenses.

## What's deliberately *not* a workflow

These were considered and rejected as workflows; they stay as Task
delegation or skills:

- Per-team PR review (`mishmar-pr-multi-lens`, `panim-test-matrix`):
  fail rule 1 (frequency) or rule 2 (agent count).
- Per-team handoffs (`chosheb-handoff-package`): fail rule 2.
- Component build per design handoff: fail rule 3 (shape varies per
  component too much for a stable script).
- N-per-team-sprint-close: composed via the orchestrator-tier
  workflow `mishkan-sprint-close`; no separate per-team workflow.

The line is: when a Task fan-out of ≤ 5 agents handles the work and
no adversarial verification is needed, no workflow.

## See also

- [`payload/mishkan/workflows/README.md`](../../payload/mishkan/workflows/README.md)
  — script catalogue with per-file links.
- [Anthropic docs — workflows](https://code.claude.com/docs/en/workflows).
- [The 9 patterns reference](https://github.com/ray-amjad/claude-code-workflow-creator/blob/main/references/patterns.md).
- [OneRedOak's 3-workflow production setup](https://github.com/OneRedOak/claude-code-workflows)
  — the inventory data point that anchored the 7-workflow ceiling.
