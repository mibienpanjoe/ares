# MISHKAN Observability — Phase 1

Bus enrichment. Auto-installed via `npx mishkan-harness install` — no
runtime dependencies beyond `jq` (shell) and stdlib Python 3.

See `docs/design/MISHKAN_observability.md` (root of harness) for the full
spec; this README is the operator-level summary.

## What ships here

```
schema.json         JSON Schema (draft-07) for all event types
bus.sh              Shell emitter — sourced by hook scripts
bus.py              Python emitter — imported by python hooks
```

Hook scripts under `payload/mishkan/hooks/`:

```
pre-tool-trace.sh           NEW — PreToolUse timing baseline
post-tool-observe.sh        ENRICHED — emits tool_call + derived events
pre-tool-security.sh        ENRICHED — emits hook_fire (ira allow/deny)
model-route.py              ENRICHED — emits hook_fire (routing decision)
```

## Where events land

```
~/.claude/mishkan/logs/<session-id>.jsonl     append-only NDJSON
/tmp/mishkan-trace-<session-id>.tmp           ephemeral timing trace
```

One file per Claude Code session. The trace file is consumed
incrementally by the PostToolUse hook and pruned line-by-line.

## Event types currently emitted

| Type | Source | Trigger |
|---|---|---|
| `tool_call` | post-tool-observe.sh | every tool call |
| `file_change` | post-tool-observe.sh | Write / Edit / MultiEdit |
| `agent_spawn` | post-tool-observe.sh | Task / Agent tool |
| `skill_invoke` | post-tool-observe.sh | Skill tool |
| `plan` | post-tool-observe.sh | ExitPlanMode |
| `web_query` | post-tool-observe.sh | WebFetch / WebSearch |
| `cron_event` | post-tool-observe.sh | CronCreate / CronDelete / CronList |
| `error` | post-tool-observe.sh | outcome=errored OR blocked |
| `hook_fire` | pre-tool-security.sh | Ira allow / deny |
| `hook_fire` | model-route.py | model routing decision |

Deferred (next phases of the observability stack):

- `token_usage` — Phase 1.5 (session JSONL `usage` block parser)
- `inter_agent`, `compaction` — Phase 2 (daemon-side session JSONL tail)
- `worktree_change`, `mcp_server`, `cognee_op`, `graphify_*`,
  `workflow_*` — Phase 2/4 (daemon sources)

## Fail-open contract

Every emitter exits 0 on any failure (jq missing, mkdir fails, JSON
malformed, disk full, anything). Observability **never** blocks a tool
call or breaks a hook decision. If `~/.claude/mishkan/logs/` is missing
or unwritable, events silently disappear; correctness of the tool call is
preserved.

## Inspection

Tail the current session's events:

```bash
ls -t ~/.claude/mishkan/logs/*.jsonl | head -1 | xargs tail -F
```

Filter by type:

```bash
tail -F ~/.claude/mishkan/logs/<session>.jsonl | jq -c 'select(.type=="file_change")'
```

Count event types over a session:

```bash
jq -r .type ~/.claude/mishkan/logs/<session>.jsonl | sort | uniq -c | sort -rn
```

## Schema validation

```bash
# Validate a session log against the schema (requires `ajv-cli` or similar)
npx -y ajv-cli validate -s schema.json -d ~/.claude/mishkan/logs/<session>.jsonl
```

## Back-compatibility

Existing consumers that read the original `post-tool-observe.sh` shape
(`session`, `tool_calls`, `outcome`, `timestamp`, `agent`, `team`,
`sprint`, `tokens_input`, `tokens_cached`, `tokens_output`, `cost`,
`cognee_writes`) keep working. The Phase 1 enrichment is purely additive:
new fields (`ts`, `project`, `type`, `tool`, `duration_ms`, `payload`)
sit alongside the originals.
