#!/usr/bin/env bash
# MISHKAN observability bus — shared shell emitter.
#
# Encapsulates the append-only NDJSON event write used by all hooks. Fail-open
# by contract: if jq is missing, the log dir cannot be created, or the
# append fails, we exit 0 silently — observability NEVER breaks a tool call.
#
# Usage from a hook script:
#
#   source "${ARES_HOME:-$HOME/.ares}/observability/bus.sh"
#   bus_emit "$session" "$type" "$tool" "$outcome" '{"k": "v"}'
#
# Args (positional, all optional except $1 session and $2 type):
#   $1  session id (use "unknown" if not derivable)
#   $2  event type (must be one of schema.json enum)
#   $3  tool name              (empty allowed)
#   $4  outcome                (empty allowed)
#   $5  payload JSON object    (empty -> {})
#   $6  agent name             (empty -> null)
#   $7  subagent_id            (empty -> null)
#
# The event always carries: ts (ms-precision UTC), session, project (pwd),
# type, and (for back-compat) timestamp + tool_calls + outcome.

set -uo pipefail

# Resolve log dir, fail-open if mkdir fails (e.g. read-only FS).
_bus_log_dir() {
  local runtime_home
  if [ -n "${ARES_HOME:-}" ]; then
    runtime_home="$ARES_HOME"
  elif [ -n "${MISHKAN_HOME:-}" ]; then
    runtime_home="$MISHKAN_HOME"
  elif [ -d "$HOME/.ares" ] || [ ! -d "$HOME/.claude/mishkan" ]; then
    runtime_home="$HOME/.ares"
  else
    runtime_home="$HOME/.claude/mishkan"
  fi
  local dir="${ARES_LOG_DIR:-${MISHKAN_LOG_DIR:-${runtime_home}/logs}}"
  mkdir -p "$dir" 2>/dev/null || return 1
  printf '%s' "$dir"
}

# Generate ms-precision UTC ISO-8601. Falls back to second-precision if the
# host date lacks %N support (BSD date, busybox). Never blocks.
_bus_ts() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null)" || \
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # Some BSD date variants emit literal "%3N" — strip and fallback if so.
  if printf '%s' "$ts" | grep -q '%3N'; then
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
  printf '%s' "$ts"
}

bus_emit() {
  command -v jq >/dev/null 2>&1 || return 0

  local session="${1:-unknown}"
  local type="${2:-}"
  local tool="${3:-}"
  local outcome="${4:-}"
  local payload_json="${5:-}"
  local agent="${6:-}"
  local subagent_id="${7:-}"

  [ -z "$type" ] && return 0

  local dir
  dir="$(_bus_log_dir)" || return 0

  local ts ts_legacy project
  ts="$(_bus_ts)"
  ts_legacy="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  project="$(pwd 2>/dev/null || printf 'unknown')"

  # Build the legacy tool_calls array (single element when tool is set).
  local tool_calls_json='[]'
  if [ -n "$tool" ]; then
    tool_calls_json="$(jq -cn --arg t "$tool" '[$t]' 2>/dev/null || printf '[]')"
  fi

  # Default payload to {} when absent or invalid.
  if [ -z "$payload_json" ]; then
    payload_json='{}'
  fi
  # Validate payload is JSON-parseable; replace with {} if not.
  if ! printf '%s' "$payload_json" | jq -e . >/dev/null 2>&1; then
    payload_json='{}'
  fi

  local line
  line="$(jq -cn \
    --arg ts "$ts" \
    --arg ts_legacy "$ts_legacy" \
    --arg session "$session" \
    --arg project "$project" \
    --arg type "$type" \
    --arg tool "$tool" \
    --arg outcome "$outcome" \
    --arg agent "$agent" \
    --arg subagent_id "$subagent_id" \
    --argjson tool_calls "$tool_calls_json" \
    --argjson payload "$payload_json" \
    '{
       ts: $ts,
       session: $session,
       project: $project,
       agent: (if $agent == "" then null else $agent end),
       subagent_id: (if $subagent_id == "" then null else $subagent_id end),
       type: $type,
       tool: (if $tool == "" then null else $tool end),
       outcome: (if $outcome == "" then null else $outcome end),
       payload: $payload,
       timestamp: $ts_legacy,
       tool_calls: $tool_calls,
       team: null, sprint: null,
       tokens_input: 0, tokens_cached: 0, tokens_output: 0,
       cost: 0, cognee_writes: 0
     }' 2>/dev/null)"

  [ -z "$line" ] && return 0

  printf '%s\n' "$line" >> "${dir}/${session}.jsonl" 2>/dev/null
  return 0
}
