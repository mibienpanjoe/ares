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
   - **Work store (per-project):** **never bulk-ingest** the `docs/` tree —
     memory is opt-in. Use `mishkan-ingest` (the skill) which selects docs
     either (a) by `mishkan: ingest` YAML frontmatter tag, or (b) explicit
     paths. The skill runs `add → cognify → memify` in one shot, throttled
     and on persistent storage. Tag docs you want in project memory; everything
     else stays out of the graph (no PII bleed, no oversized-doc embedding
     failures). At init, run `mishkan-ingest.sh --tagged-only` so anything
     already tagged enters memory; the rest is added per-doc as you go.
   If the work stack is not running (`~/.claude/mishkan/cognee/`), skip both
   gracefully and note it — agents still work; persistence resumes when it's up.
9. **Automated** — write `./CLAUDE.md` from
   `~/.claude/mishkan/templates/project-CLAUDE.md`, fill placeholders, set Sprint
   S0. Copy `~/.claude/mishkan/templates/settings.json` → `.claude/settings.json`,
   the team rules from `~/.claude/mishkan/rules/*` → `.claude/rules/*` for
   path-scoped loading, and `~/.claude/mishkan/templates/mcp.json` → `./.mcp.json`
   so agents can reach the Cognee knowledge-graph MCP.
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
.mcp.json  (cognee = work store, cognee-curated = reference)
Cognee: curated box ensured (:7730) + this project's dataset seeded in work (:7777)
```

## Constraints

Sequence before implementation — no code is written during init. Stateful
operations hard stop. Every doc is dated and conforms to the Sefer rules.
English only.
