---
name: mishkan-init
description: Initialise a project under MISHKAN. Runs the SWE-BASICS-BEFORE-CODE sequence through the right specialists (PRD → SRS → CONTRACT → ARCHITECTURE → THREAT_MODEL → C4 → docs scaffold), sets the memory path, writes the project CLAUDE.md, and begins Sprint S0. Use once per project, triggered by /mishkan-init.
---

# mishkan-init

Initialise a new project under MISHKAN. Run once per project. Surface a `/plan`
to the engineer before the first doc is written — the plan is the scope contract for init.

## Preconditions

- the engineer has converged on intent in exploration mode (Nehemiah + Bezalel).
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
8. **Automated** — memory setup. Native runtime memory is the default path:
   use `/memory` in Claude Code or `/memories` in Codex for cross-session recall,
   and keep required rules in `CLAUDE.md` / `AGENTS.md` / `docs/`. If the project
   state says `Memory backend: cognee` or `hybrid`, then Cognee is explicitly
   enabled and init may compose the two control verbs after the engineer confirmation:
   - **Knowledge stack (shared, idempotent):** `mishkan knowledge-stack up`
     (memory :7777 + curated :7730 + ollama/pg; preflights `.env` and guides to
     `mishkan knowledge configure` if unset).
   - **Project work store (per-project, ADR D-012):** `mishkan project-work-store up`
     gives this project its own physically-isolated store (embedded Ladybug; own
     container + volume + port — never the shared `:7777`). Isolation rides on
     this container/volume, not `datasets=`.
   - **Ingest (opt-in, never bulk):** `mishkan knowledge ingest --tagged-only`
     adds only `ares: ingest`-tagged docs into THIS project's store. Never
     bulk-ingest the tree, and scrub secrets/PII first.
   If Cognee is not enabled, skip all Cognee commands; persistence comes from
   native memory plus versioned project docs.
9. **Automated** — write `./CLAUDE.md` from
   `~/.claude/mishkan/templates/project-CLAUDE.md`, fill placeholders, set Sprint
   S0. Copy `~/.claude/mishkan/templates/settings.json` → `.claude/settings.json`,
   the team rules from `~/.claude/mishkan/rules/*` → `.claude/rules/*` for
   path-scoped loading. Cognee MCP config is written only when project init used
   `--memory cognee` or `--memory hybrid`; native memory projects do not need
   `.mcp.json` for ARES.
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
.mcp.json  (only when Cognee is enabled: cognee-memory + cognee-curated; project work store is explicit)
Memory: native runtime memory by default; Cognee stores only when enabled (`--memory cognee|hybrid`)
```

## Constraints

Sequence before implementation — no code is written during init. Stateful
operations hard stop. Every doc is dated and conforms to the Sefer rules.
English only.
