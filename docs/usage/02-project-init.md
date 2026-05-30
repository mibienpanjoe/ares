# 02 — Project initialisation

> Goal: take a directory and turn it into a MISHKAN project: rules, deny-list,
> MCP connections, and a `CLAUDE.md` carrying sprint state.

## When and where to run it

```bash
cd <project root>
claude              # opens a Claude Code session
/mishkan-init       # invokes the init skill
```

`/mishkan-init` is a **skill** (lives at
`~/.claude/mishkan/skills/mishkan-init/SKILL.md`) and also exposed as a
command. It is **not** something an agent should run unprompted — there is an
explicit precondition check.

## The four artifacts it always writes

| File | Role | Tracked? |
|---|---|---|
| `CLAUDE.md` | project state: sprint slot, code orientation, two-store note | yes |
| `.mcp.json` | declares both cognee MCP servers (`cognee` + `cognee-curated`) | yes |
| `.claude/settings.json` | deny-list: `git push`, `ssh`, `sudo`, `docker exec` | yes |
| `.claude/settings.local.json` | local allow-list; gitignored | no (added to `.gitignore` if absent) |

Plus the **7 path-scoped team rules** copied to `.claude/rules/` so they JIT-load
only on matching files (see [Orchestration](./03-orchestration.md)).

## Scope choice — greenfield vs brownfield

The skill detects whether the repo is empty or already mature and asks how much
of the spec spine to run. Two common answers:

- **Harness wiring only** — drop the four artifacts + rules, do not generate
  PRD/SRS/CONTRACT/ARCHITECTURE/THREAT_MODEL. Right for a mature repo with
  existing docs (the aiobi-mail case during the build).
- **Full init** — run the documented sequence with the right specialists writing
  each spec. Right for greenfield. Slow on purpose: nothing is generated without
  upstream artifacts existing.

The full sequence (when chosen):

1. **Nehemiah** writes `docs/PRD.md`.
2. **Nathan** (Yasad) writes `docs/SRS.md`.
3. **Zadok** (Yasad) writes `docs/CONTRACT.md` — *invariants + guarantees*.
4. **Bezalel + Nathan** write `docs/ARCHITECTURE.md`.
5. **Benaiah** (Mishmar) writes `docs/THREAT_MODEL.md` (STRIDE).
6. **Meshullam** (Migdal) writes `docs/diagrams/C4/` (Context, Container, Component).
7. **Jehoshaphat** (Sefer) scaffolds `docs/README.md`, `docs/adr/`, `docs/runbooks/`.
8. **Automated** cognee setup (see below).
9. **Automated** project `CLAUDE.md` write + sprint S0.

Each step that touches a contract requires `/plan` to run first.

## Step 8 in detail: cognee setup at init

Two parts run automatically at init:

1. **Ensure the curated box** (global singleton, shared across projects).
   `~/.claude/mishkan/scripts/ensure-curated-box.sh` is idempotent: it brings up
   the curated stack if down, creates `curated_db`, and seeds only if the
   curated graph is empty. It is safe to run repeatedly.

2. **Selectively seed the work store** for this project, **never bulk-ingest**.
   `/mishkan-init` runs:
   ```bash
   bash ~/.claude/mishkan/scripts/mishkan-ingest.sh --tagged-only
   ```
   That walks `./docs/` looking for files with a `mishkan: ingest` YAML
   frontmatter tag and ingests *only* those. Untagged docs are ignored.
   The whole point is memory is opt-in: see
   [Selective ingest](./05-selective-ingest.md) and commit `6213611`.

## What `CLAUDE.md` carries

A lean, dynamic file that loads **after** the user-level identity. It carries:

- Codebase orientation (stack, key directories) — concrete facts the
  main session needs every turn.
- Sprint slot — *current sprint*, *what's in flight*, *blockers*. Updated by
  `/mishkan-resume`, `/sprint-close`, and you.
- Note that there are two cognee stores (`cognee` = work, `cognee-curated` =
  reference) and that `cognee-curated` is read-only.
- A pointer to the existing `docs/` if there is one (does not duplicate).

## Brownfield handling — what does *not* happen

- **No overwrites.** Existing `README.md`, `CLAUDE.md`, and `docs/*` are left
  alone. If a project `CLAUDE.md` already exists, the agent surfaces it and
  asks before merging.
- **No translation.** If the existing docs are in another language (the
  aiobi-mail repo was largely French), the MISHKAN docs are written in English
  per rule 12 of `y4nn-standards.md`, alongside the existing corpus.
- **No reverse-engineered PRD.** If you pick "harness wiring only", no spec
  spine is fabricated.

## Confirming a clean init

After `/mishkan-init` completes:

```bash
# the four artifacts
ls -la .mcp.json CLAUDE.md .claude/settings.json .claude/settings.local.json

# rules installed
find .claude/rules -type f | sort

# settings.local.json gitignored
grep -E '\.claude/settings\.local\.json' .gitignore

# the two cognee servers declared
python3 -c "import json; print(list(json.load(open('.mcp.json'))['mcpServers'].keys()))"
# expected: ['cognee', 'cognee-curated']
```

## Verifying the MCP connections (next session)

MCP servers connect **at session start** — so the session that ran
`/mishkan-init` does *not* yet have `mcp__cognee__*` tools available. Open a new
session in the same directory:

```bash
exit          # leave the current session
claude        # fresh session
/mcp          # in the session: should list 'cognee' and 'cognee-curated'
```

## Common edge cases

- **No remote / private repo:** `.mcp.json` is tracked; do not put secrets in
  it. The cognee MCP URLs point at `http://localhost:7777` and `:7730` — your
  own host, no third-party endpoints.
- **Multiple projects on one host:** safe. The curated box is shared
  (singleton); the work store holds each project as its own dataset, keyed by
  the project directory basename by default (see
  [Selective ingest](./05-selective-ingest.md) for the dataset naming
  rules).
- **Running init twice:** safe. The four artifacts are not overwritten; the
  curated ensure step is idempotent; rules are re-copied verbatim.

## See also

- The init skill source: `payload/mishkan/skills/mishkan-init/SKILL.md`
  (commit `a9a4bf1` wired the curated-box step; commit `6213611` made step 8
  selective).
- [Orchestration](./03-orchestration.md) — how the main session routes work
  once init has run.
- [Memory layer](./04-memory-layer.md) — the two cognee stores and what they
  hold.
