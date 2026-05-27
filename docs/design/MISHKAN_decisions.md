# MISHKAN — Build Decisions

Decisions made at Phase 0 that govern the entire build. Each is locked unless
explicitly revisited with a dated entry below.

---

## D-001 — Cognee deployment: Local Docker

**Decision:** Cognee runs as a containerised service under
`~/.claude/mishkan/cognee/`, managed by Docker Compose.

**Rationale:** Aligns with the existing infrastructure discipline — everything
else runs through Docker Compose with multi-environment overlays, SOPS-managed
secrets, and hardening overlays. The knowledge graph stays local; no external
account or billing surface. Fastest install.

**Implications:**
- `.mcp.json` points the Cognee MCP at the local containerised endpoint.
- Secrets (DB password, API keys if any) managed via SOPS, never plaintext.
- A hardening overlay is applied on every container recreate.
- Backups are local; no cloud egress.

---

## D-002 — Model backend: Claude Code models only

**Decision:** Every agent runs on a Claude model tier. There is no local model
runtime and no local-model MCP wrapper.

**Rationale:** The target is Claude Code's native models. Introducing a local
runtime (Ollama / LM Studio / Docker Model Runner / llama.cpp) would add a whole
subsystem — an MCP wrapper, runtime health-checks, fallback logic, per-agent
runtime selection — for no benefit given the target. Removing it simplifies the
build materially.

**Implications:**
- Three tiers only: Opus, Sonnet, Haiku.
  - **Opus (9):** Nehemiah, Bezalel, all Team Leads, Jehonathan.
  - **Sonnet (22):** every agent that **writes code/config into the codebase**
    (precision matters on Y4NN's code) + senior specialists + research
    clarify/formulate/research. Includes all implementation specialists —
    Hizkiah, Salma, Hiram, Obed, Asaph, Palal, Meremoth, Hanun — plus Nathan,
    Zadok, Shallum, Ira, Benaiah, Joab, Hushai, Oholiab, Meshullam, Seraiah,
    Joah, Jakin, Ezra, Caleb.
  - **Haiku (14):** agents that do **not** write code — QA (Uriah, Jahaziel),
    all Team Reporters, pure advisors (Deborah, Rehum), Sefer team-layer docs
    (Shevna), research summarise/evaluate/report (Shaphan, Shemaiah, Baruch).

**Amendment 2026-05-27:** original split put implementation specialists on
Haiku for cost. Revised on Y4NN's preference — Sonnet writes his code more
precisely. Haiku retained only where no code is written (evaluate/collect/advise).
- Tier declared per-agent in frontmatter `model:` field.
- Overridable centrally via `~/.claude/mishkan/config/model-routing.yaml`.
- Cost discipline lives entirely in tier assignment + prompt caching +
  Cognee offloading. The observability loop surfaces expensive agents.

**Supersedes:** the original design §16 model assignment matrix, which assumed
local models for the fast tier. Local tiers are replaced by Haiku.

---

## D-003 — Install scope: User + Project hierarchy

**Decision:** `~/.claude/` carries permanent standards, agents, hooks, and rules
common across all work. A per-project `.claude/` carries project-specific state,
seeded by `/mishkan-init`.

**Rationale:** Matches the design doc's CLAUDE.md hierarchy. The user-level layer
is always warm and travels every project; the project layer holds sprint state,
the project CLAUDE.md, and project-scoped settings.

**Implications:**
- All MISHKAN artifacts live under `~/.claude/mishkan/` to avoid clobbering the
  existing user-level surface (5 agents, 8 commands, 152 skills, settings,
  command-validator script).
- `~/.claude/CLAUDE.md` and `~/.claude/rules/y4nn-standards.md` are introduced
  by MISHKAN (neither existed before).
- Commands are symlinked into `~/.claude/commands/` only after confirming no
  name collision.
- `/mishkan-init` seeds the project layer: `./CLAUDE.md`, `docs/`, project
  `.claude/settings.json`, Cognee project namespace.

---

## D-004 — Existing user-level surface is preserved, never overwritten

**Decision:** MISHKAN extends `~/.claude/`; it does not replace anything.

**Preserved as-is:** any pre-existing user-level `~/.claude/agents/*.md`,
`~/.claude/commands/*.md`, `~/.claude/skills/*`, `~/.claude/settings.local.json`,
and any existing helper scripts (e.g. a command-validator). The installer never
overwrites or removes files it did not place.

**Extended:** `~/.claude/settings.json` gains the MISHKAN hook registrations.
If a pre-existing `Bash` PreToolUse validator is present, the new security hook
chains alongside it rather than replacing it.

**Leveraged:** if the project provides its own ops specialist agent, the Migdal
and Mishmar teams reference it for environment-specific operational knowledge.

---

## D-005 — MISHKAN is a distributable npm package (added 2026-05-27)

**Decision:** MISHKAN ships as an npm package (`mishkan-harness`) installed via a
**dependency-free `npx` one-shot installer** (`npx mishkan-harness install`). The
installer **copies** the payload into `~/.claude/mishkan` (not symlinked to
node_modules), creates relative symlinks for agent/skill/command discovery, and
merges hooks into `~/.claude/settings.json` with paths resolved from
`os.homedir()` at install time.

**Rationale:** the harness must be portable and shareable, not bound to one
machine. The earlier hand-placed build hardcoded absolute paths (`/home/ogu/...`)
in settings.json and `projects.yaml`. The installer removes all machine-binding.

**Implications:**
- **Zero npm dependencies** in the installer — a security-first harness must not
  carry supply-chain risk, and Mishmar's own rules flag postinstall scripts, so a
  no-deps `npx` installer is the only consistent choice.
- Package layout: `bin/mishkan.js` (installer), `payload/mishkan/` (→ `~/.claude/mishkan`),
  `payload/user/` (→ user-level `CLAUDE.md` + `rules/`, placed only if absent),
  `payload/install/settings.hooks.json` (hook fragment with a `{{MISHKAN}}`
  placeholder resolved at install), `docs/engineer/` (canonical profile).
- Install is **idempotent** and **non-clobbering**: never overwrites a user's
  `CLAUDE.md`, `rules/y4nn-standards.md`, or any real (non-symlink) agent/command.
- `uninstall` removes the harness, its symlinks, and its hooks while preserving
  user-level files (`--purge` to also remove the user rule).
- `projects.yaml` is **discovery-based** (env / workspace-root / git-repo scan),
  carrying no hardcoded paths.
- Verified: full install→status→uninstall cycle in a throwaway `$HOME` with zero
  source-machine path leakage.

## D-006 — Engineer profile is canonical, replaceable, and propagated (added 2026-05-27)

**Decision:** the engineer the harness serves is described in
`docs/engineer/profile.md` — a single, replaceable source of truth. The runtime
load path is the generic `~/.claude/mishkan/profile.md` (not a person-specific
filename), so any engineer can adopt the harness by replacing one file.

**Propagation is two-layer:** `scripts/sync-profile.sh` does the mechanical
copy + reference/drift audit; **Seraiah** (Sefer org-layer agent) owns the
semantic re-derivation of digests drawn from the profile (the user-level
`CLAUDE.md` non-negotiables, engineering-identity docs) when it materially changes.

---

*Decisions locked May 2026. Revisit only with a dated amendment below.*
