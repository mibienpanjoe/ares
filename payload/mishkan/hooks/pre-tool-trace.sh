#!/usr/bin/env bash
# MISHKAN PreToolUse trace hook — records call-start timestamps so
# post-tool-observe.sh can compute duration_ms per tool call.
#
# Writes one line per (session, tool_use_id) pair to a tmpfile keyed by
# session. The PostToolUse hook reads back, diffs against now, and the
# tmpfile is pruned by the PostToolUse handler after consumption.
#
# Fail-open by contract: any parse / IO / format issue and we exit 0
# silently. Never blocks a tool call.

set -uo pipefail

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

INPUT="$(cat)"

session="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)"
tool_use_id="$(printf '%s' "$INPUT" | jq -r '.tool_use_id // empty' 2>/dev/null)"

# tool_use_id may be absent for some tool kinds — synthesize from name+timestamp.
if [ -z "$tool_use_id" ]; then
  tool="$(printf '%s' "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)"
  tool_use_id="${tool}-$(date +%s%N 2>/dev/null || date +%s)"
fi

trace_dir="${MISHKAN_TRACE_DIR:-/tmp}"
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

exit 0
