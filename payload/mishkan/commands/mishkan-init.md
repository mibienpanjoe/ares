---
description: Initialise the current project under MISHKAN (PRD→SRS→CONTRACT→ARCHITECTURE→THREAT_MODEL→C4→docs→Cognee→Sprint S0).
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
→ seed Cognee from all docs
→ write `./CLAUDE.md` (Sprint S0), copy settings + team rules into `.claude/`

Sequence before implementation: no code is written during init. Stateful
operations stop at Y4NN's hands. Every doc is dated. English only.
