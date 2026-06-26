#!/usr/bin/env bash
# MISHKAN PostToolUse observability hook.
#
# Emits the canonical tool_call event (back-compat with the original schema:
# session, tool_calls[], outcome, timestamp, agent/team/sprint/tokens/cost
# all preserved) plus type-specific derived events:
#
#   - Write/Edit/MultiEdit or apply_patch
#                              -> file_change (path + lines_added/removed)
#   - Task                    -> agent_complete (subagent_type + tool_use_id)
#                                (agent_spawn is emitted at PreToolUse by
#                                pre-tool-trace.sh, when the agent starts)
#   - Bash (graphify ...)     -> graphify_query / graphify_scan
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

runtime_home() {
  if [ -n "${ARES_HOME:-}" ]; then printf '%s' "$ARES_HOME"; return; fi
  if [ -n "${MISHKAN_HOME:-}" ]; then printf '%s' "$MISHKAN_HOME"; return; fi
  if [ -d "$HOME/.ares" ] || [ ! -d "$HOME/.claude/mishkan" ]; then printf '%s' "$HOME/.ares"; return; fi
  printf '%s' "$HOME/.claude/mishkan"
}
ARES_HOME_RES="$(runtime_home)"
# shellcheck disable=SC1091
source "${ARES_HOME_RES}/observability/bus.sh" 2>/dev/null || exit 0

LOG_DIR="${ARES_LOG_DIR:-${MISHKAN_LOG_DIR:-${ARES_HOME_RES}/logs}}"
TRACE_DIR="${ARES_TRACE_DIR:-${MISHKAN_TRACE_DIR:-/tmp}}"
mkdir -p "$LOG_DIR" 2>/dev/null || exit 0

session="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)"
tool="$(printf '%s' "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)"
tool_use_id="$(printf '%s' "$INPUT" | jq -r '.tool_use_id // empty' 2>/dev/null)"
ts_legacy="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Outcome inferred from tool_response if present.
outcome="$(printf '%s' "$INPUT" | jq -r '
  if (.tool_response.error? // empty) != "" then "errored"
  elif (.tool_response.isError? // false) == true then "errored"
  elif (.tool_response.is_error? // false) == true then "errored"
  elif (.tool_response.status? // empty) == "error" then "errored"
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
project="$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)"
[ -z "$project" ] && project="$(pwd 2>/dev/null || printf 'unknown')"
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

  apply_patch)
    # Codex exposes the raw patch in tool_input.command. Emit one file_change
    # per patch file and count only unified-diff +/- lines for that file.
    patch_command="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"
    if [ -n "$patch_command" ] && [ "$outcome" = "completed" ]; then
      while IFS=$'\t' read -r path op la lr; do
        [ -z "$path" ] && continue
        [ -z "$la" ] && la=0
        [ -z "$lr" ] && lr=0
        payload="$(jq -cn \
          --arg p "$path" --arg op "$op" --argjson la "$la" --argjson lr "$lr" \
          '{path:$p, op:$op, lines_added:$la, lines_removed:$lr}')"
        bus_emit "$session" "file_change" "$tool" "$outcome" "$payload"
      done < <(printf '%s\n' "$patch_command" | awk '
        function emit() {
          if (path != "") printf "%s\t%s\t%d\t%d\n", path, op, added, removed
        }
        /^\*\*\* (Add|Update|Delete) File: / {
          emit()
          op = tolower($2)
          path = $0
          sub(/^\*\*\* (Add|Update|Delete) File: /, "", path)
          added = 0
          removed = 0
          next
        }
        /^\*\*\* Move to: / {
          path = $0
          sub(/^\*\*\* Move to: /, "", path)
          op = "move"
          next
        }
        /^\+/ { added++; next }
        /^-/ { removed++; next }
        END { emit() }
      ' 2>/dev/null)
    fi
    ;;

  Task|Agent)
    # agent_spawn is emitted by pre-tool-trace.sh (PreToolUse) when the task
    # starts. Here at PostToolUse we emit agent_complete so the daemon can
    # decrement the active-agent count. Both events carry tool_use_id as the
    # stable key so state.py can match spawn→complete even when two concurrent
    # agents share the same subagent_type name.
    subagent="$(printf '%s' "$INPUT" | jq -r '.tool_input.subagent_type // empty' 2>/dev/null)"
    agent_id="$(printf '%s' "$INPUT" | jq -r '.tool_response.agentId? // .tool_response.id? // empty' 2>/dev/null)"
    if [ -n "$subagent" ] && [ -n "$tool_use_id" ]; then
      payload="$(jq -cn \
        --arg s "$subagent" --arg tid "$tool_use_id" --arg aid "$agent_id" \
        '{subagent_type:$s, tool_use_id:$tid}
         + (if $aid=="" then {} else {agentId:$aid} end)')"
      bus_emit "$session" "agent_complete" "$tool" "$outcome" "$payload" "$subagent" "$agent_id"
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

  Bash)
    # Detect graphify CLI invocations so the daemon can count real queries
    # and scans. Only emit on completed calls — errored/blocked calls did
    # not produce a graph result, so they must not count.
    if [ "$outcome" = "completed" ]; then
      cmd="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"
      project_dir="$(printf '%s' "$INPUT" | jq -r '.tool_input.cwd // empty' 2>/dev/null)"
      [ -z "$project_dir" ] && project_dir="$(pwd 2>/dev/null || printf 'unknown')"

      # Match graphify query (with or without npx prefix, with or without
      # leading cd; capture the quoted question argument).
      if printf '%s' "$cmd" | grep -qE '(^|&&|;|\|\|)\s*(npx\s+graphify|graphify)\s+.*\bquery\b'; then
        # Extract the quoted question: first double- or single-quoted string
        # after the word "query", or bare word(s) after it. Truncate to 200.
        question="$(printf '%s' "$cmd" | \
          sed -E 's/.*\bquery\b[[:space:]]*//' | \
          sed -E 's/^"([^"]{0,200}).*/\1/;t;s/^'"'"'([^'"'"']{0,200}).*/\1/;t;s/^(.{0,200}).*/\1/' \
          2>/dev/null || true)"
        # Detect traversal flag for query_type.
        query_type=""
        if printf '%s' "$cmd" | grep -qE '\-\-dfs'; then
          query_type="dfs"
        elif printf '%s' "$cmd" | grep -qE '\-\-context'; then
          query_type="context"
        fi
        payload="$(jq -cn \
          --arg q "$question" \
          --arg p "$project_dir" \
          --arg qt "$query_type" \
          '{project:$p}
           + (if $q=="" then {} else {question:$q} end)
           + (if $qt=="" then {} else {query_type:$qt} end)' 2>/dev/null)"
        bus_emit "$session" "graphify_query" "$tool" "$outcome" "$payload"

      elif printf '%s' "$cmd" | grep -qE '(^|&&|;|\|\|)\s*(npx\s+graphify|graphify)\s+.*(update|scan)\b'; then
        payload="$(jq -cn --arg p "$project_dir" '{project:$p}' 2>/dev/null)"
        bus_emit "$session" "graphify_scan" "$tool" "$outcome" "$payload"
      fi
    fi
    ;;

  Workflow)
    wf_name="$(printf '%s' "$INPUT" | jq -r '.tool_input.name // empty' 2>/dev/null)"
    wf_script="$(printf '%s' "$INPUT" | jq -r '.tool_input.scriptPath // empty' 2>/dev/null)"
    run_id="$(printf '%s' "$INPUT" | jq -r '.tool_response.runId? // empty' 2>/dev/null)"
    if [ -z "$run_id" ]; then
      run_id="wf-$(date +%s%N 2>/dev/null || date +%s)"
    fi
    payload="$(jq -cn --arg n "$wf_name" --arg s "$wf_script" --arg r "$run_id" \
      '{name:$n, scriptPath:$s, run_id:$r, workflow_id:$r}')"
    bus_emit "$session" "workflow_start" "$tool" "$outcome" "$payload"
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

# ---------------------------------------------------------------------------
# Phase 1.5 — token usage parser (best-effort sidecar). Fail-open.
# Parses the session JSONL `usage` blocks since the tracked byte offset and
# emits one `token_usage` event per new assistant turn. Synchronous but fast
# (typical < 50 ms); any error path returns immediately.
# ---------------------------------------------------------------------------
if command -v python3 >/dev/null 2>&1 && [ -f "${ARES_HOME_RES}/observability/usage_parser.py" ]; then
  python3 "${ARES_HOME_RES}/observability/usage_parser.py" "$session" 2>/dev/null || true
fi

exit 0
