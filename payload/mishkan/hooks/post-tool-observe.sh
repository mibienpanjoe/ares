#!/usr/bin/env bash
# MISHKAN PostToolUse observability hook.
#
# Emits the canonical tool_call event (back-compat with the original schema:
# session, tool_calls[], outcome, timestamp, agent/team/sprint/tokens/cost
# all preserved) plus type-specific derived events:
#
#   - Write/Edit/MultiEdit    -> file_change (path + lines_added/removed)
#   - Task                    -> agent_spawn (subagent_type + agentId)
#   - Skill                   -> skill_invoke
#   - ExitPlanMode            -> plan (exit + approved + excerpt)
#   - WebFetch / WebSearch    -> web_query
#   - CronCreate / CronDelete -> cron_event
#   - outcome in {blocked,errored} -> error (in addition to tool_call)
#
# Also computes duration_ms by diffing against the pre-tool-trace.sh tmpfile,
# and prunes the consumed trace row.
#
# Fail-open by contract: never let observability break a tool call.
set -uo pipefail

INPUT="$(cat)"

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

MISHKAN_HOME_RES="${MISHKAN_HOME:-$HOME/.claude/mishkan}"
# shellcheck disable=SC1091
source "${MISHKAN_HOME_RES}/observability/bus.sh" 2>/dev/null || exit 0

LOG_DIR="${MISHKAN_LOG_DIR:-$HOME/.claude/mishkan/logs}"
TRACE_DIR="${MISHKAN_TRACE_DIR:-/tmp}"
mkdir -p "$LOG_DIR" 2>/dev/null || exit 0

session="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)"
tool="$(printf '%s' "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)"
tool_use_id="$(printf '%s' "$INPUT" | jq -r '.tool_use_id // empty' 2>/dev/null)"
ts_legacy="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Outcome inferred from tool_response if present.
outcome="$(printf '%s' "$INPUT" | jq -r '
  if (.tool_response.error? // empty) != "" then "errored"
  elif (.tool_response.permissionDecision? // empty) == "deny" then "blocked"
  else "completed" end
' 2>/dev/null)"
[ -z "$outcome" ] && outcome="completed"

# ---------------------------------------------------------------------------
# Duration from the pre-tool-trace tmpfile, when available.
# ---------------------------------------------------------------------------
duration_ms=0
trace_file="${TRACE_DIR}/mishkan-trace-${session}.tmp"
if [ -n "$tool_use_id" ] && [ -f "$trace_file" ]; then
  start_ms="$(grep -F "${tool_use_id}	" "$trace_file" 2>/dev/null | tail -n1 | cut -f2)"
  if [ -n "$start_ms" ]; then
    end_ms="$(date +%s%3N 2>/dev/null)"
    if ! printf '%s' "$end_ms" | grep -q 'N'; then
      duration_ms=$(( end_ms - start_ms ))
      [ "$duration_ms" -lt 0 ] && duration_ms=0
    fi
    if command -v sed >/dev/null 2>&1; then
      sed -i.bak "/^${tool_use_id}	/d" "$trace_file" 2>/dev/null && rm -f "${trace_file}.bak"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Canonical tool_call event — back-compat with the original schema.
# ---------------------------------------------------------------------------
project="$(pwd 2>/dev/null || printf 'unknown')"
jq -nc \
  --arg session "$session" \
  --arg project "$project" \
  --arg tool "$tool" \
  --arg outcome "$outcome" \
  --arg ts "$ts_legacy" \
  --argjson duration_ms "$duration_ms" \
  '{
     ts: $ts,
     session: $session,
     project: $project,
     agent: null, subagent_id: null,
     type: "tool_call",
     tool: $tool,
     outcome: $outcome,
     duration_ms: $duration_ms,
     payload: {},
     timestamp: $ts,
     tool_calls: [$tool],
     team: null, sprint: null,
     tokens_input: 0, tokens_cached: 0, tokens_output: 0,
     cost: 0, cognee_writes: 0
   }' >> "${LOG_DIR}/${session}.jsonl" 2>/dev/null

# ---------------------------------------------------------------------------
# Derived events by tool_name.
# ---------------------------------------------------------------------------
case "$tool" in

  Write)
    path="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
    if [ -n "$path" ] && [ "$outcome" = "completed" ]; then
      lines_added="$(printf '%s' "$INPUT" | jq -r '
        .tool_input.content // "" | split("\n") | length
      ' 2>/dev/null)"
      [ -z "$lines_added" ] && lines_added=0
      payload="$(jq -cn --arg p "$path" --argjson la "$lines_added" \
        '{path:$p, op:"write", lines_added:$la, lines_removed:0}')"
      bus_emit "$session" "file_change" "$tool" "$outcome" "$payload"
    fi
    ;;

  Edit)
    path="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
    if [ -n "$path" ] && [ "$outcome" = "completed" ]; then
      la="$(printf '%s' "$INPUT" | jq -r '.tool_input.new_string // "" | split("\n") | length' 2>/dev/null)"
      lr="$(printf '%s' "$INPUT" | jq -r '.tool_input.old_string // "" | split("\n") | length' 2>/dev/null)"
      [ -z "$la" ] && la=0
      [ -z "$lr" ] && lr=0
      payload="$(jq -cn --arg p "$path" --argjson la "$la" --argjson lr "$lr" \
        '{path:$p, op:"edit", lines_added:$la, lines_removed:$lr}')"
      bus_emit "$session" "file_change" "$tool" "$outcome" "$payload"
    fi
    ;;

  MultiEdit)
    path="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
    if [ -n "$path" ] && [ "$outcome" = "completed" ]; then
      la="$(printf '%s' "$INPUT" | jq -r '[.tool_input.edits[]? | (.new_string // "") | split("\n") | length] | add // 0' 2>/dev/null)"
      lr="$(printf '%s' "$INPUT" | jq -r '[.tool_input.edits[]? | (.old_string // "") | split("\n") | length] | add // 0' 2>/dev/null)"
      [ -z "$la" ] && la=0
      [ -z "$lr" ] && lr=0
      payload="$(jq -cn --arg p "$path" --argjson la "$la" --argjson lr "$lr" \
        '{path:$p, op:"multiedit", lines_added:$la, lines_removed:$lr}')"
      bus_emit "$session" "file_change" "$tool" "$outcome" "$payload"
    fi
    ;;

  Task|Agent)
    subagent="$(printf '%s' "$INPUT" | jq -r '.tool_input.subagent_type // empty' 2>/dev/null)"
    desc="$(printf '%s' "$INPUT" | jq -r '.tool_input.description // empty' 2>/dev/null)"
    model="$(printf '%s' "$INPUT" | jq -r '.tool_input.model // empty' 2>/dev/null)"
    agent_id="$(printf '%s' "$INPUT" | jq -r '.tool_response.agentId? // .tool_response.id? // empty' 2>/dev/null)"
    if [ -n "$subagent" ]; then
      payload="$(jq -cn \
        --arg s "$subagent" --arg d "$desc" --arg m "$model" \
        '{subagent_type:$s} + (if $d=="" then {} else {description:$d} end) + (if $m=="" then {} else {model:$m} end)')"
      bus_emit "$session" "agent_spawn" "$tool" "$outcome" "$payload" "$subagent" "$agent_id"
    fi
    ;;

  Skill)
    skill="$(printf '%s' "$INPUT" | jq -r '.tool_input.skill // empty' 2>/dev/null)"
    args="$(printf '%s' "$INPUT" | jq -r '.tool_input.args // empty' 2>/dev/null)"
    if [ -n "$skill" ]; then
      payload="$(jq -cn --arg s "$skill" --arg a "$args" \
        '{skill:$s} + (if $a=="" then {} else {args:$a} end)')"
      bus_emit "$session" "skill_invoke" "$tool" "$outcome" "$payload"
    fi
    ;;

  ExitPlanMode)
    plan_text="$(printf '%s' "$INPUT" | jq -r '.tool_input.plan // empty' 2>/dev/null)"
    excerpt="$(printf '%s' "$plan_text" | head -c 200 | tr -d '\r')"
    approved="$(printf '%s' "$INPUT" | jq -r '
      if (.tool_response.approved? // empty) == true then "true"
      elif (.tool_response.approved? // empty) == false then "false"
      else "" end
    ' 2>/dev/null)"
    if [ "$approved" = "true" ] || [ "$approved" = "false" ]; then
      payload="$(jq -cn --argjson ap "$approved" --arg ex "$excerpt" \
        '{phase:"exit", approved:$ap, plan_excerpt:$ex}')"
    else
      payload="$(jq -cn --arg ex "$excerpt" \
        '{phase:"exit", approved:null, plan_excerpt:$ex}')"
    fi
    bus_emit "$session" "plan" "$tool" "$outcome" "$payload"
    ;;

  WebFetch)
    url="$(printf '%s' "$INPUT" | jq -r '.tool_input.url // empty' 2>/dev/null)"
    prompt="$(printf '%s' "$INPUT" | jq -r '.tool_input.prompt // empty' 2>/dev/null)"
    payload="$(jq -cn --arg u "$url" --arg q "$prompt" \
      '{kind:"fetch", url:$u, query:$q}')"
    bus_emit "$session" "web_query" "$tool" "$outcome" "$payload"
    ;;

  WebSearch)
    query="$(printf '%s' "$INPUT" | jq -r '.tool_input.query // empty' 2>/dev/null)"
    payload="$(jq -cn --arg q "$query" '{kind:"search", query:$q}')"
    bus_emit "$session" "web_query" "$tool" "$outcome" "$payload"
    ;;

  CronCreate)
    cron_id="$(printf '%s' "$INPUT" | jq -r '.tool_response.id? // .tool_input.id? // empty' 2>/dev/null)"
    sched="$(printf '%s' "$INPUT" | jq -r '.tool_input.schedule // empty' 2>/dev/null)"
    payload="$(jq -cn --arg id "$cron_id" --arg s "$sched" \
      '{action:"create"} + (if $id=="" then {cron_id:null} else {cron_id:$id} end) + (if $s=="" then {} else {schedule:$s} end)')"
    bus_emit "$session" "cron_event" "$tool" "$outcome" "$payload"
    ;;

  CronDelete)
    cron_id="$(printf '%s' "$INPUT" | jq -r '.tool_input.id // empty' 2>/dev/null)"
    payload="$(jq -cn --arg id "$cron_id" \
      '{action:"delete"} + (if $id=="" then {cron_id:null} else {cron_id:$id} end)')"
    bus_emit "$session" "cron_event" "$tool" "$outcome" "$payload"
    ;;

  CronList)
    payload='{"action":"list"}'
    bus_emit "$session" "cron_event" "$tool" "$outcome" "$payload"
    ;;

esac

# ---------------------------------------------------------------------------
# Error event when the tool itself failed or was blocked by a hook.
# ---------------------------------------------------------------------------
if [ "$outcome" = "errored" ] || [ "$outcome" = "blocked" ]; then
  err_msg="$(printf '%s' "$INPUT" | jq -r '
    .tool_response.error? // .tool_response.permissionDecisionReason? // ""
  ' 2>/dev/null)"
  severity="soft"
  [ "$outcome" = "blocked" ] && severity="warning"
  payload="$(jq -cn --arg m "$err_msg" --arg s "$severity" --arg c "$tool" \
    '{message:$m, severity:$s, context:$c}')"
  bus_emit "$session" "error" "$tool" "$outcome" "$payload"
fi

exit 0
