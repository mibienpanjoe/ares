# 01 — Installation

> Goal: get ARES installed and running on a host so the next session in any
> target runtime can pick it up.

## Prerequisites

| Need | Why | How to check |
|---|---|---|
| **Claude Code / Codex CLI / OpenCode** | at least one target runtime | runtime-specific version command |
| **Node 18+** | the installer (`bin/ares.js`) is dependency-free Node | `node --version` |
| **Docker** | the cognee memory stack runs locally in containers | `docker --version`, `docker ps` |
| **Disk** | ~20 GB free (Neo4j volumes, ollama models, postgres) | `df -h` |
| **`tsh` (optional)** | only if you're on a remote VPS and need to view the cognee UIs / Neo4j Browsers locally | `tsh version` |

The harness assumes a **single-user** machine. Multi-tenant scenarios are not
designed for and a few defaults (e.g. cognee's access control off) reflect that
(see [Memory layer](./04-memory-layer.md) and [D-007](../design/MISHKAN_decisions.md)).

## What gets installed where

Two areas, distinct on purpose:

```
~/.ares/                            ← shared ARES payload cache
├── agents/                         ← 45 source agent definitions
├── rules/                          ← common + path-scoped team rules
├── hooks/                          ← shared audited hook scripts
├── skills/                         ← orchestrated workflows and craft skills
├── commands/                       ← /ares-init, /sprint-close, /promote, …
├── config/                         ← model-routing.yaml, curated-library.yaml
└── cognee/                         ← Docker Compose stack for the memory layer

~/.claude/                          ← Claude target links into ~/.ares
~/.codex/                           ← Codex target AGENTS.md, agents, hooks, MCP
~/.config/opencode/                 ← OpenCode agents, commands, hook plugins, MCP
```

Per project, [`/ares-init`](./02-project-init.md) or `ares project init` later seeds:

```
<project>/
├── CLAUDE.md / AGENTS.md           ← target-native project state
├── .mcp.json / .codex/config.toml / opencode.json
└── .claude/ / .codex/ / .opencode/ target-native support files
```

## Install

From a clone of the harness repo:

```bash
cd ~/path/to/harness
node bin/ares.js install --target claude
node bin/ares.js install --target codex
node bin/ares.js install --target opencode
```

Or via npx (published to npm):

```bash
npx ares-harness install --target codex
```

The installer walks **7 named phases** with a one-line "why" under each header,
so you can see what is happening and what it gives you. Last phase asks once
whether to install the **observability stack** (daemon + TUI) — opt-in, see
[chapter 10](./10-observability.md).

Phases:

1. **Payload** — copy `payload/mishkan/*` → `~/.ares/` under one
   clean prefix (agents, skills, commands, hooks, rules, cognee compose,
   observability sources).
2. **Engineer profile** — place runtime profile (gitignored real profile if
   present, otherwise sanitized example). Never overwrites an existing edited
   one.
3. **User-level rules** — refresh harness default `y4nn-standards.md`;
   preserve your `engineer-standards.md` and `CLAUDE.md`.
4. **Target adapter** — generate target-native agents, commands/skills, and
   guidance files, plus one portable skill tree at `~/.agents/skills` shared by
   Codex and OpenCode. Skips on filename collisions where preserving user files
   matters.
5. **Hooks** — merge the Claude fragment into `~/.claude/settings.json`, the
   audited Codex lifecycle hooks into `~/.codex/hooks.json`, and OpenCode's
   session/tool adapters into `~/.config/opencode/plugins`. Existing Claude and
   Codex hooks are preserved and managed commands are deduplicated.
6. **Stamp** — record version + timestamp for `status` / `uninstall` to read.
7. **Observability (opt-in)** — prompts to install `ares-watchd` and
   `ares-watch` via `uv tool`. Skipped cleanly if `uv` isn't on PATH; you
   can re-run it later with `npx ares-harness observability install`.

## Verify the install

```bash
# layout
ls -la ~/.ares/

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

# all target-native wiring, including Codex/OpenCode safe hooks
ares runtime check --target all --strict

# install stamp
cat ~/.ares/.install-stamp.json 2>/dev/null
```

Codex reviews non-managed hook definitions before first execution. Open `/hooks`
in the Codex CLI, inspect the ARES commands under `~/.codex/hooks.json`, and
trust them explicitly. Do not use `--dangerously-bypass-hook-trust` for normal
interactive work.

## Memory backend

ARES defaults to native runtime memory. Use `/memory` in Claude Code and
`/memories` in Codex for cross-session recall. Keep required rules and project
facts in `CLAUDE.md`, `AGENTS.md`, and `docs/` so they are deterministic.

Cognee is optional advanced infrastructure. Use it only when you need a
queryable semantic graph, curated library, or explicit MCP retrieval surface.
Three pillars are available: **per-project work stores** (one isolated Ladybug
container per project), **cognee-memory** (`:7777`, shared per-client session
memory), and **cognee-curated** (`:7730`, shared reference library). See
[memory layer](./04-memory-layer.md) for the full design (D-007 + D-012).

The guided path is one command — it preflights the config, names any gap, then
brings up the shared stack (base + hardening + selfhosted overlays) and seeds the
curated box:

```bash
ares project init --target all --memory cognee
ares knowledge configure           # wizard: LLM_API_KEY + provider profile → .env (see chapter 06)
ares knowledge-stack up            # memory :7777 + curated :7730, idempotent (~5 min cold start)
```

<details><summary>What <code>knowledge-stack up</code> wraps, if you prefer the manual steps</summary>

```bash
cd ~/.ares/cognee

# 1. secrets — start from the example, SOPS-manage the real .env later
cp .env.example .env
# … fill LLM_API_KEY and pick a provider profile (see chapter 06)

# 2. bring up the stack (base + hardening + selfhosted overlays)
docker compose -f docker-compose.yml -f docker-compose.hardening.yml -f docker-compose.selfhosted.yml up -d --build

# 3. bring up the curated box (one-time per host, idempotent helper)
bash ~/.ares/scripts/ensure-curated-box.sh

# 4. seed the curated reference library (96 nodes; runs cognify→memify)
bash ~/.ares/scripts/seed-curated-library.sh
```

</details>

Health checks:

```bash
docker ps --filter 'name=ares-' --format '{{.Names}}\t{{.Status}}'
# expected (all "healthy" once warm):
#   ares-cognee-mcp        / -neo4j / -pg / -backend / -frontend
#   ares-curated-mcp       / -neo4j
#   ares-ollama
#   (if curated UI overlay enabled) ares-curated-backend / -frontend

curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7777/mcp  # 406 = healthy (no MCP handshake)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7730/mcp  # 406 = healthy
```

## Upgrade

Re-run the installer. The default standards file (`y4nn-standards.md`) is
refreshed; **`engineer-standards.md` is left alone** so your customisations
survive across updates. The hook fragment is merged additively.

## Uninstall

```bash
node bin/ares.js uninstall
```

Removes:
- `~/.ares/` and generated target files.
- Symlinks under `~/.claude/commands/` that point into the mishkan tree.
- Hook entries whose command paths include `/mishkan/hooks/` are stripped from
  `~/.claude/settings.json` (your own hooks remain).

Does **not** remove:
- `~/.claude/rules/` (you may keep, archive, or delete by hand).
- The cognee Docker volumes (use `docker compose down -v` from
  `~/.ares/cognee/` if you also want to wipe the graph).

Legacy runtime cleanup is explicit and separate:

```bash
node bin/ares.js migrate legacy-mishkan       # copy ~/.claude/mishkan -> ~/.ares
node bin/ares.js uninstall --legacy-mishkan   # remove only ~/.claude/mishkan
```

`uninstall --legacy-mishkan` refuses to delete the old runtime when `~/.ares`
is absent, unless you pass `--force`.

## Status

```bash
node bin/ares.js status --target all
```

Prints version, install timestamp, and a quick layout check.

## Observability stack (opt-in)

The installer's phase 7 asks whether to install the cross-session observability
stack. You can also run it standalone any time:

```bash
npx ares-harness observability install
```

Requirements: `uv` (https://astral.sh/uv) and Python 3.11+. If `uv` is not on
PATH, the step is skipped cleanly with a one-liner showing how to install it
and rerun. See [chapter 10](./10-observability.md) for the full operator guide.

## See also

- Up next: [Project initialisation](./02-project-init.md) — running
  `/ares-init` in a project directory.
- [LLM provider profiles](./06-llm-providers.md) — choosing what powers the
  cognee LLM/embedding calls.
- [Observability](./10-observability.md) — live daemon + TUI for cross-session
  monitoring.
- Live install record (D-005 npm package): [`docs/design/MISHKAN_decisions.md`](../design/MISHKAN_decisions.md).
- Initial harness commit: `35fa034`.
