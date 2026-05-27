#!/usr/bin/env bash
# MISHKAN PostToolUse observability hook.
# Emits one append-only JSON line per tool call into the session log.
# Minimal: no parsing, no blocking. Token/cost enrichment happens later in the
# observability aggregation step (Phase 8) which reads these raw lines.
set -uo pipefail

LOG_DIR="${HOME}/.claude/mishkan/logs"
mkdir -p "$LOG_DIR"

INPUT="$(cat)"

if ! command -v jq >/dev/null 2>&1; then
  # Fail open — never let observability break a tool call.
  exit 0
fi

session="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)"
tool="$(printf '%s' "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Outcome inferred from tool_response if present.
outcome="$(printf '%s' "$INPUT" | jq -r '
  if (.tool_response.error? // empty) != "" then "blocked" else "completed" end
' 2>/dev/null)"
[ -z "$outcome" ] && outcome="completed"

# Append a raw event line. agent/team/sprint/tokens are enriched later from
# session context; recorded here as null when the hook payload lacks them.
jq -nc \
  --arg session "$session" \
  --arg tool "$tool" \
  --arg outcome "$outcome" \
  --arg ts "$ts" \
  '{
     session: $session,
     tool_calls: [$tool],
     outcome: $outcome,
     timestamp: $ts,
     agent: null, team: null, sprint: null,
     tokens_input: 0, tokens_cached: 0, tokens_output: 0,
     cost: 0, cognee_writes: 0
   }' >> "${LOG_DIR}/${session}.jsonl" 2>/dev/null

exit 0
