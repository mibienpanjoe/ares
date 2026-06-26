# ares-watchd

ARES observability daemon. Aggregates the Phase 1+1.5 event bus plus
filesystem polls into a single UNIX-socket snapshot+delta stream. Read by
`ares-watch` (TUI client, separate package).

Opt-in install per §10.2 of `docs/design/MISHKAN_observability.md`:

```bash
uv tool install --from <path-to-this-dir> ares-watchd
```

## Commands

```bash
ares-watchd start                     # run in foreground (default tmux pane)
ares-watchd stop                      # SIGTERM the running daemon (PID file)
ares-watchd status                    # connect, print current snapshot
ares-watchd install-service           # write ~/.config/systemd/user/ares-watchd.service
```

Defaults (overridable on every command):

```
--socket        ~/.ares/run/watch.sock
--log-dir       ~/.ares/logs
--projects-dir  ~/.claude/projects
```

## Sources

| Source | Cadence | What |
|---|---|---|
| `bus_tail` | streaming | inotify on `<log-dir>/*.jsonl` — every Phase 1+1.5 event |
| `session_discover` | 10 s | active Claude Code sessions (mtime < 60 s window) |
| `worktree_poll` | 5 s | `git worktree list --porcelain` per known project |
| `mcp_probe` | 60 s | HTTP/TCP probe of every MCP server in `.mcp.json` files |
| `session_tail` | 3 s | inter-agent return messages + compaction events from session JSONL |

All sources push bus-format event dicts into a shared asyncio queue. The
dispatcher applies each event to the in-memory `HarnessState` and
broadcasts to connected clients.

## Protocol

UNIX socket, line-delimited JSON. On connect:

1. One `snapshot` frame: `{"type":"snapshot","ts":"...","state":{...}}`
2. Stream of `delta` frames: `{"type":"delta","event":{...bus event...}}`
3. Heartbeat every 5 s: `{"type":"heartbeat","ts":"..."}`

No auth beyond filesystem perms (socket is created `0600`, owner-only).
No schema versioning yet. Add a control frame channel if needed.

## Fail-open contract

Every source coroutine catches exceptions internally and continues.
A dead source degrades the daemon to a partial picture but never crashes
it. Daemon restart rebuilds state from scratch in ~10 seconds.
