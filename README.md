<div align="center">

# מִשְׁכָּן · MISHKAN

**A virtual software-engineering organisation that lives inside Claude Code.**

*Run a complex SDLC with AI as a disciplined, multi-agent team — design, spec,
architecture, security, build, review, and docs — instead of a single chat.*

</div>

---

MISHKAN (*"dwelling place"* — the place where the work resides) turns Claude Code
into a standing engineering org: **45 specialist agents** across **six teams**, led
by a PM and a CTO, sharing one research pipeline and one growing knowledge graph.
Quality and security aren't *requested* of the model — they're **enforced by the
environment**: path-scoped rules, pre-write security hooks, and generation kept
structurally separate from review.

It's personal, opinionated infrastructure built around one engineer's standards —
and shared openly for anyone who wants to try working this way. To make it yours,
replace one file (your profile) and re-sync; nothing else hardcodes the author.

> **Status:** v0.2.0 — early and evolving. The agent fleet, rules, hooks, and
> installer are complete. The Cognee knowledge stack (work + curated stores) is
> ready to bring up locally. Live observability (daemon + Textual TUI) ships as
> an opt-in stack of two `uv tool install`-able Python packages.

---

## Three pillars

MISHKAN rests on three things that work together. They are independent — you
can use each without the others — but they compound:

### 1. A disciplined multi-agent organisation

Most "AI coding" is one model in one chat doing everything at once — generating,
judging its own output, skipping the spec, drifting scope. MISHKAN refuses that:

- **Sequence before code.** PRD → SRS → Contract → Architecture → Threat model →
  Modeling → implementation. Agents won't jump to code without the upstream artifacts.
- **Generation ≠ evaluation.** The agent that writes is never the agent that reviews.
  QA and reporters are structurally separate roles.
- **Security & dependencies are first-class**, not an afterthought audit.

### 2. Deterministic guardrails

Quality and security aren't *requested* of the model — they're **enforced by
the environment**: path-scoped rules, pre-write security hooks, structural
separation of generation from review. Secrets, injection, unsafe
deserialization, disabled TLS, `:latest` tags, weak hashing — blocked by a
hook *before* the write lands, not flagged after.

### 3. A knowledge stack that grows

MISHKAN is built around **persisting what you learn**, so future sessions
start where the last one stopped instead of from zero. Three complementary
layers (see [D-008](docs/design/MISHKAN_decisions.md)):

- **[Cognee work](payload/mishkan/cognee/) (`:7777`)** — per-project semantic
  graph. ADRs, runbooks, decisions, resolved research — all ingested
  selectively, then queryable by any agent that hits an unknown.
- **[Cognee curated](payload/mishkan/cognee/) (`:7730`)** — cross-project
  reference library. Read-mostly, seeded once, shared across every project on
  the host.
- **[Graphify](https://github.com/safishamsi/graphify) (shipped, D-008 + D-009)** —
  deterministic code-structure graph for "who calls X, who depends on Y",
  88.1× verified token reduction on the harness corpus, advisory PreToolUse
  nudge for the 20 code-touching dev agents across all teams (D-009
  amended scope).

Plus a **live observability TUI** ([mishkan-watch](payload/mishkan/observability/))
that shows every running agent, workflow, tool call, hook fire, token spend,
and MCP/Cognee status — in real time, across every session, with no overload.
**Eight tabs** (`1`–`8`): Live · Agents · Workflows · Knowledge · Activity ·
Org-Ref · Usage · Skills. Project filter on `p`. Single command — the daemon
auto-starts if its socket isn't present.
See [`docs/design/MISHKAN_observability.md`](docs/design/MISHKAN_observability.md).

#### Auto-routing across the stack

Two PreToolUse hooks ship the discoverability layer of v0.2.1 so agents
reach for the right surface without being asked:

- **Skill discovery** ([D-011](docs/design/MISHKAN_decisions.md)) — a
  universal indexer scans MISHKAN craft, community, plugin and project-
  local skills (~200 entries on a clean install) and a 3-mechanism
  router scores them against each `Task` dispatch's prompt. The hook
  injects a 3-bucket recommendation (`must_load` / `should_consider` /
  `adjacent`, cap 13) as `additionalContext` on the call. Telemetry on
  empty-bucket queries via `/mishkan-skills-misses` feeds the
  description-tuning loop at sprint close.
- **Knowledge-route advisory** ([D-009 amendment](docs/design/MISHKAN_decisions.md))
  — every structural `Read` on source or `Grep` on a bare identifier
  fires a four-surface palette: **code structure** (Graphify),
  **this project's memory** (Cognee work), **cross-project reference**
  (Cognee curated), **literal content** (Read / Grep). Carries real
  signals — graph node + edge count, last-scan staleness, per-route
  token cost, and a `jq` check on `graph.json` that says whether the
  Grep target is actually a node in the current graph so the agent
  doesn't burn ~1.8k tokens on a seedless query. Advisory-only — the
  Read / Grep always proceeds.

## The teams

Two orchestrators route everything: **Nehemiah** (PM — scope, delivery, sprint
state) and **Bezalel** (CTO — architecture, standards, quality bar). Beneath them,
six teams, each `Lead → Specialists → QA → Reporter`:

| Team | Hebrew | Domain |
|------|--------|--------|
| **Chosheb** | *cunning work* | Design & UX |
| **Panim** | *face* | Frontend |
| **Yasad** | *foundation* | Backend & data |
| **Mishmar** | *guard* | Security (cross-cutting) |
| **Migdal** | *tower* | Infrastructure & ops |
| **Sefer** | *scroll* | Documentation (pull-based) |

A shared **research pipeline** (Jakin → Ezra → Caleb → Shaphan → Shemaiah →
Baruch) is invokable by any agent that hits an unknown — clarify, formulate,
research, summarise, evaluate, report — and every call is logged. Names and their
biblical sources: [`docs/design/MISHKAN_agent_aliases.md`](docs/design/MISHKAN_agent_aliases.md).

## Install

Requires Claude Code and Node ≥ 18. The installer has **zero npm dependencies**.

```bash
npx mishkan-harness install      # or: node bin/mishkan.js install  (from a clone)
```

Idempotent and non-destructive: it copies the harness into `~/.claude/mishkan`,
symlinks agents/skills/commands for discovery, places a user-level `CLAUDE.md` and
standards rule **only if absent**, and merges its hooks into `settings.json`
without touching your existing hooks. Paths resolve from your home directory at
install time — nothing machine-specific is baked in.

```bash
npx mishkan-harness status                # what's installed
npx mishkan-harness observability         # install/refresh just the daemon + TUI (needs `uv`)
npx mishkan-harness uninstall             # remove harness; keep your CLAUDE.md & rules
npx mishkan-harness uninstall --purge     # also remove the user-level rule
```

The installer walks 7 phases with clear progress, asks once whether to install
the observability stack at the end, and skips that step cleanly if `uv` isn't
installed.

## A first session

1. Run `claude` anywhere. You're talking to **Nehemiah** and **Bezalel** in
   *exploration mode* — free conversation, no ceremony.
2. Think out loud. When intent is clear, run **`/mishkan-init`** to scaffold the
   project: the spec chain, `docs/`, a seeded knowledge graph, and Sprint S0.
3. Work the sprint. Every write is security-scanned; QA evaluates; reporters collect.
4. **`/sprint-close`** at a milestone. **`/mishkan-resume`** next session restores
   state and open blockers.

### Slash commands inside a session

| Command | Does |
|---|---|
| `/mishkan-init` | Scaffold a project; spec chain → docs/ → Cognee → Sprint S0 |
| `/mishkan-resume` | Restore sprint state + open blockers |
| `/sprint-close` | Reporters → aggregate → docs pull → graph promote |
| `/mishkan-org-reference` | Print the 45-agent org inline (teams + roles + descriptions) |
| `/code-graph status|open|scan` | Inspect / open / refresh the project's code-graph (Graphify) |
| `/skills <task description>` | Skill-discovery router — 3-bucket result (`must_load` / `should_consider` / `adjacent`) |
| `/mishkan-skills-reindex` | Rebuild the universal skill index from disk |
| `/mishkan-skills-misses` | Aggregate miss-log signal for skill-discovery threshold tuning |
| `/eval-baruch` | Run the Baruch contract eval (schema + golden case) |
| `/dep-audit` | Cross-project dependency + supply-chain audit |
| `/promote` | Promote a learning into Cognee by blast radius |
| `/sefer-pull` | Trigger a documentation pull |

### CLI commands from any terminal

After `npx mishkan-harness install` the harness auto-symlinks
`~/.local/bin/mishkan` if that dir exists, so the short form works
once it's on your PATH. Otherwise use `npx mishkan-harness <sub>`.

| Command | Does |
|---|---|
| `mishkan help` | Always-on detailed reference (detects the symlink and prints the right form) |
| `mishkan install` | Install/refresh into `~/.claude` (idempotent) |
| `mishkan configure-knowledge` | Wizard: LLM provider + Cognee `.env` (neo4j / pg / admin secrets) |
| `mishkan observability` | Install only the daemon + TUI (needs `uv`) |
| `mishkan org [--json]` | Print the 45-agent org reference |
| `mishkan code-graph [status|open|scan]` | Inspect the project's Graphify graph |
| `mishkan status` | Show install state, runtime profile, Cognee dir, version |
| `mishkan-watch` | Open the live observability TUI (auto-starts the daemon) |
| `mishkan-watchd start|stop|status` | Daemon lifecycle when you want manual control |

## Dynamic workflows

Beyond the 45 agents and the skills they load, MISHKAN ships **dynamic
workflows** — deterministic JavaScript scripts that orchestrate dozens
of subagents at once with the patterns Anthropic codified
([fan-out/synthesize, pipeline, judge panel, adversarial verify,
loop-until-X](https://code.claude.com/docs/en/workflows)). Workflows fire
from the **main session only**; they are the high-leverage path for
work that scales by parallelism.

The portfolio at v0.2.1 — **10 org-level + 8 team-level**, governed by
[ADR D-010](docs/design/MISHKAN_decisions.md) (hard caps, four named
anti-patterns, PM+CTO co-ownership, soft-retirement under 2 fires per
3 sprints):

| Org-level workflow | When to fire it |
|---|---|
| `mishkan-sprint-close` | At `/sprint-close` — six Team Reporters at once, then aggregate |
| `mishkan-deep-research` | Any unknown where 3-vote adversarial refute is worth the cost |
| `mishkan-codebase-audit` | Periodic / pre-release; multi-modal sweep with verify |
| `mishkan-migration-wave` | Refactors, framework swaps, contract renames; per-file isolation |
| `mishkan-architecture-panel` | High-leverage architecture decisions; 3 proposers × 3 reviewers |
| `mishkan-release-readiness` | Before every staging-to-prod deploy; barrier gate |
| `mishkan-init` | Once per project at `/mishkan-init`; spec chain with overlap |
| `mishkan-blast-radius` | Before a refactor — what does this change actually touch (Graphify + 3 lenses) |
| `mishkan-knowledge-gap-discovery` | Sprint close: probe Cognee for expected concepts, loop-until-dry |
| `mishkan-standards-rollout` | New rule lands in y4nn-standards.md → translate + verify + ratify per team |

Team-level (8 across 6 teams, cap 4 per team): `chosheb-feature-ship`,
`panim-ds-rollout`, `yasad-data-migration-wave`, `yasad-schema-evolution`,
`mishmar-security-gate`, `migdal-infra-change`, `migdal-dr-drill`,
`sefer-release-notes`. Each codifies the recurring high-stakes
orchestration that only that team runs.

Cost discipline: hard cap **10 org-level + 4 per team**. Adding more
typically means an existing workflow should be retired or the new use
case was better served by a Task call or a skill.

The full catalogue, patterns each script uses, and rough cost
expectations per run live in
[`payload/mishkan/workflows/README.md`](payload/mishkan/workflows/README.md).
The PM (Nehemiah) and CTO (Bezalel) co-own the workflow portfolio —
new workflows land through that PM+CTO review per ADR D-010, not ad hoc,
so the catalogue stays load-bearing rather than accreting noise.

## Make it yours

The harness serves the engineer described in
[`docs/engineer/profile.md`](docs/engineer/profile.md) — the single, replaceable
source of truth. Swap in your own (keep the section structure), then:

```bash
~/.claude/mishkan/scripts/sync-profile.sh
```

That refreshes the runtime copy and audits references. **Seraiah** (the docs
org-layer agent) owns re-deriving anything drawn from it. See
[`docs/engineer/README.md`](docs/engineer/README.md).

## Dependency & supply-chain

- **Before adopting any package** — the `dependency-vetting` skill drives the
  research pipeline through OSV/NVD CVEs, maintenance health, typosquatting, and
  provenance, then gives a go/no-go.
- **Across every project you own** — `/dep-audit` inventories all repos under your
  workspace (discovery-based, no hardcoded paths), aggregates shared CVEs and
  version drift, and produces a coordinated, vetted update plan.

## Knowledge stack

MISHKAN uses [Cognee](https://docs.cognee.ai) as its **two-store knowledge
graph** that grows as you work. Cognee core is a Python library; the harness
consumes it through the **`cognee-mcp`** server. Agents can still work without
it — persistence is just deferred. Run the **cognee-quickstart** skill for
guided setup, or the hardened Docker deployment under
`~/.claude/mishkan/cognee/`:

```bash
cd ~/.claude/mishkan/cognee
cp .env.example .env          # set LLM_API_KEY + COGNEE_MCP_REF (pinned), SOPS-managed
docker compose -f docker-compose.yml -f docker-compose.hardening.yml up -d --build
nc -z localhost 7777 && echo up
~/.claude/mishkan/scripts/seed-curated-library.sh      # 96 curated references
```

Agents reach the work store at `http://localhost:7777/mcp` and the curated
store at `:7730`, both seeded by `/mishkan-init` into each project's
`.mcp.json`. The deployment is pinned, SOPS-managed, hardening-overlay on
every recreate, `127.0.0.1`-bound. Full guide:
[`payload/mishkan/cognee/README.md`](payload/mishkan/cognee/README.md).

## Live observability (opt-in)

See **everything** that runs across your MISHKAN sessions in a single Textual
TUI: active agents, workflows-in-flight, token spend ($), file changes, hook
decisions, Cognee node counts, MCP server status. Cross-session,
cross-project, near-zero overhead. Two `uv tool`-installable Python packages:

```bash
# the installer offers this automatically; or run it standalone any time:
npx mishkan-harness observability

# Single command — the TUI auto-starts the daemon if its socket isn't
# present and survives the TUI exit so a second window connects instantly.
mishkan-watch                           # 8 tabs · project filter (p) · status bar

# Power users can manage the daemon explicitly (logs in their face,
# separate terminal). The TUI refuses to fork the daemon with --no-autostart:
# mishkan-watchd start
# mishkan-watch --no-autostart
```

Full operator guide: [`docs/usage/10-observability.md`](docs/usage/10-observability.md).
Design and event schema: [`docs/design/MISHKAN_observability.md`](docs/design/MISHKAN_observability.md).

## Token & context management

MISHKAN doesn't replace Claude's context handling — it **shapes the inputs** so
the model's native behaviour works in your favour. Five mechanisms, each riding a
Claude/Claude Code primitive:

- **Prompt caching** — agents are ordered *static role/standards/rules first,
  dynamic task last*, so the stable prefix caches and you pay full price only for
  what changes.
- **Subagent isolation** — heavy work runs in disposable child windows; only
  summaries return, so the main thread stays lean (and disabling auto-compaction
  stays low-risk).
- **Tight tool grants** & **path-scoped rules** — agents carry only the tool
  schemas and rules relevant to the file in hand.
- **Cognee offloading** — full artifacts live in the graph; context holds
  summaries.

Model tiering is the complementary cost axis (`config/model-routing.yaml`): Opus
for orchestration/leads, Sonnet for anything that writes code, Haiku for
evaluate/collect/advise.

→ Full operational detail, the cost model, and honest gaps:
[`docs/design/MISHKAN_token_optimisation.md`](docs/design/MISHKAN_token_optimisation.md).

## Repository layout

```
bin/mishkan.js              installer (dependency-free)
payload/                    what gets installed into ~/.claude
  mishkan/                    agents, skills, rules, hooks, commands, templates, config, scripts, ontology
  user/                       user-level CLAUDE.md + standards rule (placed if absent)
  install/                    hook fragment merged into settings.json
docs/
  engineer/                   the canonical, replaceable engineer profile
  design/
    MISHKAN_harness_design.md       architecture (5 layers, 6 teams, knowledge model)
    MISHKAN_agent_aliases.md        the 45 agents and their sources
    MISHKAN_decisions.md            locked build decisions
    MISHKAN_ontology.md             Cognee graph schema
    MISHKAN_token_optimisation.md   how context/token use leverages Claude primitives
```

## License

MIT — use it, fork it, make it serve your own engineering.

---

Built by **`>_theY4NN`** · [github.com/Y4NN777](https://github.com/Y4NN777)
