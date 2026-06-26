#!/usr/bin/env bash
# MISHKAN SessionStart hook — DEFERRED (design §20, pending Claude Code stability).
#
# Intended behaviour: on a new context window, load sprint state from the
# project ./CLAUDE.md and query Cognee for active blockers, so Nehemiah greets
# with current context. Until the SessionStart hook event is validated as
# stable, this work lives in the /ares-resume command instead, and this
# script is NOT registered in settings.json.
#
# Kept here so that, once SessionStart is confirmed, wiring it is a one-line
# settings change rather than new development.
set -uo pipefail

PROJECT_CLAUDE="./CLAUDE.md"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ -f "$PROJECT_CLAUDE" ] && grep -q "Cognee namespace" "$PROJECT_CLAUDE" 2>/dev/null; then
  echo "ares/session-start: ARES project detected at ${ts}. Run /ares-resume to restore sprint state." >&2
fi
exit 0
