---
name: mishkan-init
description: Initialise a project under MISHKAN. Runs the SWE-BASICS-BEFORE-CODE sequence through the right specialists (PRD → SRS → CONTRACT → ARCHITECTURE → THREAT_MODEL → C4 → docs scaffold), seeds Cognee, writes the project CLAUDE.md, and begins Sprint S0. Use once per project, triggered by /mishkan-init.
---

# mishkan-init

Initialise a new project under MISHKAN. Run once per project. Surface a `/plan`
to Y4NN before the first doc is written — the plan is the scope contract for init.

## Preconditions

- Y4NN has converged on intent in exploration mode (Nehemiah + Bezalel).
- Working directory is the project root.

## Sequence (each phase feeds the next — do not skip, do not reorder)

1. **Nehemiah** — from the intent conversation, write `docs/PRD.md` (product
   requirements: problem, users, use cases).
2. **Nathan** (Yasad) — `docs/SRS.md` (software requirements from the PRD).
3. **Zadok** (Yasad) — `docs/CONTRACT.md` (invariants + guarantees). `/plan` first.
4. **Bezalel + Nathan** — `docs/ARCHITECTURE.md`. `/plan` first.
5. **Benaiah** (Mishmar) — `docs/THREAT_MODEL.md` via STRIDE. `/plan` first.
6. **Meshullam** (Migdal) — `docs/diagrams/C4/` (Context, Container, Component).
   `/plan` first.
7. **Jehoshaphat** (Sefer) — scaffold `docs/README.md`, `docs/adr/`,
   `docs/runbooks/` (stub runbooks per team). `/plan` first.
8. **Automated** — Cognee setup (two physically-separate stores, decision D-007):
   - **Curated box (global singleton):** run
     `bash ~/.claude/mishkan/scripts/ensure-curated-box.sh`. It is idempotent —
     creates `curated_db`, brings up the curated box (`mishkan-curated-*` on :7730),
     and seeds the reference library only if empty. Never reseeds a populated box.
   - **Work store (per-project):** seed this project's knowledge into the work box
     (`mishkan-cognee-*` on :7777) from all docs (entities + relationships per
     `~/.claude/mishkan/ontology.md`), under this project's own dataset. Always
     follow `cognify` with `memify(dataset=<project>)` — extraction then
     enrichment (memify embeds the triplet layer; embeddings-only, no LLM quota).
   If the work stack is not running (`~/.claude/mishkan/cognee/`), skip both
   gracefully and note it — agents still work; persistence resumes when it's up.
9. **Automated** — write `./CLAUDE.md` from
   `~/.claude/mishkan/templates/project-CLAUDE.md`, fill placeholders, set Sprint
   S0. Copy `~/.claude/mishkan/templates/settings.json` → `.claude/settings.json`,
   the team rules from `~/.claude/mishkan/rules/*` → `.claude/rules/*` for
   path-scoped loading, and `~/.claude/mishkan/templates/mcp.json` → `./.mcp.json`
   so agents can reach the Cognee knowledge-graph MCP.

## Outputs

```
docs/{PRD,SRS,CONTRACT,ARCHITECTURE,THREAT_MODEL,README}.md
docs/adr/  docs/runbooks/  docs/diagrams/C4/
./CLAUDE.md  (sprint S0)
.claude/settings.json  .claude/rules/{common,frontend,backend,infrastructure,documentation}/
.mcp.json  (cognee = work store, cognee-curated = reference)
Cognee: curated box ensured (:7730) + this project's dataset seeded in work (:7777)
```

## Constraints

Sequence before implementation — no code is written during init. Stateful
operations hard stop. Every doc is dated and conforms to the Sefer rules.
English only.
