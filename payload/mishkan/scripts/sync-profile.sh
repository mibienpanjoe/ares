#!/usr/bin/env bash
# MISHKAN — profile propagation (mechanical layer).
# Copies the canonical engineer profile to the runtime path every reference uses,
# and audits the harness for references + drift. The semantic re-derivation of
# digests drawn from the profile is Seraiah's job, not this script's.
#
# Usage:
#   sync-profile.sh            # copy canonical -> runtime, then report references
#   sync-profile.sh --check    # report references + drift only (no copy)
#
# Canonical source resolution:
#   1. $MISHKAN_PROFILE_SRC if set
#   2. <repo>/docs/engineer/profile.md  (when run from a MISHKAN checkout)
#   3. the existing runtime copy (treated as source if no repo canonical found)
set -uo pipefail

MISHKAN="${HOME}/.claude/mishkan"
RUNTIME="${MISHKAN}/profile.md"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

resolve_src() {
  if [ -n "${MISHKAN_PROFILE_SRC:-}" ] && [ -f "$MISHKAN_PROFILE_SRC" ]; then
    echo "$MISHKAN_PROFILE_SRC"; return
  fi
  # walk up from cwd looking for docs/engineer/profile.md
  local d; d="$(pwd)"
  while [ "$d" != "/" ]; do
    [ -f "$d/docs/engineer/profile.md" ] && { echo "$d/docs/engineer/profile.md"; return; }
    d="$(dirname "$d")"
  done
  [ -f "$RUNTIME" ] && { echo "$RUNTIME"; return; }
  echo ""; return
}

SRC="$(resolve_src)"
if [ -z "$SRC" ]; then
  echo "sync-profile: no canonical profile found (set MISHKAN_PROFILE_SRC or run from a MISHKAN checkout)." >&2
  exit 1
fi

if [ "$CHECK_ONLY" -eq 0 ]; then
  if [ "$SRC" != "$RUNTIME" ]; then
    mkdir -p "$MISHKAN"
    cp "$SRC" "$RUNTIME"
    echo "synced: $SRC -> $RUNTIME"
  else
    echo "canonical == runtime ($RUNTIME); nothing to copy."
  fi
fi

echo "--- references to the engineer profile across the harness ---"
# Files that reference the runtime path (exclude this script and the runtime file itself).
grep -rl "profile.md" "$MISHKAN" "${HOME}/.claude/CLAUDE.md" --exclude=sync-profile.sh 2>/dev/null \
  | grep -v "/profile.md$" | sed "s#${HOME}#~#g" || echo "  (no path references found)"

# Stale check excludes this script (its grep pattern contains the legacy string by design).
STALE="$(grep -rl "Y4NN_profile" "$MISHKAN" "${HOME}/.claude/CLAUDE.md" --exclude=sync-profile.sh 2>/dev/null || true)"
if [ -n "$STALE" ]; then
  echo "--- DRIFT: stale 'Y4NN_profile' references (should be 'profile.md') ---"
  echo "$STALE" | sed "s#${HOME}#~#g"
  echo ">> Ask Seraiah to update these and re-derive any digests."
else
  echo "no stale references. (Semantic digests in CLAUDE.md are Seraiah's to re-derive if the profile changed materially.)"
fi
