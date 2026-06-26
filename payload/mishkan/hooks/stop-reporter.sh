#!/usr/bin/env bash
# MISHKAN Stop hook — Team Reporter milestone trigger.
#
# Claude Code's Stop fires on main-agent stop; SubagentStop fires for subagents.
# Detecting "a Team Reporter is finishing" from the hook payload alone is not
# reliable, so this hook uses a marker file convention: a Reporter agent (or the
# /sprint-close command) touches ~/.ares/logs/.reporter-active with the
# team name before assembling its report. This hook checks for that marker and,
# if present, signals the sprint-report skill to run, then clears the marker.
#
# Without the marker this hook is a no-op so it never interferes with ordinary
# session stops (which already play the finish sound via the existing Stop hook).
set -uo pipefail

runtime_home() {
  if [ -n "${ARES_HOME:-}" ]; then printf '%s' "$ARES_HOME"; return; fi
  if [ -n "${MISHKAN_HOME:-}" ]; then printf '%s' "$MISHKAN_HOME"; return; fi
  if [ -d "$HOME/.ares" ] || [ ! -d "$HOME/.claude/mishkan" ]; then printf '%s' "$HOME/.ares"; return; fi
  printf '%s' "$HOME/.claude/mishkan"
}
ARES_HOME_RES="$(runtime_home)"
LOG_DIR="${ARES_LOG_DIR:-${MISHKAN_LOG_DIR:-${ARES_HOME_RES}/logs}}"
MARKER="${LOG_DIR}/.reporter-active"

[ -f "$MARKER" ] || exit 0

team="$(cat "$MARKER" 2>/dev/null || echo unknown)"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Record that a reporter milestone assembly is due. The sprint-report skill,
# invoked by the reporter agent, performs the actual team-report.json assembly;
# this hook only emits the trigger breadcrumb and clears the marker.
echo "{\"event\":\"reporter_milestone\",\"team\":\"${team}\",\"timestamp\":\"${ts}\"}" \
  >> "${LOG_DIR}/milestones.jsonl" 2>/dev/null

rm -f "$MARKER" 2>/dev/null
exit 0
