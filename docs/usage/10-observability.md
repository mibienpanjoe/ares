# 10 — Observability

> Goal: see every running agent, workflow, tool call, hook decision, token
> spend, and MCP/Cognee status across all your MISHKAN sessions in real
> time — in a single Textual TUI. Two `uv tool`-installable Python packages.

## What it is

Two artefacts that ship as one stack:

- **`mishkan-watchd`** — Python asyncio daemon. Aggregates the Phase 1+1.5
  event bus (`~/.claude/mishkan/logs/<session>.jsonl`) plus 6 filesystem /
  network sources into a single in-memory snapshot. Exposes it on a UNIX
  socket as a snapshot + delta + heartbeat NDJSON stream.
- **`mishkan-watch`** — Textual TUI client. Connects to the daemon socket,
  renders 5 tabs and a permanent status bar.

See the design doc [`docs/design/MISHKAN_observability.md`](../design/MISHKAN_observability.md)
for the full event schema, daemon architecture, and TUI layout.

## Install

Auto-installed during `npx mishkan-harness install` (phase 7) — the installer
prompts once. Or run standalone any time:

```bash
npx mishkan-harness observability
```

Requirements: `uv` (https://astral.sh/uv) and Python 3.11+. If `uv` is
missing:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Manual install (equivalent to what the installer does):

```bash
uv tool install --from ~/.claude/mishkan/observability/watchd mishkan-watchd
uv tool install --from ~/.claude/mishkan/observability/watch  mishkan-watch
```

## Run

Two processes, two terminals (or two tmux panes):

```bash
# terminal 1 — daemon, foreground
mishkan-watchd start

# terminal 2 — TUI
mishkan-watch
```

Daemon lifecycle is always manual. Auto-start follow-up:

```bash
mishkan-watchd install-service     # writes ~/.config/systemd/user/mishkan-watchd.service
systemctl --user enable --now mishkan-watchd.service
```

Quick state check:

```bash
mishkan-watchd status              # connect, print current snapshot as JSON
mishkan-watchd stop                # SIGTERM via the PID file
```

## The 5 tabs

| # | Tab | What it answers |
|---|---|---|
| 1 | **Live** | "What is happening *right now*?" Active agents, workflows in-flight, current worktrees, Cognee + MCP rollup, rolling feed of every event. Default tab on launch. |
| 2 | **Agents** | "What did each agent do?" Sessions tree (left) × agent history `DataTable` (centre) × errors panel (right). Per-session current-agent tracking attributes subagent tool calls to the right agent (sourced via `subagent_tail`). |
| 3 | **Workflows** | "What did each dynamic workflow run?" Cards list (left) × phase tree with fan-out + cost (right). Populated from `workflow_start` events; phase/agent detail lights up as the `Workflow` tool runs. |
| 4 | **Knowledge** | "Are my Cognee stores up and growing?" Two cards (work + curated, real-time node counts via neo4j HTTP cypher) × recent ops `DataTable` × MCP server status table covering Cognee + every other configured MCP. |
| 5 | **Activity** | Unified, filterable event stream. Regex filter + type/agent selects. Errors and blocked permissions break the visual rhythm with a separator line. |

## The status bar

Always visible across every tab. Refreshed on a 500 ms tick:

```
 ⏵ 02h14m23s · 142.4k in · 18.2k out · 89.1k cached · est. $2.40 · 2 agents · 1 wf · connected
```

Session age · cumulative input/output/cache tokens · estimated cost in USD
(model pricing baked into the daemon) · active agents · active workflows ·
daemon connection status.

When the daemon goes down, the bar shows `daemon offline: …` and the TUI
keeps running with the last snapshot; the client reconnects on exponential
backoff (1 s → 30 s cap).

## Where data comes from

Six daemon sources, each independent and fail-open:

| Source | Cadence | What |
|---|---|---|
| `bus_tail` | streaming (inotify) | every line of `~/.claude/mishkan/logs/*.jsonl` (Phase 1+1.5 events) |
| `session_discover` | 10 s | active Claude Code sessions (mtime < 60 s) |
| `worktree_poll` | 5 s | `git worktree list --porcelain` per known project |
| `mcp_probe` | 60 s | discover MCPs from `~/.claude.json` + `.mcp.json` + `mcp-needs-auth-cache.json`; probe each by HTTP/TCP |
| `cognee_poll` | 30 s | HTTP probe of cognee work + curated + cypher node count |
| `session_tail` + `subagent_tail` | 3 s | inter-agent + compaction events from main session JSONL; subagent tool calls from nested `subagents/agent-*.jsonl` |

## Keybindings

```
1-5     switch tab (instantaneous)
q       quit
j/k ↑↓  move focus within current panel
tab     move focus between panels
/       filter (Activity tab)
End     resume auto-scroll
?       brief help in status bar
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| TUI shows everything empty | Daemon not running, or socket missing | `pgrep -af mishkan-watchd`; if absent: `mishkan-watchd start` |
| Status bar says `daemon offline: …` | Daemon process died or `~/.claude/mishkan/run/watch.sock` was unlinked | Restart the daemon; the TUI auto-reconnects |
| Cognee cards show `0` or `?` nodes | Neo4j HTTP credentials missing or wrong | Verify `~/.claude/mishkan/cognee/.env` has `GRAPH_DATABASE_PASSWORD`; curated store reads `.env.curated` (different password). |
| MCP table empty | No MCP configs found | Confirm `~/.claude.json` has projects with `.mcp.json`; or initialise a project with `/mishkan-init` to seed cognee MCP entries |
| Agent history empty for a subagent | Subagent ran BEFORE the daemon started (`subagent_tail` seeks to end-of-file) | Launch a fresh Task — its tool calls will populate the history live |
| TUI feels laggy under load | Event bursts exceeding render budget | Already throttled in v0.2.0 (status bar at 500 ms; ACTIVE re-renders only on structural events); restart the TUI if it inherited an old build |
| Bytes diff between source & install | `uv tool install --force` reuses cache | `uv tool uninstall mishkan-watch mishkan-watchd && uv cache clean mishkan-watch mishkan-watchd && uv tool install --from <path> …` |

## What it is NOT

- Not a metrics platform (no Prometheus export). The bus IS the historical
  record; rotation is filesystem-driven.
- Not a debugger — it shows state and recent events, not stepping.
- Not a remote console — it observes; the engineer still drives Claude Code.
- Not an attribution / billing tool — token cost is best-effort from
  per-model rate tables baked into the daemon.

## See also

- [Design doc](../design/MISHKAN_observability.md) — full event schema, daemon
  architecture, 5 tab decompositions, color tokens, UX invariants.
- [Token & context management](../design/MISHKAN_token_optimisation.md) —
  what the harness shapes, what Claude Code does natively.
- [Memory layer](./04-memory-layer.md) — the Cognee stores that the
  observability stack reports on.
