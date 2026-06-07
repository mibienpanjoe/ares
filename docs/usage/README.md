# MISHKAN — Usage Documentation

> מִשְׁכָּן, *"dwelling place"* — a personal SWE harness built natively on
> Claude Code. This corpus is the **how**. The **why** lives in
> [`docs/design/`](../design/).

A single Claude Code session, turned into a 45-agent software-engineering
organisation with deterministic constraints (hooks, rules, schemas), an
asymmetric AI-vs-human delegation boundary, and a two-store knowledge graph
that accumulates as you work.

## In five minutes

```
You ──talk──▶  MAIN SESSION  = leadership (Nehemiah/Bezalel via CLAUDE.md)
                   │            ← the ONE orchestrator (no nested delegation)
                   ├─Task→ Team Lead / Specialist            ┐ siblings,
                   ├─Task→ aiobi-ops or other project agents │ one level deep
                   └─Task→ research pipeline                 ┘
                                                                ↓
                    ┌──────────────────────────┐    ┌──────────────────────┐
                    │ cognee WORK   :7777      │    │ cognee CURATED :7730 │
                    │ project knowledge        │    │ reference library    │
                    │ + per-client memory      │    │ (read-mostly, shared)│
                    └──────────────────────────┘    └──────────────────────┘
```

- **Main session is leadership.** It loads MISHKAN identity from
  `~/.claude/CLAUDE.md` and routes work one level deep.
- **45 agents** across **6 teams** + **2 orchestrators** + a **6-stage research
  pipeline**.
- **Cognee** is the memory layer: two physically-isolated stores, with
  `cognify → memify` (extraction → enrichment) and `search` exposed via MCP.
- **Selective ingest**: docs enter the work graph only when tagged
  (`mishkan: ingest`) or explicitly invoked. No bulk-ingest, no PII bleed.

## Chapter index

| # | Chapter | What it covers |
|---|---|---|
| 01 | [Installation](./01-installation.md) | Prerequisites, `npx mishkan-harness install`, layout, uninstall |
| 02 | [Project initialisation](./02-project-init.md) | `/mishkan-init` flow, scope choices, brownfield handling |
| 03 | [Orchestration](./03-orchestration.md) | Main-session-as-orchestrator, model routing, skills on-demand |
| 04 | [Memory layer (cognee)](./04-memory-layer.md) | Work + curated stores, `cognify`/`memify`/`search`, UIs |
| 05 | [Selective ingest](./05-selective-ingest.md) | `mishkan-ingest`, frontmatter tagging, memory-is-opt-in |
| 06 | [LLM provider profiles](./06-llm-providers.md) | Gemini/NVIDIA/Ollama/OpenAI/Anthropic, rate vs daily caps |
| 07 | [Troubleshooting](./07-troubleshooting.md) | Real gotchas + fixes from the build |
| 08 | [Glossary](./08-glossary.md) | 45-agent roster (alias → role → team), key terms |
| 09 | [Dynamic Workflows](./09-workflows.md) | 10 org-level + 8 team-level workflows, ADR D-010 portfolio discipline |
| 10 | [Observability](./10-observability.md) | Cross-session daemon + Textual TUI; 8 tabs (Live · Agents · Workflows · Knowledge · Activity · Org-Ref · Usage · Skills), project filter (`p`) |
| 11 | [Graphify](./11-graphify.md) | Code-structure graph; queries at ~1.8k tokens (88.1× reduction, POC-verified); D-008 + D-009 |
| 12 | [Skill discovery](./12-skill-discovery.md) | Universal indexer + 3-bucket router across MISHKAN, user, plugin, and project skills; D-011 |

## Where to start

- **First install:** [Installation](./01-installation.md) → [Project init](./02-project-init.md).
- **Already installed, want to understand routing:** [Orchestration](./03-orchestration.md).
- **Want to add knowledge to memory:** [Selective ingest](./05-selective-ingest.md).
- **Hit an error:** [Troubleshooting](./07-troubleshooting.md).
- **Confused by an agent name:** [Glossary](./08-glossary.md).

## Authoritative references this documentation builds on

- [`docs/design/MISHKAN_harness_design.md`](../design/MISHKAN_harness_design.md) — the 5-layer architecture and rationale.
- [`docs/design/MISHKAN_decisions.md`](../design/MISHKAN_decisions.md) — D-001…D-011 with rationale.
- [`docs/design/MISHKAN_agent_aliases.md`](../design/MISHKAN_agent_aliases.md) — the biblical roster.
- [`docs/design/MISHKAN_ontology.md`](../design/MISHKAN_ontology.md) — cognee entity + relationship types.
- [`docs/design/MISHKAN_token_optimisation.md`](../design/MISHKAN_token_optimisation.md) — context economy.
- The harness git history — every operational claim in these docs traces back
  to a specific commit so docs and code stay anchored.

## Conventions used in this corpus

- **Code blocks** are copy-paste-ready (no hidden context unless noted).
- **Tables** carry choices and trade-offs; prose carries decisions.
- **`cmd`** = something you run. **`file`** = something you read or edit.
- *Italics* on a path on first mention; later mentions are plain `path`.
- "**You**" = the engineer at the keyboard. "**The agent**" = the main Claude
  session (which is *leadership* — that distinction matters; see
  [Orchestration](./03-orchestration.md)).
