#!/usr/bin/env bash
# MISHKAN PreToolUse trace hook — two responsibilities:
#
# 1. Records call-start timestamps so post-tool-observe.sh can compute
#    duration_ms per tool call. Writes one line per (session, tool_use_id)
#    to a tmpfile keyed by session. PostToolUse reads back, diffs, prunes.
#
# 2. Emits agent_spawn for Task|Agent tool invocations so the daemon can
#    track live agents from the moment they start (not when they finish).
#    The spawn event carries tool_use_id as the stable correlation key so
#    state.py can pair it with the agent_complete emitted by PostToolUse.
#
# Fail-open by contract: any parse / IO / format issue and we exit 0
# silently. Never blocks a tool call.

set -uo pipefail

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

INPUT="$(cat)"

session="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)"
tool="$(printf '%s' "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)"
tool_use_id="$(printf '%s' "$INPUT" | jq -r '.tool_use_id // empty' 2>/dev/null)"

# tool_use_id may be absent for some tool kinds — synthesize from name+timestamp.
if [ -z "$tool_use_id" ]; then
  tool_use_id="${tool}-$(date +%s%N 2>/dev/null || date +%s)"
fi

trace_dir="${ARES_TRACE_DIR:-${MISHKAN_TRACE_DIR:-/tmp}}"
mkdir -p "$trace_dir" 2>/dev/null || exit 0

start_ms="$(date +%s%3N 2>/dev/null)"
# Fallback when %3N is unsupported (BSD date, busybox).
if printf '%s' "$start_ms" | grep -q 'N'; then
  start_ms="$(date +%s)000"
fi

# Append a {tool_use_id, start_ms} entry to the per-session trace file.
# Append-only keeps the hook trivial; PostToolUse grep-deletes its row.
printf '%s\t%s\n' "$tool_use_id" "$start_ms" \
  >> "${trace_dir}/mishkan-trace-${session}.tmp" 2>/dev/null

# ---------------------------------------------------------------------------
# agent_spawn — emitted here (PreToolUse) so the daemon sees the agent as
# active from the START of a Task/Agent call, not after it completes.
# tool_use_id is the correlation key used by both spawn and complete events.
# agentId is not available yet at PreToolUse time — that's expected.
# ---------------------------------------------------------------------------
case "$tool" in
  Task|Agent)
    runtime_home() {
      if [ -n "${ARES_HOME:-}" ]; then printf '%s' "$ARES_HOME"; return; fi
      if [ -n "${MISHKAN_HOME:-}" ]; then printf '%s' "$MISHKAN_HOME"; return; fi
      if [ -d "$HOME/.ares" ] || [ ! -d "$HOME/.claude/mishkan" ]; then printf '%s' "$HOME/.ares"; return; fi
      printf '%s' "$HOME/.claude/mishkan"
    }
    ARES_HOME_RES="$(runtime_home)"
    # shellcheck disable=SC1091
    source "${ARES_HOME_RES}/observability/bus.sh" 2>/dev/null || exit 0

    subagent="$(printf '%s' "$INPUT" | jq -r '.tool_input.subagent_type // empty' 2>/dev/null)"
    desc="$(printf '%s' "$INPUT" | jq -r '.tool_input.description // empty' 2>/dev/null)"
    model="$(printf '%s' "$INPUT" | jq -r '.tool_input.model // empty' 2>/dev/null)"

    if [ -n "$subagent" ] && [ -n "$tool_use_id" ]; then
      payload="$(jq -cn \
        --arg s "$subagent" \
        --arg d "$desc" \
        --arg m "$model" \
        --arg tid "$tool_use_id" \
        '{subagent_type:$s, tool_use_id:$tid}
         + (if $d=="" then {} else {description:$d} end)
         + (if $m=="" then {} else {model:$m} end)' 2>/dev/null)"
      bus_emit "$session" "agent_spawn" "$tool" "started" "$payload" "$subagent" ""
    fi
    ;;
esac

exit 0
