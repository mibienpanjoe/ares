#!/usr/bin/env bash
# MISHKAN SessionStart — skill-index drift check (D-011 Phase 2).
#
# Runs the universal skill-discovery indexer in --stat-only mode at the start
# of every session. The indexer compares each known SKILL.md mtime against
# meta.last_scan and rebuilds only on drift (or if the index is missing).
#
# Performance contract: <= 200 ms p95. The stat-only sweep is just mtime calls
# against ~200 files; a full rebuild (rare) is bounded by file count and runs
# in well under a second.
#
# Fail-open by contract: any error -> exit 0 silently. The discovery layer
# never blocks a session boot. If indexing fails, the router will surface
# `index_missing_or_unreadable` on its next call and /ares-skills-reindex
# is the recovery path.
#
# Wired in payload/install/settings.hooks.json under SessionStart.

set -uo pipefail

runtime_home() {
  if [ -n "${ARES_HOME:-}" ]; then printf '%s' "$ARES_HOME"; return; fi
  if [ -n "${MISHKAN_HOME:-}" ]; then printf '%s' "$MISHKAN_HOME"; return; fi
  if [ -d "$HOME/.ares" ] || [ ! -d "$HOME/.claude/mishkan" ]; then printf '%s' "$HOME/.ares"; return; fi
  printf '%s' "$HOME/.claude/mishkan"
}
ARES_HOME_RES="$(runtime_home)"
INDEXER="${ARES_HOME_RES}/scripts/skill-discovery-indexer.py"

# Indexer missing (older harness install / partial payload) -> noop.
[ -f "$INDEXER" ] || exit 0

# python3 absent -> noop. Never block session boot on a missing interpreter.
command -v python3 >/dev/null 2>&1 || exit 0

# stat-only does the cheap path; rebuilds only on drift. --quiet keeps
# stdout empty so SessionStart additionalContext isn't polluted by indexer
# noise (this hook is purely a side-effect; the router consumes the index).
python3 "$INDEXER" --stat-only --quiet >/dev/null 2>&1 || true

exit 0
