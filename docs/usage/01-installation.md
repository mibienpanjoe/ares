# 01 — Installation

> Goal: get MISHKAN installed and running on a host so the next session in any
> project picks it up automatically.

## Prerequisites

| Need | Why | How to check |
|---|---|---|
| **Claude Code** | the runtime | `claude --version` (≥ 2.x) |
| **Node 18+** | the installer (`bin/mishkan.js`) is dependency-free Node | `node --version` |
| **Docker** | the cognee memory stack runs locally in containers | `docker --version`, `docker ps` |
| **Disk** | ~20 GB free (Neo4j volumes, ollama models, postgres) | `df -h` |
| **`tsh` (optional)** | only if you're on a remote VPS and need to view the cognee UIs / Neo4j Browsers locally | `tsh version` |

The harness assumes a **single-user** machine. Multi-tenant scenarios are not
designed for and a few defaults (e.g. cognee's access control off) reflect that
(see [Memory layer](./04-memory-layer.md) and [D-007](../design/MISHKAN_decisions.md)).

## What gets installed where

Two target areas, distinct on purpose:

```
~/.claude/                          ← user-level Claude Code config
├── CLAUDE.md                       ← MISHKAN identity, loads on every session
├── rules/
│   ├── y4nn-standards.md           ← harness-maintained defaults (refreshed on update)
│   └── engineer-standards.md       ← YOUR override layer (installer never touches it)
├── settings.json                   ← hooks merged in (existing hooks preserved)
└── mishkan/                        ← everything MISHKAN under one prefix
    ├── agents/   (45)              ← Claude Code subagent definitions
    ├── rules/                      ← common + path-scoped team rules (JIT load)
    ├── hooks/                      ← security · observability · model-route · reporter
    ├── skills/   (10+)             ← orchestrated workflows
    ├── commands/                   ← /mishkan-init, /sprint-close, /promote, …
    ├── config/                     ← model-routing.yaml, curated-library.yaml
    └── cognee/                     ← Docker Compose stack for the memory layer
```

Per project, [`/mishkan-init`](./02-project-init.md) later seeds:

```
<project>/
├── CLAUDE.md                       ← project state (sprint slot)
├── .mcp.json                       ← cognee MCP connections (work + curated)
└── .claude/
    ├── rules/                      ← team rules copied for path-scoped loading
    ├── settings.json               ← deny-list (git push, ssh, sudo, docker exec)
    └── settings.local.json         ← gitignored local allow-list
```

## Install

From a clone of the harness repo:

```bash
cd ~/path/to/harness
node bin/mishkan.js install
```

Or via npx (after publishing — not done as of this writing):

```bash
npx mishkan-harness install
```

What the installer does (read `bin/mishkan.js` for the full list):

1. Copies `payload/user/rules/*` → `~/.claude/rules/` (refreshing `y4nn-standards.md`,
   installing `engineer-standards.md` once if absent).
2. Copies `payload/mishkan/*` → `~/.claude/mishkan/` under one clean prefix.
3. Symlinks `payload/mishkan/commands/*` → `~/.claude/commands/` (only if no
   filename collision with existing user commands).
4. Merges `payload/install/settings.hooks.json` into `~/.claude/settings.json`,
   resolving the `{{MISHKAN}}` placeholder to the absolute install path.
   **Existing hooks are preserved** (dedupe is by exact command string).
5. Writes an install stamp (version + timestamp) for `status` to read later.

## Verify the install

```bash
# layout
ls -la ~/.claude/mishkan/

# hooks merged
python3 -c "import json; d=json.load(open('$HOME/.claude/settings.json'));
print([ (e['matcher'], [h['command'] for h in e['hooks']]) for e in d['hooks']['PreToolUse']])"
# expected matchers include: Write|Edit|MultiEdit, Task|Agent

# model-routing hook is registered (live behaviour)
python3 -c "import json; d=json.load(open('$HOME/.claude/settings.json'));
assert any('model-route.py' in h['command']
           for e in d['hooks']['PreToolUse']
           for h in e['hooks']), 'model-route hook missing'
print('model-route hook: OK')"

# install stamp
cat ~/.claude/mishkan/.install-stamp.json 2>/dev/null
```

## Bring the cognee memory stack up

The harness ships the memory layer as a Docker Compose stack. Two boxes:
**work** (per-project knowledge, port `:7777`) and **curated** (shared reference
library, port `:7730`). See [memory layer](./04-memory-layer.md) for the
full design.

```bash
cd ~/.claude/mishkan/cognee

# 1. secrets — start from the example, SOPS-manage the real .env later
cp .env.example .env
# … fill LLM_API_KEY and pick a provider profile (see chapter 06)

# 2. bring up the work stack (always with the hardening overlay)
docker compose -f docker-compose.yml -f docker-compose.hardening.yml up -d --build

# 3. bring up the curated box (one-time per host, idempotent helper)
bash ~/.claude/mishkan/scripts/ensure-curated-box.sh

# 4. seed the curated reference library (96 nodes; runs cognify→memify)
bash ~/.claude/mishkan/scripts/seed-curated-library.sh
```

Health checks:

```bash
docker ps --filter 'name=mishkan-' --format '{{.Names}}\t{{.Status}}'
# expected (all "healthy" once warm):
#   mishkan-cognee-mcp        / -neo4j / -pg / -backend / -frontend
#   mishkan-curated-mcp       / -neo4j
#   mishkan-ollama
#   (if curated UI overlay enabled) mishkan-curated-backend / -frontend

curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7777/mcp  # 406 = healthy (no MCP handshake)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7730/mcp  # 406 = healthy
```

## Upgrade

Re-run the installer. The default standards file (`y4nn-standards.md`) is
refreshed; **`engineer-standards.md` is left alone** so your customisations
survive across updates. The hook fragment is merged additively.

## Uninstall

```bash
node bin/mishkan.js uninstall
```

Removes:
- `~/.claude/mishkan/` entirely.
- Symlinks under `~/.claude/commands/` that point into the mishkan tree.
- Hook entries whose command paths include `/mishkan/hooks/` are stripped from
  `~/.claude/settings.json` (your own hooks remain).

Does **not** remove:
- `~/.claude/rules/` (you may keep, archive, or delete by hand).
- The cognee Docker volumes (use `docker compose down -v` from
  `~/.claude/mishkan/cognee/` if you also want to wipe the graph).

## Status

```bash
node bin/mishkan.js status
```

Prints version, install timestamp, and a quick layout check.

## See also

- Up next: [Project initialisation](./02-project-init.md) — running
  `/mishkan-init` in a project directory.
- [LLM provider profiles](./06-llm-providers.md) — choosing what powers the
  cognee LLM/embedding calls.
- Live install record (D-005 npm package): [`docs/design/MISHKAN_decisions.md`](../design/MISHKAN_decisions.md).
- Initial harness commit: `35fa034`.
