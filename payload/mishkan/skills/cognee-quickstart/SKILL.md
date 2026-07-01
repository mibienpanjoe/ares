---
name: cognee-quickstart
description: Set up Cognee for MISHKAN — choose the install path, create a clean Python env, configure LLM/embedding providers and (optionally) PostgreSQL/Neo4j backends, and wire it to the harness. Use before first bringing up the knowledge graph, or when Cognee setup hits friction (Python version, venv, API keys, optional extras). Mirrors Cognee's official LLM quickstart skill.
---

# cognee-quickstart

Get Cognee running for MISHKAN with minimal friction. Adapted from Cognee's
official quickstart skill (https://docs.cognee.ai/getting-started/llm-quickstart-skill)
and local-setup docs (https://docs.cognee.ai/cognee-mcp/mcp-local-setup).

Cognee core is a **Python library** (`await cognee.remember(...)` /
`await cognee.recall(...)`). MISHKAN consumes it through the **`cognee-mcp`**
server, declared in `.mcp.json`. This skill gets both right.

## 1. Choose the integration mode

| Mode | When | Wiring |
|---|---|---|
| **HTTP container (default)** | you want a long-running graph service on :7777 | `~/.claude/mishkan/cognee/` compose; `.mcp.json` HTTP entry → `http://localhost:7777/mcp` |
| **stdio (zero infra)** | simplest, no container | `.mcp.json` `_stdio_alternative`: `uv --directory <cognee-mcp> run cognee-mcp` |

> **Per-project work stores (ADR D-012):** under MISHKAN each project's `cognee`
> alias points at its OWN container (embedded Ladybug, own port), provisioned by
> `ensure-work-store.sh` at `/mishkan-init` — not a single shared `:7777`. The
> shared `:7777` box is now `cognee-memory` (session memory); curated is `:7730`.
> This skill covers the underlying cognee-mcp setup those stores build on.

## 2. Prerequisites

- Python (confirm the version Cognee requires in its docs).
- `uv` (`brew install uv` or the platform equivalent).
- `LLM_API_KEY` (OpenAI key by default) — SOPS-managed, never plaintext-committed.

## 3. Install the library / MCP

```bash
# library smoke test (optional)
uv pip install cognee

# MCP server (cloned at a pinned ref)
git clone https://github.com/topoteretes/cognee.git
cd cognee && git checkout <PINNED_TAG_OR_COMMIT>
cd cognee-mcp && uv sync --dev --all-extras --reinstall
```

## 4. Configure providers

- Set `LLM_API_KEY` in `~/.claude/mishkan/cognee/.env` (SOPS).
- Default backends are local (no extra services). For PostgreSQL/pgvector or
  Neo4j, set the relevant cognee env vars per the docs and add the backend to the
  compose file.

## 5. Bring it up + verify

- Container HTTP mode: `docker compose -f docker-compose.yml -f docker-compose.hardening.yml up -d --build`, then `nc -z localhost 7777`. (Under MISHKAN the human path that wraps this — config preflight + curated seed + selfhosted overlay — is `mishkan knowledge-stack up`; the raw compose here is the under-the-hood reference.)
- stdio mode: nothing to start — Claude Code spawns it from `.mcp.json`.

## 6. Seed + confirm in the harness

```bash
~/.claude/mishkan/scripts/seed-curated-library.sh     # 96 curated nodes
```

Then a quick recall through the MCP confirms the graph answers. From here the
graph grows through use (knowledge promotion at sprint close).

## Constraints

Pin the cognee ref (no floating). `LLM_API_KEY` and all secrets via SOPS/age.
Stateful operations (the actual `docker up`, key entry) are run by the engineer, not the
agent — the skill prepares the commands. English only.
