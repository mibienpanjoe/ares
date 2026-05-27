#!/usr/bin/env bash
# MISHKAN Stop hook — Team Reporter milestone trigger.
#
# Claude Code's Stop fires on main-agent stop; SubagentStop fires for subagents.
# Detecting "a Team Reporter is finishing" from the hook payload alone is not
# reliable, so this hook uses a marker file convention: a Reporter agent (or the
# /sprint-close command) touches ~/.claude/mishkan/logs/.reporter-active with the
# team name before assembling its report. This hook checks for that marker and,
# if present, signals the sprint-report skill to run, then clears the marker.
#
# Without the marker this hook is a no-op so it never interferes with ordinary
# session stops (which already play the finish sound via the existing Stop hook).
set -uo pipefail

MARKER="${HOME}/.claude/mishkan/logs/.reporter-active"

[ -f "$MARKER" ] || exit 0

team="$(cat "$MARKER" 2>/dev/null || echo unknown)"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Record that a reporter milestone assembly is due. The sprint-report skill,
# invoked by the reporter agent, performs the actual team-report.json assembly;
# this hook only emits the trigger breadcrumb and clears the marker.
echo "{\"event\":\"reporter_milestone\",\"team\":\"${team}\",\"timestamp\":\"${ts}\"}" \
  >> "${HOME}/.claude/mishkan/logs/milestones.jsonl" 2>/dev/null

rm -f "$MARKER" 2>/dev/null
exit 0
