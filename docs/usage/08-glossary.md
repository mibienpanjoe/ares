# 08 — Glossary

> The 45 agents (alias → role → team), key terms, and the recurring
> abbreviations. Full naming rationale lives in
> [`docs/design/MISHKAN_agent_aliases.md`](../design/MISHKAN_agent_aliases.md).

## Two orchestrators

| Alias | Role | Model tier |
|---|---|---|
| `nehemiah` | PM — scope, delivery, sprint state, routing | Opus |
| `bezalel` | CTO — technical standards, architecture, quality bar | Opus |

The **main session** loads MISHKAN identity and acts as leadership; spawning
either as a subagent gives you an advisor that *cannot delegate further* (no
nested delegation). See [Orchestration](./03-orchestration.md).

## Chosheb — Design / UX

| Alias | Role | Tier |
|---|---|---|
| `aholiab` | Team Lead | Opus |
| `hiram` | UI design + prototype | Sonnet |
| `deborah` | Cognitive / emotional UX (advisor) | Haiku |
| `elasah` | Reporter | Haiku |

## Panim — Frontend

| Alias | Role | Tier |
|---|---|---|
| `huram` | Team Lead | Opus |
| `oholiab` | Frontend design-system expert | Sonnet |
| `salma` | Senior frontend developer | Sonnet |
| `asaph` | SEO / accessibility | Sonnet |
| `obed` | Asset feeder (images, icons, fonts) | Sonnet |
| `jahaziel` | QA — evaluates only, never writes code | Haiku |
| `ahikam` | Reporter | Haiku |

## Yasad — Backend

| Alias | Role | Tier |
|---|---|---|
| `zerubbabel` | Team Lead | Opus |
| `nathan` | Software architecture master (writes SRS + ARCHITECTURE) | Sonnet |
| `zadok` | Design-system master (writes CONTRACT) | Sonnet |
| `hizkiah` | Pure backend implementation | Sonnet |
| `shallum` | Databases — schema, indexing, migrations | Sonnet |
| `uriah` | QA — evaluates only | Haiku |
| `igal` | Reporter | Haiku |

## Mishmar — Security (cross-cutting)

| Alias | Role | Tier |
|---|---|---|
| `phinehas` | Team Lead, cross-cutting security authority | Opus |
| `ira` | Code-security ops — the agent behind the PreToolUse security hook | Sonnet |
| `benaiah` | DevSecOps + infra security — writes THREAT_MODEL | Sonnet |
| `joab` | Web / mobile / desktop security | Sonnet |
| `hushai` | Strategic security advisor (no codebase write) | Sonnet |
| `maaseiah` | Reporter | Haiku |

## Migdal — Infrastructure

| Alias | Role | Tier |
|---|---|---|
| `eliashib` | Team Lead | Opus |
| `meshullam` | Infrastructure design (writes C4 + IaC) | Sonnet |
| `palal` | Systems / OS / networks | Sonnet |
| `meremoth` | DevOps — CI/CD pipelines | Sonnet |
| `hanun` | DevSecOps + observability | Sonnet |
| `rehum` | Health / SRE advisor (no codebase write) | Haiku |
| `zaccur` | Reporter | Haiku |

## Sefer — Documentation (cross-cutting, pull-based)

Sefer **never writes code**. Reads cognee + reporter outputs, writes to
`docs/` only.

| Alias | Role | Tier |
|---|---|---|
| `jehoshaphat` | Team Lead, Recorder | Opus |
| `seraiah` | Org-layer (cross-project standards) | Sonnet |
| `joah` | Project-layer (ADRs, runbooks, changelogs) | Sonnet |
| `shevna` | Team-layer (per-team docs) | Haiku |
| `jehonathan` | Knowledge publication (publishes from cognee) | Opus |
| `huldah` | Reporter | Haiku |

## Research pipeline (6 stages)

Each stage is a single-purpose agent. The pipeline is also a skill
(`research-pipeline`).

| # | Alias | Stage | Tier |
|---|---|---|---|
| 1 | `jakin` | Intent clarificator (dialogue, no tools) | Sonnet |
| 2 | `ezra` | Research details formulator (checks cognee/curated) | Sonnet |
| 3 | `caleb` | Contextual web researcher | Sonnet |
| 4 | `shaphan` | Contextual research summariser | Haiku |
| 5 | `shemaiah` | Results evaluator (cross-references curated) | Haiku |
| 6 | `baruch` | Reporter — emits research-log.json, writes cognee node | Haiku |

## Roster totals

| Tier | Count | Where |
|---|---|---|
| Opus | 9 | orchestrators, Team Leads, knowledge publication |
| Sonnet | 22 | senior specialists, anything that writes code |
| Haiku | 14 | QA, Reporters, pure advisors, research summarise/evaluate/report |
| **Total** | **45** | |

> *Fable tier dormant.* Claude Fable 5 was briefly assigned to the 8 Migdal+Mishmar
> specialists (D-002 amend, 2026-06-11) but **suspended 2026-06-12** by an
> export-control directive; those agents reverted to Sonnet. The routing layer still
> accepts `fable` as a valid value, so it can be re-enabled if access is restored.

The shipped mapping lives in
[`payload/mishkan/config/model-routing.yaml`](../../payload/mishkan/config/model-routing.yaml);
the hook `payload/mishkan/hooks/model-route.py` injects it at delegation time.
**You can re-tier any agent** with `ares model set <agent|team|all> <tier>` (D-017) —
overrides land in a `model-routing.local.yaml` overlay that survives updates, take effect
on the next delegation, and win over the shipped defaults above.

## Key terms

| Term | Definition |
|---|---|
| **Main session** | the top-level Claude Code conversation. Loads MISHKAN identity from `~/.claude/CLAUDE.md` and is the **only** orchestrator. |
| **Subagent** | an agent spawned from the main session via the `Task` tool, one level deep. Cannot spawn further subagents. |
| **Hook** | a deterministic side-channel (`PreToolUse`, `PostToolUse`, `Stop`, etc.) that lets the harness *enforce* rather than just *describe* behaviour. |
| **Skill** | a reusable workflow defined in `SKILL.md`. Invoked on demand via the `Skill` tool; never preloaded into agent context in this harness. |
| **Cognify** | the LLM-heavy step that extracts entities + relationships from a document and writes them into the graph. |
| **Memify** | the enrichment step that runs after cognify and embeds the triplet/edge layer into the vector store. |
| **Search** | cognee's retrieval, exposed via MCP. Always pass `datasets=[...]` to scope it. |
| **Work store** | a per-project cognee-mcp container running an embedded Ladybug graph (no Neo4j), on its own port and volume (`ares-work-<slug>`). Provisioned by `ares project-work-store up` after `/ares-init` or project wiring. NOT port `:7777`. |
| **Curated store** | the cross-project reference cognee box (`cognee-curated`, `:7730`). Read-mostly. |
| **`cognee-memory` (`:7777`)** | the kept Neo4j-backed cognee box repurposed (D-012) to hold only `claude_code_memory` — shared per-client session memory. Reached via the `cognee-memory` MCP alias. |
| **`claude_code_memory`** | the per-client memory dataset held in the `cognee-memory` (`:7777`) box. Shared across all projects; never prune it. |
| **`ares: ingest`** | the YAML frontmatter tag that marks a doc as eligible for the work store. Legacy `mishkan: ingest` tags still work. |
| **Throttle** | the in-process LLM rate limiter (`LLM_RATE_LIMIT_*` in `.env`). Per-minute only; does not help with daily caps. |
| **Asymmetric delegation** | the rule that stateful ops (`git push`, `ssh`, `sudo`, production `docker exec`, schema migrations, log forensics) stop at the engineer's hands — never executed by an agent. |

## Recurring abbreviations

| Abbrev | Meaning |
|---|---|
| RPM | requests per minute (rate cap) |
| RPD | requests per day (daily cap) |
| TPM | tokens per minute |
| MCP | Model Context Protocol — how cognee tools are exposed to Claude Code |
| ADR | Architecture Decision Record |
| QA | the team-evaluation role, structurally separate from production agents |
| LLM | the large language model — in cognee context, the *cognify extraction* model, **not** the agent's model |

## Sources

- [`docs/design/MISHKAN_agent_aliases.md`](../design/MISHKAN_agent_aliases.md)
  — biblical naming rationale and full per-agent descriptions.
- [`payload/mishkan/config/model-routing.yaml`](../../payload/mishkan/config/model-routing.yaml)
  — authoritative agent → tier mapping.
- [`docs/design/MISHKAN_harness_design.md`](../design/MISHKAN_harness_design.md)
  — agent role descriptions in §5, §6.
- The 45 agent files under `payload/mishkan/agents/` — each carries the
  `description:` frontmatter the `Task` tool uses for delegation matching.
