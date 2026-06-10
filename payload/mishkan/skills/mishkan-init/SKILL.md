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
8. **Automated** — Cognee setup (separate stores, decisions D-007 + D-012):
   - **Curated box (global singleton):** run
     `bash ~/.claude/mishkan/scripts/ensure-curated-box.sh`. Idempotent —
     creates `curated_db`, brings up the curated box (`mishkan-curated-*` on :7730),
     seeds the reference library only if empty. Never reseeds a populated box.
   - **Work store (per-project, ADR D-012):** each project gets its OWN
     physically-isolated work store (embedded Ladybug; own container + volume +
     port — never the shared `:7777`). Provision it and capture the port:
     ```bash
     WORK_PORT=$(bash ~/.claude/mishkan/scripts/ensure-work-store.sh)
     ```
     (slug defaults to the project dir name). The printed port is substituted into
     `.mcp.json` in step 9. Isolation rides on this container/volume, not `datasets=`.
   - **Ingest (opt-in, never bulk):** then
     `bash ~/.claude/mishkan/scripts/mishkan-ingest.sh --tagged-only` adds anything
     already tagged `mishkan: ingest` into THIS project's store; the rest is added
     per-doc as you go. The skill runs `add → cognify → memify`, throttled, on the
     per-project volume. Never bulk-ingest the tree, and scrub secrets/PII before
     ingest (see the `mishkan-ingest` skill's security section).
   If the cognee stack is not running (`~/.claude/mishkan/cognee/`), skip
   gracefully and note it — agents still work; persistence resumes when it's up.
9. **Automated** — write `./CLAUDE.md` from
   `~/.claude/mishkan/templates/project-CLAUDE.md`, fill placeholders, set Sprint
   S0. Copy `~/.claude/mishkan/templates/settings.json` → `.claude/settings.json`,
   the team rules from `~/.claude/mishkan/rules/*` → `.claude/rules/*` for
   path-scoped loading, and **render** `~/.claude/mishkan/templates/mcp.json` →
   `./.mcp.json`, substituting `__MISHKAN_WORK_PORT__` with the work-store port
   captured in step 8 so the `cognee` MCP points at THIS project's own store:
   ```bash
   sed "s/__MISHKAN_WORK_PORT__/${WORK_PORT}/" \
     ~/.claude/mishkan/templates/mcp.json > ./.mcp.json
   ```
10. **Automated — Graphify code graph** (the third store of the knowledge stack,
    per D-008): if `graphify` is on PATH (`uv tool install graphifyy` provides
    it), run an initial scan so the project has a structure graph from Sprint
    S0 onwards. Otherwise skip with a one-line note — the agent fleet still
    works; the graph populates the first time Hizkiah / Salma / Nathan / Zadok /
    Oholiab runs `graphify update .` mid-sprint.
    ```bash
    if command -v graphify >/dev/null 2>&1; then
      graphify update . || echo "mishkan-init: graphify scan failed, skipping (project will scan on first structural query)"
    fi
    ```
    The output `graphify-out/` is gitignored by convention — re-derivable, no
    need to commit. The MISHKAN observability daemon's `graphify_tail` source
    will start emitting `graphify_scan` / `graphify_query` events for the
    Knowledge tab as soon as the graph exists.

## Outputs

```
docs/{PRD,SRS,CONTRACT,ARCHITECTURE,THREAT_MODEL,README}.md
docs/adr/  docs/runbooks/  docs/diagrams/C4/
./CLAUDE.md  (sprint S0)
.claude/settings.json  .claude/rules/{common,frontend,backend,infrastructure,documentation}/
.mcp.json  (cognee = this project's OWN per-project work store, cognee-curated = shared reference)
Cognee: curated box ensured (:7730) + this project's per-project work store provisioned (own port) + tagged docs ingested
```

## Constraints

Sequence before implementation — no code is written during init. Stateful
operations hard stop. Every doc is dated and conforms to the Sefer rules.
English only.
