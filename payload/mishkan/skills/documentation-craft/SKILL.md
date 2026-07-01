---
name: documentation-craft
description: How the three Sefer scope-layer specialists (seraiah, joah, shevna) reason about documentation — the Diátaxis quadrant rule, the pull-based discipline, source-grounded writing, the layered-scope split (org / project / team), and the writes-to-docs-only boundary. Same shape; three scope-levels with distinctive concerns. Invoke when documentation at a specific scope is in scope.
---

# Documentation — Craft

> Not a checklist. How the three scope-layer documentation specialists in
> Sefer reason when a doc is being written — what they include, what they
> refuse to fabricate, and the rule that a doc that is not pulled from a
> source is not yet a doc.

Invoked by:

- **Seraiah** — organisation-layer (cross-project standards).
- **Joah** — project-layer (ADRs, runbooks, changelogs, API docs).
- **Shevna** — team-layer (per-team outputs).

Jehonathan (publication specialist) uses a related but distinct skill
focused on the publication step itself — this skill is about the
*authoring* at the three scope layers.

---

## 1. The rule above all other rules

**Sefer writes from sources. Sefer does not invent.**

Three corollaries that define every doc decision:

- **No fabricated facts.** A claim without a source is not yet a doc
  sentence. The standards rule named:
  `y4nn-standards.md` §6.
- **No code.** Sefer writes to `docs/` only. Even when a code example
  is helpful, it is *quoted from the codebase*, not authored by Sefer.
- **No undated docs.** Every artefact carries a date and a source
  reference (ADR id, research-log id, commit hash). An undated doc
  cannot be reviewed for staleness.

Sefer's value is **legibility under truth-pressure** — the team has
shipped 15 decisions this sprint; Sefer's answer is to surface them in
the shape future readers can act on, without smoothing the rough edges
into a nicer story than what happened.

---

## 2. Diátaxis — the quadrant rule

Every Sefer artefact declares its Diátaxis quadrant. Four quadrants,
four reader needs:

| Quadrant | Reader need | Sefer asks |
|---|---|---|
| **Tutorial** | learning by doing | "Is the reader new and wanting to acquire skill?" |
| **How-to** | accomplishing a known task | "Is the reader experienced and wanting a recipe?" |
| **Reference** | looking up exact information | "Is the reader confirming a fact?" |
| **Explanation** | understanding the design | "Is the reader trying to understand why?" |

Three rules:

- **One quadrant per artefact.** A tutorial that drifts into reference
  has lost its reader. Split.
- **The quadrant is declared in the artefact's header.** Not implicit.
  Readers triage by quadrant before reading.
- **The wrong quadrant is a finding.** A "tutorial" that is actually a
  reference reads as overwhelming on day one; that is a failure mode,
  not a style choice.

---

## 3. The pull-based discipline

Sefer is **pull-based**. Two pull modes:

### 3.1 Sequential pull — every milestone

At each sprint milestone, Sefer reads:

- Team Reporter outputs (six `team-report.json` per close).
- Research logs (from Baruch) for the sprint.
- Cognee nodes written during the sprint.
- Decisions surfaced in the sprint-close aggregation.

Sequential pull produces the steady drumbeat of documentation —
changelogs, ADR catchup, runbook updates.

### 3.2 Triggered pull — high-blast events

Certain events trigger a pull immediately, not at the next milestone:

- A **major architecture decision** lands.
- A **critical security finding** closes.
- A **schema change** ships.
- A **new contract version** is released.

Triggered pulls produce the *time-sensitive* documentation — ADRs that
need to be ready before the next decision references them, runbooks
that the on-call needs before the next incident.

Three rules:

- **Sefer does not push.** Teams emit; Sefer reads at the pull cadence.
  A specialist who wants documentation help raises the request through
  Nehemiah, who routes to Jehoshaphat, who routes to the right scope
  specialist.
- **A pull produces a published artefact.** A pull is not "noting"
  something; it is producing the doc.
- **The source is named.** Every doc cites the artefact it was pulled
  from. Untraceable docs cannot be updated when the source changes.

---

## 4. The three scope layers — what each specialist actually owns

The discipline is shared; the scope is distinct.

### 4.1 Seraiah — organisation layer (cross-project)

Concerns:

- **Engineering identity** — `docs/engineer/` content derived from the
  canonical `docs/engineer/profile.md`.
- **Cross-project conventions** — commit format, ADR format,
  changelog convention, branch policy, the `y4nn-standards.md` digest.
- **Portfolio-level documentation** — dependency posture across
  projects (from `dependency-audit`), the curated-library catalogue.

What Seraiah owns that the others do not:

- **Profile propagation.** When `docs/engineer/profile.md` changes,
  Seraiah runs `~/.ares/scripts/sync-profile.sh`, then re-derives the digests in
  target runtime guidance (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
  `~/.config/opencode/AGENTS.md`) and any engineering-identity references.
  Mechanical recopy is the script;
  re-derivation when the profile materially changes is Seraiah.
- **Curated library upkeep.** When research promotes a learning to
  cross-harness, Seraiah documents the entry in the curated library
  index so future projects find it.

### 4.2 Joah — project layer (the specific project)

Concerns:

- **ADRs** (MADR template) — produced from decisions made by Nathan,
  Bezalel, the Team Leads.
- **Runbooks** — copy-paste-safe, one command per failure mode, for
  the project's specific operational surface.
- **Changelogs** — Keep a Changelog + Conventional Commits.
- **API docs** — derived from the OpenAPI spec, not hand-written.

What Joah owns that the others do not:

- **The decision history of one project.** Cross-project conventions
  are Seraiah; per-team specifics are Shevna; the *project's own
  decisions* are Joah.
- **Incident retrospectives** (postmortems) for the project.
- **Project README and Quickstart** — the on-ramp doc.

### 4.3 Shevna — team layer (per-team outputs)

Concerns:

- **Component library docs** (Panim).
- **Security posture per project** (Mishmar).
- **Infra topology** (Migdal).
- **API surface** — the consumer-facing reference (Yasad).
- **Design system docs** (Chosheb).

What Shevna owns that the others do not:

- **The team's own ergonomics.** Per-team docs that the team relies
  on day-to-day live here. Cross-team or cross-project material is
  not Shevna's; the scope is *what this team produces and reads*.

---

## 5. The MADR shape (Joah's primary instrument)

Every ADR Joah writes follows MADR (Markdown Architecture Decision
Records). The shape:

```markdown
# ADR-NNNN — <decision title in present tense>

- **Status:** proposed | accepted | superseded by ADR-MMMM
- **Date:** YYYY-MM-DD
- **Deciders:** <names / aliases>

## Context and Problem Statement
<1–3 sentences. What forced this decision now.>

## Decision Drivers
- <quality attribute or constraint>
- <…>

## Considered Options
1. <Option A>
2. <Option B>
3. <Option C>

## Decision Outcome
Chosen: **<Option X>**, because <one sentence — the force it resolves>.

### Consequences
- Positive: …
- Negative: …
- Neutral: …

## Pros and Cons of the Options
### <Option A>
- Good: …
- Bad: …

### <Option B>
…

## Out of Scope
- <three explicitly-not-solved things>

## Links
- Source decision: <Nathan / Bezalel doc id>
- Related ADRs: <ADR-NNN>
```

Three rules on Joah's ADR practice:

- **The deciders are real names.** "The team" is not a decider. ADRs
  with anonymous deciders cannot be discussed later.
- **The "Considered Options" all have at least one Bad.** A list of
  options with no negatives is a list, not a deliberation.
- **The "Decision Outcome" names the force.** "We chose X because it
  is better" is not a decision record. "We chose X because it
  resolves <force tension> in favour of <side>" is.

---

## 6. The runbook shape (Joah, sometimes Shevna)

Runbooks are operational documentation. The shape is non-negotiable:

```markdown
# Runbook — <failure mode>

- **Trigger:** <what observation invokes this runbook>
- **Severity:** <how urgent>
- **First responder:** <on-call / specialist>
- **Estimated mitigation time:** <minutes>

## Diagnose
1. <one command per step; copy-paste-safe>
2. <one command per step>

## Mitigate
1. <one command per step>
2. <one command per step>

## Verify
1. <how you know the mitigation worked>

## Resolve
- <the durable fix, if different from the mitigation>
- <link to the ADR that explains the root cause, if any>

## Reference
- Related runbook: <link>
- Related research log: <id>
```

Three rules:

- **One command per step.** Two commands joined with `&&` is one step
  with hidden failure modes. Split.
- **No conditional language in commands.** "Run something like
  `kubectl …`" is not a runbook step. "Run `kubectl <exact>`" is.
- **Mitigate is separate from Resolve.** The on-call mitigates; the
  durable fix may happen later, via a different team. Both belong in
  the runbook so the on-call knows the difference.

---

## 7. The changelog shape (Joah, with Meremoth's automation)

Keep a Changelog + Conventional Commits is the standard. Joah's role:

- The changelog is **generated** from Conventional Commits, then
  curated. Generated lines are starting points, not final.
- Every release has a date.
- The format is:

```markdown
## [1.4.0] — 2026-06-02

### Added
- New endpoint `POST /invoices/void` (#412)

### Changed
- Tightened input validation on `customer.email` length to 254 chars
  (was unbounded) (#418)

### Fixed
- Idempotency replay returned 200 instead of original status (#421)

### Security
- Patched the SQL injection on `find_by_email` flagged by Ira (#420)
```

Three rules:

- **Group by category.** Added / Changed / Deprecated / Removed /
  Fixed / Security. Always.
- **Reference the PR or commit.** A changelog entry without a
  reference is not auditable.
- **No marketing tone.** "Improved performance" without a number is
  noise. Cite the change ("p95 LCP from 3.1s to 1.8s") or do not
  include it.

---

## 8. Worked example — Joah writing an ADR for an idempotency choice

Yasad's S2 work included choosing a Postgres-advisory-lock idempotency
shape over Redis Redlock. Nathan made the decision; Joah documents.

```markdown
# ADR-0012 — Use Postgres advisory locks for idempotency-key serialisation

- **Status:** accepted
- **Date:** 2026-06-02
- **Deciders:** Nathan (Yasad architecture), Bezalel (CTO),
  Phinehas (Mishmar review)

## Context and Problem Statement
The invoices endpoint offers idempotency over `Idempotency-Key`
(CONTRACT §3). Concurrent re-issues must serialise; the lock choice
was open between Postgres advisory locks and Redis-with-Redlock.

## Decision Drivers
- One fewer infrastructure dependency (no separate Redis cluster
  for the invoice path).
- Atomicity with the response-store write (already in Postgres).
- Operational simplicity (one less surface for Migdal to monitor).

## Considered Options
1. Postgres advisory locks
2. Redis-with-Redlock
3. In-process mutex with sticky routing

## Decision Outcome
Chosen: **Postgres advisory locks**, because the lock and the
response-store write are atomic in a single transaction, removing
the cross-system consistency story that Redlock requires.

### Consequences
- Positive: one fewer infrastructure dependency; lock + store
  atomic in one transaction.
- Negative: lock acquisition couples to Postgres connection-pool
  capacity; under saturation, lock waits queue at the pool.
- Neutral: monitoring requires Postgres-side instrumentation
  (already wired).

## Pros and Cons of the Options
### Postgres advisory locks
- Good: atomic with the store write.
- Good: no new infra.
- Bad: couples to pool capacity.

### Redis-with-Redlock
- Good: independent of Postgres saturation.
- Bad: requires a separate Redis cluster for the invoice path.
- Bad: cross-system consistency story (lock in Redis, store in
  Postgres) requires careful failure handling.

### In-process mutex with sticky routing
- Bad: load-balancer must route by `Idempotency-Key`, which is not
  a stable property of a session.
- Bad: every new app instance multiplies the mutex; not safe.

## Out of Scope
- The lock TTL within Postgres (handled by the response-store TTL).
- The choice of `Idempotency-Key` format (client-supplied UUID per
  CONTRACT §3.2).
- The decision to offer idempotency at all (decided in CONTRACT,
  not here).

## Links
- Source decision: T-12 thread; research-log-S2-001.json.
- Related ADRs: ADR-0008 (idempotency clause in CONTRACT).
```

What Joah did:

- Quoted Nathan's reasoning verbatim where decisions were captured.
- Cited the source (T-12 thread, research log).
- Wrote Out of Scope (three things, mandatory).
- Did NOT introduce a new opinion.

What Joah did NOT:

- Re-litigate the choice ("but Redis would have …").
- Predict future regret.
- Fabricate a comparison with a Postgres clustering approach the
  team did not consider.

---

## 9. The recurring traps all three Sefer scope specialists reject

1. **"I'll smooth the rough edges into a nicer story."** No. The doc
   is the truthful record; smoothness is at the cost of accuracy.

2. **"I'll write the doc before the source exists."** No.
   Source-grounded means the source comes first. Pre-emptive
   documentation invents.

3. **"This decision wasn't quite captured; I'll fill in what I
   think they meant."** No. Surface the gap to the originating
   specialist (via Jehoshaphat / Nehemiah). Filled-in interpretations
   become contractual later.

4. **"The runbook is mostly the same as the last one; I'll copy and
   tweak."** No. Runbook patterns are themselves a finding for the
   curated library (`cognee-promote`). Copy-and-tweak runbooks rot
   together.

5. **"This is a tutorial that also covers reference material."** §2.
   Pick a quadrant.

6. **"It's been three sprints; I'll just date this `recent`."** §1.
   No undated docs.

7. **"Let me also add this code snippet inline."** No. Sefer writes
   to `docs/`. Code lives in the codebase; docs *quote* code with
   the path and (where possible) the commit hash.

8. **"The team's reporter didn't surface this, but I noticed it;
   I'll add it."** No. Sefer pulls from sources. If the source did
   not surface it, surface the gap to the reporter, not into the
   doc.

---

## 10. Style — the documentation voice

- **Plain, dated, sourced.** Every claim cites; every artefact has
  a date.
- **One quadrant.** Diátaxis declared in the header.
- **No marketing.** Numbers where numbers apply; absence acknowledged
  where it applies.
- **Reader-centric.** The reader's question is the lede. "What is
  this for" and "how do I use it" precede the design discussion.
- **Faithful to the rough shape of the work.** Smoothing is for
  later editions, not for the first record. Truth-then-prettier-prose,
  in that order.

The pattern is biblical scribes — Seraiah, Joah, Shevna — each
documented at a different layer of the same kingdom. The discipline
is the same; the audience differs.

---

*Cross-references: `~/.claude/rules/y4nn-standards.md`
(no-fabrication §6, naming §11, English §12),
`payload/mishkan/skills/team-lead-craft/SKILL.md` (Jehoshaphat's
Lead-layer, who decides what pulls), `payload/mishkan/skills/reporter-
discipline-craft/SKILL.md` (the silent emit-side that Sefer pulls
from), `payload/mishkan/skills/cognee-promote/SKILL.md` (the promotion
step that feeds curated-library updates Seraiah documents),
`payload/mishkan/skills/baruch-research-reporting-craft/SKILL.md`
(the research-log shape Sefer reads at pull time).*
