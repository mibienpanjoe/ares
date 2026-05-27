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

> **Status:** early and evolving. Used daily, not yet battle-hardened for everyone.
> The agent fleet, rules, hooks, and installer are complete; the Cognee knowledge
> graph is opt-in (bring up a local container) and some integration points are
> marked as such below.

---

## Why

Most "AI coding" is one model in one chat doing everything at once — generating,
judging its own output, skipping the spec, drifting scope. MISHKAN refuses that:

- **Sequence before code.** PRD → SRS → Contract → Architecture → Threat model →
  Modeling → implementation. Agents won't jump to code without the upstream artifacts.
- **Generation ≠ evaluation.** The agent that writes is never the agent that reviews.
  QA and reporters are structurally separate roles.
- **Deterministic guardrails.** Secrets, injection, unsafe deserialization, disabled
  TLS, `:latest` tags, weak hashing — blocked by a hook *before* the write lands,
  not flagged after.
- **Security & dependencies are first-class**, not an afterthought audit.
- **It learns.** Resolved research and decisions become nodes in a knowledge graph
  (Cognee) that grows through use.

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
npx mishkan-harness uninstall             # remove harness; keep your CLAUDE.md & rules
npx mishkan-harness uninstall --purge     # also remove the user-level rule
```

## A first session

1. Run `claude` anywhere. You're talking to **Nehemiah** and **Bezalel** in
   *exploration mode* — free conversation, no ceremony.
2. Think out loud. When intent is clear, run **`/mishkan-init`** to scaffold the
   project: the spec chain, `docs/`, a seeded knowledge graph, and Sprint S0.
3. Work the sprint. Every write is security-scanned; QA evaluates; reporters collect.
4. **`/sprint-close`** at a milestone. **`/mishkan-resume`** next session restores
   state and open blockers.

### Commands

| Command | Does |
|---|---|
| `/mishkan-init` | Scaffold a project; begin Sprint S0 |
| `/mishkan-resume` | Restore sprint state + blockers |
| `/sprint-close` | Reporters → aggregate → docs pull → graph promote |
| `/dep-audit` | Cross-project dependency & supply-chain audit |
| `/promote` | Promote knowledge by blast radius |
| `/sefer-pull` | Trigger a documentation pull |

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

## Knowledge graph (optional)

MISHKAN uses [Cognee](https://docs.cognee.ai) as the knowledge graph that grows as
you work. Cognee core is a Python library; the harness consumes it through the
**`cognee-mcp`** server. Optional at first run — agents work without it; only
persistence is deferred. Run the **cognee-quickstart** skill for guided setup, or
the hardened Docker deployment under `~/.claude/mishkan/cognee/` (HTTP transport,
port 7777):

```bash
cd ~/.claude/mishkan/cognee
cp .env.example .env          # set LLM_API_KEY + COGNEE_MCP_REF (pinned), SOPS-managed
docker compose -f docker-compose.yml -f docker-compose.hardening.yml up -d --build
nc -z localhost 7777 && echo up
~/.claude/mishkan/scripts/seed-curated-library.sh      # 96 curated references
```

Agents reach it via each project's `.mcp.json` (seeded by `/mishkan-init`): the
default is HTTP transport to `http://localhost:7777/mcp`, with a zero-container
stdio alternative included. The deployment follows the infra rules — built from a
pinned `Dockerfile` (no `:latest`), SOPS secrets, hardening overlay on every
recreate, `127.0.0.1`-bound. Pin `COGNEE_MCP_REF` to a release and confirm details
against [Cognee's docs](https://docs.cognee.ai/cognee-mcp/mcp-local-setup).
Full guide: [`payload/mishkan/cognee/README.md`](payload/mishkan/cognee/README.md).

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
