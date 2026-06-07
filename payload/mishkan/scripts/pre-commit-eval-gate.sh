#!/usr/bin/env bash
# pre-commit-eval-gate.sh — run MISHKAN evals if their contract surface changed.
#
# Optional install: symlink as your repo's .git/hooks/pre-commit so the gate
# fires before every commit. Detects whether the staged changes touch any
# eval's sentinel paths; runs only the affected eval(s).
#
# Install:
#   ln -s "$(pwd)/payload/mishkan/scripts/pre-commit-eval-gate.sh" .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Uninstall:
#   rm .git/hooks/pre-commit
#
# Exit codes:
#   0 → no relevant changes OR all triggered evals passed
#   1 → at least one eval failed (commit blocked)
#   2 → an eval's environment is missing (jq, validator)
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$REPO_ROOT"

changed=$(git diff --cached --name-only --diff-filter=ACMR)
[[ -z "$changed" ]] && exit 0

trigger_baruch=false
while IFS= read -r f; do
  case "$f" in
    payload/mishkan/templates/research-log.schema.json) trigger_baruch=true ;;
    payload/mishkan/scripts/validate-research-log.sh)   trigger_baruch=true ;;
    payload/mishkan/agents/baruch.md)                   trigger_baruch=true ;;
    payload/mishkan/skills/baruch-research-reporting-craft/*) trigger_baruch=true ;;
    payload/mishkan/evals/baruch/*)                     trigger_baruch=true ;;
  esac
done <<< "$changed"

overall=0
if [[ "$trigger_baruch" == "true" ]]; then
  echo "→ Baruch eval (contract surface changed)"
  if bash payload/mishkan/evals/baruch/run.sh; then
    echo "  ✓ Baruch eval passed"
  else
    rc=$?
    echo "  ✗ Baruch eval failed (exit $rc)" >&2
    overall=$rc
  fi
fi

exit "$overall"
