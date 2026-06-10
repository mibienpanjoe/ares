# MISHKAN workflows

Twenty dynamic-workflow scripts — ten org-level + ten team-level —
that codify the orchestrations where parallel scale + repeatability
justify a script. Each maps to one or more of the nine canonical workflow
patterns from
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
| [`mishkan-blast-radius.js`](mishkan-blast-radius.js) | Graphify discovery + 3-lens orthogonal verify + synthesis | "What does this change actually touch?" Refactor blast-radius with three load-bearing lenses (caller-side / data-contract / runtime-behavior) so false positives drop before scheduling | Before editing a function whose downstream impact is uncertain; gated by `/plan` |
| [`mishkan-knowledge-gap-discovery.js`](mishkan-knowledge-gap-discovery.js) | parallel probe + **loop-until-dry** + research fan-out | Probe Cognee work for expected concepts; an org-level loop-until-X case — confirm gaps via paraphrase retries before dispatching research (QA-convergence is the team-level loop-until-X case, see the feature-ship workflows) | Sprint close (optional barrier step) or after `/sefer-pull` |
| [`mishkan-standards-rollout.js`](mishkan-standards-rollout.js) | pipeline (translate → verify) + barrier + judge panel (Bezalel + scope-conditional reviewers) | When a new rule lands in `y4nn-standards.md`, it propagates per-team with translation, drift verification, and CTO ratification — closes the silent failure mode of rules drift | When a new standard ships; BEFORE the rule is considered live across the fleet |

## The patterns each script uses

| Pattern | Used by |
|---|---|
| Fan-out → synthesize | `codebase-audit`, `release-readiness`, `architecture-panel`, `blast-radius` |
| Pipeline (overlapping) | `deep-research`, `migration-wave`, `init`, `standards-rollout` |
| Barrier `parallel()` | `sprint-close`, `release-readiness`, `architecture-panel` (Vote stage), `knowledge-gap-discovery`, `standards-rollout` |
| Adversarial verification (3-vote refute) | `deep-research`, `codebase-audit` |
| Orthogonal 3-lens verify (caller / data / runtime) | `blast-radius` |
| Judge panel | `architecture-panel`, `migration-wave` (2-reviewer accept), `standards-rollout` (Bezalel + scope-conditional) |
| Nested workflow | `release-readiness` → `codebase-audit` |
| Loop-until-X | `knowledge-gap-discovery` (paraphrase-retries to confirm gaps before research); `yasad-feature-ship`, `panim-feature-ship`, `chosheb-feature-ship` (loop until QA returns zero blockers); `mishmar-security-gate`, `migdal-infra-change` (conservative — one remediation cycle then escalate) |

## Team-level catalogue

Ten team-level workflows codified per ADR D-010 (cap 4/team, PM+CTO
co-owned). Invoked through the Team Lead's craft skill. The feature-ship
workflows are the deterministic, unskippable form of the team-lead-craft
§6.1 chain (Lead → Specialist → QA → loop-until-no-blockers → escalate).

| Script | Pattern combo | Real problem it solves | Team |
|---|---|---|---|
| [`chosheb-feature-ship.js`](chosheb-feature-ship.js) | 4-lens panel + **loop-until-ready** + synthesis | Design → handoff package complete (DS fit + a11y + assets + QA), looping until ready-to-ship | Chosheb |
| [`panim-feature-ship.js`](panim-feature-ship.js) | route + implement + 3-lens panel + **loop-until-QA** | Frontend feature run through a11y / DS-fit / QA panel, looping on blockers until clean or escalate | Panim |
| [`panim-ds-rollout.js`](panim-ds-rollout.js) | pipeline + worktree + judge panel | Design token change propagated to all consumers with a11y + regression review | Panim |
| [`yasad-feature-ship.js`](yasad-feature-ship.js) | route + implement + 3-lens panel + **loop-until-QA** | Backend feature run through contract / tests / data-safety panel, looping on blockers until clean or escalate | Yasad |
| [`yasad-data-migration-wave.js`](yasad-data-migration-wave.js) | pipeline + 4-lens judge panel | Wave of DB migrations, per-table reviewed (contracts/perf/security/tests) | Yasad |
| [`yasad-schema-evolution.js`](yasad-schema-evolution.js) | pipeline + per-phase judge panel | Phased schema change with zero-downtime invariants + per-phase rollback | Yasad |
| [`mishmar-security-gate.js`](mishmar-security-gate.js) | barrier + 3-vote adversarial refute + **conservative loop** | Security gate on sensitive surface (auth/payment/PII), 3 orthogonal lenses; one remediation-proposal cycle then escalate | Mishmar |
| [`migdal-infra-change.js`](migdal-infra-change.js) | barrier + 5-lens panel + **conservative loop** | Infra change validated by design/systems/devops/observability/health lenses; one remediation-proposal cycle then escalate | Migdal |
| [`migdal-dr-drill.js`](migdal-dr-drill.js) | pipeline + per-step judge panel | DR drill — enumerate, simulate, verify, RTO/RPO measurement, gap report | Migdal |
| [`sefer-release-notes.js`](sefer-release-notes.js) | pipeline + per-category fan-out + style synthesis | Release notes assembled from git log per category with style-guide application | Sefer |

Spare slots (Chosheb 3, Panim 2, Yasad 1, Mishmar 3, Migdal 2, Sefer 3)
are deliberately open; candidates compete for them at PM+CTO review. The
three amended workflows (chosheb-feature-ship, mishmar-security-gate,
migdal-infra-change) gained the loop in place — no new slot consumed.

## Portfolio governance — D-010

The portfolio is **PM + CTO co-owned** with hard caps and an anti-pattern
canon (ADR D-010, 2026-06-07). Nehemiah owns scope, delivery, recurrence
justification; Bezalel owns orchestration shape, schema contracts, quality
bar. New workflows land through joint review — not ad hoc.

**Hard caps.** 10 org-level (full) + 4 per team (varies). To add, retire.
**Soft retirement.** Workflows that fire < 2× in 3 sprints surface at
`/sprint-close` for PM+CTO retirement vote; default is `workflows/proposed/`.

The June 2026 portfolio review produced the org-level additions
(`blast-radius`, `knowledge-gap-discovery`, `standards-rollout`), the
org-level removal (`multi-perspective-review` was theatre vs the existing
`architecture-panel`), the eight team-level workflows above, and the
anti-patterns below.

### Anti-patterns to avoid (D-010)

1. **Skill-in-workflow-clothing.** Linear sequence, no parallelism, no
   termination predicate, no panel — that's a skill, not a workflow.
2. **Workflow calling workflow without a contract.** Nested workflows
   are valid (cf. `release-readiness` → `codebase-audit`) only when the
   inner workflow's output schema is consumed structurally. Free-form
   nesting hides token cost and breaks retry semantics.
3. **Judge panels with non-orthogonal reviewers.** If two reviewers in
   a panel share 70%+ of their evaluation criteria, the panel is
   theatre. Each lens must be load-bearing and distinct (`blast-radius`
   enforces this with caller-side / data-contract / runtime-behavior).
4. **Workflow-as-status-page.** Orchestration that fans out to gather
   state without synthesis is a dashboard query, not a workflow. If the
   synthesis stage is missing or trivial, the work belongs in
   observability, not in `Workflow()`.

## Cost discipline

Workflows are expensive. The community baseline is **3–6 workflows per
production team**. The MISHKAN hard cap is **10 org-level + 4 per team**
(current count: 10 org + 10 team across 6 teams = 20 total). Adding more
typically means either (a) the new use case is better served by Task
delegation or a skill, or (b) an existing workflow should be retired —
soft-retirement happens after a workflow fires < 2× across 3 sprints,
under PM+CTO review.

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
| `mishkan-blast-radius` | medium | `sites × 3 lenses` + discovery + synthesis; short-circuits on empty graph |
| `mishkan-knowledge-gap-discovery` | medium-high | probe × N concepts + loop-until-dry rephrasings + research fan-out per gap |
| `mishkan-standards-rollout` | low-medium | 6 translations + 6 verifications + 1-3 ratifiers (scope-conditional) |

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
The 10 org-level + 10 team-level workflows above were picked precisely
because each clears all three bars; the portfolio is capped at 10 + 4
per team per ADR D-010.

## Constraints (reminders)

- Workflows are main-session-only.
- Nesting limit: one level. `release-readiness` can call `codebase-audit`; `codebase-audit` cannot call another workflow.
- Concurrency cap: `min(16, cpu-2)` per run; shared across nested.
- Cap of 1,000 agents per run (Anthropic platform limit).
- Date/random functions disabled inside scripts. Pass timestamps via `args` if needed.
