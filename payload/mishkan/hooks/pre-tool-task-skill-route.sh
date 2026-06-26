#!/usr/bin/env bash
# MISHKAN PreToolUse — auto-inject skill-discovery advisory on Task calls
# (D-011 Phase 2).
#
# Fires before Task / Agent (subagent) tool calls. Reads the task prompt
# from the Claude Code hook stdin payload, runs the universal
# skill-discovery router in --format injection mode, and returns the
# resulting compact markdown block via the official PreToolUse
# additionalContext field — Claude prepends it to the subagent's prompt.
#
# Output protocol (Claude Code hooks):
#     {
#       "hookSpecificOutput": {
#         "hookEventName": "PreToolUse",
#         "additionalContext": "## Discovered skills (advisory)\n..."
#       }
#     }
#
# This is the documented contract for PreToolUse advisory context — the
# same shape SessionStart uses for additionalContext. We deliberately do
# NOT set permissionDecision: the router is advisory, never a gate.
#
# Performance contract: <= 100 ms p95. The router is a small stdlib-only
# Python script reading a flat JSON index; cold-start is the dominant cost
# (~40-60 ms on the harness host) and only fires once per Task call.
#
# Hard constraints:
#   - Hard cap 600 tokens of injection (router enforces; we trust it).
#   - Skip injection entirely on empty buckets — do not pollute the
#     subagent prompt with "no skills found" noise.
#   - Fail-open on every error path: no output, exit 0, never block the
#     Task call.
#   - Trust marker preserved: non-runtime entries already get a
#     "(community)" suffix from the router's injection renderer.
#
# Wired in payload/install/settings.hooks.json under PreToolUse with
# matcher "Task|Agent" (matches the existing model-route entry pattern).

set -uo pipefail

# jq absent -> noop. The Task call proceeds without advisory injection.
command -v jq >/dev/null 2>&1 || exit 0
# python3 absent -> noop, same reason.
command -v python3 >/dev/null 2>&1 || exit 0

runtime_home() {
  if [ -n "${ARES_HOME:-}" ]; then printf '%s' "$ARES_HOME"; return; fi
  if [ -n "${MISHKAN_HOME:-}" ]; then printf '%s' "$MISHKAN_HOME"; return; fi
  if [ -d "$HOME/.ares" ] || [ ! -d "$HOME/.claude/mishkan" ]; then printf '%s' "$HOME/.ares"; return; fi
  printf '%s' "$HOME/.claude/mishkan"
}
ARES_HOME_RES="$(runtime_home)"
ROUTER="${ARES_HOME_RES}/scripts/skill-discovery-router.py"
[ -f "$ROUTER" ] || exit 0

# Source the observability bus (fail-open if not installed).
# shellcheck disable=SC1091
source "${ARES_HOME_RES}/observability/bus.sh" 2>/dev/null || true

INPUT="$(cat)"
tool="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)"
session="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)"

# Belt-and-braces matcher: settings.json already filters to Task|Agent,
# but if a future Claude Code release widens the matcher we'd be a noop
# anyway. Better to short-circuit explicitly.
case "$tool" in
  Task|Agent) ;;
  *) exit 0 ;;
esac

# Extract the subagent's prompt. Task/Agent payloads carry the prompt at
# .tool_input.prompt; if absent we have nothing to route on.
prompt="$(printf '%s' "$INPUT" | jq -r '.tool_input.prompt // empty' 2>/dev/null)"
if [ -z "$prompt" ]; then
  exit 0
fi

# Truncate to a sane size before handing to the router. The router's
# tokenizer caps usefully around ~500 chars of signal; we cap higher to
# preserve trailing keywords, but past 4 KB we're just paying cold-start
# tokens for nothing.
prompt_trim="$(printf '%s' "$prompt" | head -c 4000)"

# Run the router. We pass --format injection so we get the compact
# markdown block (empty when buckets are empty). Timeout caps the
# worst-case at 1.5 s — well above the 100 ms p95 budget but a hard floor
# against a wedged interpreter blocking the Task call.
block="$(
  timeout 1.5s python3 "$ROUTER" \
    --task "$prompt_trim" \
    --format injection \
    --max-injection-tokens 600 2>/dev/null
)" || block=""

# Empty injection -> skip entirely. No additionalContext key, no noise.
if [ -z "$block" ]; then
  if command -v bus_emit >/dev/null 2>&1; then
    payload="$(jq -cn '{hook:"task-skill-route", decision:"ok",
                        reason:"no skills matched (empty buckets)"}' 2>/dev/null)"
    bus_emit "$session" "hook_fire" "$tool" "completed" "$payload"
  fi
  exit 0
fi

# Build the PreToolUse hookSpecificOutput envelope. additionalContext is
# the documented field for advisory text prepended to the tool's prompt
# (Claude Code hooks docs, PreToolUse section). We do NOT set
# permissionDecision — advisory only, never a gate.
jq -cn --arg ctx "$block" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $ctx
  }
}'

if command -v bus_emit >/dev/null 2>&1; then
  # Truncate the bus payload — the full block lives in the Task's context,
  # not in the event log.
  preview="$(printf '%s' "$block" | head -c 200 | tr '\n' ' ')"
  payload="$(jq -cn --arg p "$preview" \
    '{hook:"task-skill-route", decision:"allow",
      reason:"injected skill-discovery advisory",
      preview:$p}' 2>/dev/null)"
  bus_emit "$session" "hook_fire" "$tool" "completed" "$payload"
fi

exit 0
