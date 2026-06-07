#!/usr/bin/env bash
# MISHKAN PreToolUse — graphify-first advisory (Phase 1: telemetry-only).
#
# Per D-009 (MISHKAN_decisions.md):
#
# Phase 1 — emit a `hook_fire` event whenever a structural Read or Grep
# fires on a source file. No advisory text injected; never blocks. The
# purpose is to baseline the rate of "structural reads that could have
# been a graphify query" before turning on advisory injection in Phase 2.
#
# Triggers:
#   - Read on file_path ending in a source extension (.py .ts .tsx .js
#     .jsx .mjs .cjs .go .rs .java .php .rb)
#   - Grep on a bare-identifier pattern (^[A-Za-z_][A-Za-z0-9_]*$)
#
# NOT triggers (configs / markdown / YAML / regex Grep patterns). Per
# D-009 §2.
#
# Performance contract: <= 50 ms p95. Bash hot path keeps the cold-start
# below the Python alternative (the D-009 §6 unknown). No subprocess
# beyond jq; fail-open everywhere; never blocks a tool call.

set -uo pipefail

# jq absent -> noop. Observability never breaks a tool call.
command -v jq >/dev/null 2>&1 || exit 0

# Source the observability bus (fail-open if not yet installed).
MISHKAN_HOME_RES="${MISHKAN_HOME:-$HOME/.claude/mishkan}"
# shellcheck disable=SC1091
source "${MISHKAN_HOME_RES}/observability/bus.sh" 2>/dev/null || exit 0

INPUT="$(cat)"
tool="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)"
session="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)"

# Structural-Read detection.
target=""
structural=0
case "$tool" in
  Read)
    path="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
    lc_path="$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')"
    case "$lc_path" in
      *.py|*.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.go|*.rs|*.java|*.php|*.rb)
        structural=1
        target="$path"
        ;;
    esac
    ;;
  Grep)
    pattern="$(printf '%s' "$INPUT" | jq -r '.tool_input.pattern // empty' 2>/dev/null)"
    # Bare identifier only: ^[A-Za-z_][A-Za-z0-9_]*$
    if [ -n "$pattern" ] && printf '%s' "$pattern" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$'; then
      structural=1
      target="$pattern"
    fi
    ;;
esac

[ "$structural" = 1 ] || exit 0

# Phase 1: telemetry only. No stdout (Claude Code's default "allow"
# applies), no advisory injection, no per-agent gating yet. The daemon
# attributes the event to the active subagent via the existing
# session-current-agent tracking in the Agents tab.
if command -v bus_emit >/dev/null 2>&1; then
  # Truncate target to 120 chars to keep the payload small.
  short_target="$(printf '%s' "$target" | cut -c1-120)"
  payload="$(jq -cn --arg t "$short_target" \
    '{hook:"graphify-nudge", decision:"ok", phase:1,
      reason:"structural read/grep detected (telemetry)",
      target:$t}' 2>/dev/null)"
  bus_emit "$session" "hook_fire" "$tool" "completed" "$payload"
fi

exit 0
