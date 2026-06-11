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
  renders 8 tabs and a permanent status bar, with a project filter on `p`.

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

Single command — the TUI auto-starts the daemon if its socket isn't
present, waits up to 8 s for the bind, then opens. The daemon survives
the TUI's exit so a second `mishkan-watch` (e.g. in another tmux pane)
connects instantly.

```bash
mishkan-watch
```

Power users who want to manage the daemon explicitly (separate logs,
custom socket path, attached over SSH from another host) can opt out:

```bash
# terminal 1 — daemon, foreground (logs in your face)
mishkan-watchd start

# terminal 2 — TUI; refuses to fork the daemon
mishkan-watch --no-autostart
```

Stop the daemon when you're done:

```bash
mishkan-watchd stop
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

## The 8 tabs

| Key | Tab | What it answers |
|---|---|---|
| `1` | **Live** | "What is happening *right now*?" Active agents (with `alias · role` annotation), workflows in-flight, current worktrees, Cognee + Graphify + MCP rollup, rolling feed of every event. Default tab on launch. |
| `2` | **Agents** | "What did each agent do?" Sessions tree (left, project paths decoded) × agent history `DataTable` (centre) × errors panel (right). Phantom sessions filtered out at the daemon `_confirmed_alive` gate. |
| `3` | **Workflows** | "What did each dynamic workflow run, and what's *available* to run?" Recent runs (top) + static catalogue parsed from each script's `meta` block (description, when-to-use, phases). Click an entry for detail. |
| `4` | **Knowledge** | "Are my stores up and growing?" Three cards (`cognee-memory` + `cognee-curated` + graphify, real-time counts) × recent ops `DataTable` × MCP server status table. |
| `5` | **Activity** | Unified, filterable event stream. Regex filter + type/agent selects. Errors and blocked permissions break the visual rhythm with a separator line. |
| `6` | **Org-Ref** | Read-only browser of the 45-agent org from `org.json`. Tree by team, click a group → mission / charter / Hebrew name; click an agent → role, source, description. |
| `7` | **Usage** | Harness-wide tokens in/out/cached, cost, context window estimate, request counts. Per-session table sorted by token volume. Detail panel with per-agent attribution + top tools. |
| `8` | **Skills** | All installed skills (MISHKAN craft + community + plugin) grouped by origin × category. Right panel cross-references each skill to the CTO decisions (ADRs) that mention it. |

**Project filter (`p`)** — default off; press `p` to scope Live's ACTIVE
and WORKTREES to the current project only. Current project picked from
`CLAUDE_PROJECT_DIR` env var or `pwd` at launch.

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
| `cognee_poll` | 30 s | HTTP probe of `cognee-memory` (`:7777`) + `cognee-curated` (`:7730`) + cypher node counts |
| `session_tail` + `subagent_tail` | 3 s | inter-agent + compaction events from main session JSONL; subagent tool calls from nested `subagents/agent-*.jsonl` |

## Keybindings

```
1-8     switch tab (instantaneous)
p       toggle project filter (current ↔ all)
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
