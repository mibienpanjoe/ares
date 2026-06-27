---
description: Initialise the current project under MISHKAN (PRD→SRS→CONTRACT→ARCHITECTURE→THREAT_MODEL→C4→docs→memory→Sprint S0).
argument-hint: "[optional one-line project intent]"
---

Initialise this project under MISHKAN by running the **mishkan-init** skill.

Project intent (if provided): $ARGUMENTS

Before writing the first document, **produce a `/plan`** and surface it to Y4NN
for approval — the plan is the scope contract for initialisation. Then run the
sequence exactly:

Nehemiah → `docs/PRD.md`
→ Nathan → `docs/SRS.md`
→ Zadok → `docs/CONTRACT.md` (plan first)
→ Bezalel + Nathan → `docs/ARCHITECTURE.md` (plan first)
→ Benaiah → `docs/THREAT_MODEL.md` (plan first)
→ Meshullam → `docs/diagrams/C4/` (plan first)
→ Jehoshaphat → `docs/README.md`, `docs/adr/`, `docs/runbooks/` (plan first)
→ memory setup: use the runtime's native memory by default (`/memory` in Claude
  Code, `/memories` in Codex). If this project state says `Memory backend:
  cognee` or `hybrid`, ask Y4NN before running `mishkan knowledge-stack up`,
  `mishkan project-work-store up`, and `mishkan knowledge ingest --tagged-only`
  (ONLY `ares: ingest`-tagged docs — never bulk-ingest the tree; selective by
  design, prevents PII bleed)
→ write `./CLAUDE.md` (Sprint S0), copy settings + team rules into `.claude/`

Sequence before implementation: no code is written during init. Stateful
operations stop at Y4NN's hands. Every doc is dated. English only.
