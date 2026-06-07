#!/usr/bin/env bash
# MISHKAN PreToolUse — graphify-first advisory (Phase 2: advisory injection).
#
# Per D-009 + amendment 2026-06-07 (MISHKAN_decisions.md):
#
# When a structural Read or Grep fires on a source file, this hook does
# TWO things:
#   1. Emit a hook_fire event on the bus (telemetry preserved from
#      Phase 1; the Knowledge tab keeps its Graphify activity counter).
#   2. Inject an advisory block via hookSpecificOutput.additionalContext
#      suggesting `graphify query` as the cheaper, structurally precise
#      alternative. The hook never blocks; the agent is free to ignore
#      the advisory and proceed with the Read/Grep.
#
# Skill-discovery's PreToolUse skill-routing hook can't be relied on
# alone to push graphify because its router scores skills against the
# initial Task prompt — "implement payment flow" matches
# implementation skills, not "structural-question" skills like
# graphify-query-craft. The runtime nudge here closes that gap: it
# fires at the exact moment the agent is about to do a Read/Grep that
# Graphify could have answered, regardless of what was injected at
# dispatch time.
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
# beyond jq; fail-open everywhere; never blocks a tool call. If the
# project has no graphify-out/ directory, the advisory is suppressed
# (no point recommending a tool the project hasn't initialised).

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

# Emit the telemetry event (Phase 1 contract preserved).
if command -v bus_emit >/dev/null 2>&1; then
  short_target="$(printf '%s' "$target" | cut -c1-120)"
  payload="$(jq -cn --arg t "$short_target" \
    '{hook:"knowledge-route", decision:"ok", phase:2,
      reason:"structural read/grep detected — advisory injected",
      target:$t}' 2>/dev/null)"
  bus_emit "$session" "hook_fire" "$tool" "completed" "$payload"
fi

# Three knowledge stores per D-008 — we mention all three so the agent
# has the full palette instead of a graphify-only push:
#   1. Graphify  — code structure (who calls X, dependencies, paths)
#   2. Cognee work    — project semantic memory (decisions, conventions)
#   3. Cognee curated — cross-project reference library (specs, learnings)
# The agent picks whichever fits its actual question.

project_root="${CLAUDE_PROJECT_DIR:-$PWD}"
graphify_available="no"
[ -d "$project_root/graphify-out" ] && graphify_available="yes"

# Gather objective graph signals so the agent has data, not a verdict.
graph_nodes="?"
graph_edges="?"
graph_age=""
graph_json="$project_root/graphify-out/graph.json"
if [ -f "$graph_json" ]; then
  graph_nodes="$(jq -r '(.nodes // []) | length' "$graph_json" 2>/dev/null || echo '?')"
  graph_edges="$(jq -r '(.links // .edges // []) | length' "$graph_json" 2>/dev/null || echo '?')"
  scan_mtime="$(stat -c '%Y' "$graph_json" 2>/dev/null || stat -f '%m' "$graph_json" 2>/dev/null || echo 0)"
  now_ts="$(date +%s)"
  age_s=$((now_ts - scan_mtime))
  if   [ "$age_s" -lt 3600 ];  then graph_age="$((age_s / 60))min ago"
  elif [ "$age_s" -lt 86400 ]; then graph_age="$((age_s / 3600))h ago"
  else                              graph_age="$((age_s / 86400))d ago"
  fi
  [ "$age_s" -gt 3600 ] && graph_age="$graph_age (stale — \`/code-graph scan\` to refresh)"
fi

# Cognee freshness — use the daemon's poll cache instead of probing
# directly. The cognee_poll source already does HTTP probes every 30s
# and writes the latest node counts to a small cache file. Reading the
# cache stays within the 50ms p95 budget (a probe wouldn't). When the
# cache is missing or stale, we fall back to "?" — the cognee line in
# the palette still appears, the agent just doesn't get the count.
cognee_cache="$HOME/.cache/mishkan/cognee-counts.json"
cognee_work_nodes="?"
cognee_curated_nodes="?"
cognee_freshness=""
if [ -f "$cognee_cache" ]; then
  cognee_work_nodes="$(jq -r '.work.nodes // "?"' "$cognee_cache" 2>/dev/null || echo '?')"
  cognee_curated_nodes="$(jq -r '.curated.nodes // "?"' "$cognee_cache" 2>/dev/null || echo '?')"
  cog_mtime="$(stat -c '%Y' "$cognee_cache" 2>/dev/null || stat -f '%m' "$cognee_cache" 2>/dev/null || echo 0)"
  cog_age_s=$((now_ts - cog_mtime))
  if [ "$cog_age_s" -lt 120 ]; then
    cognee_freshness="cache fresh ($((cog_age_s))s ago)"
  elif [ "$cog_age_s" -lt 3600 ]; then
    cognee_freshness="cache $((cog_age_s / 60))min old"
  else
    cognee_freshness="cache $((cog_age_s / 3600))h old — daemon may be down"
  fi
fi
# Helper formatting for the cognee lines in the palette below.
fmt_cognee_count() {
  case "$1" in
    "?")        echo "(node count unknown)" ;;
    0|"0")      echo "(empty — nothing ingested yet)" ;;
    *)          echo "($1 nodes)" ;;
  esac
}
cog_work_hint="$(fmt_cognee_count "$cognee_work_nodes")"
cog_curated_hint="$(fmt_cognee_count "$cognee_curated_nodes")"

# Build the advisory palette. Includes ALL three stores when each can
# help; per-tool wording so the agent sees a pre-formed command for its
# actual target/pattern (Grep) or topic (Read).
# Per-route token cost hints — concrete numbers so the agent sees the
# trade-off, not just a name. Read scales with file size; graphify and
# cognee are roughly constant per query.
GRAPHIFY_COST_HINT="~1.8k tokens"
COGNEE_COST_HINT="~500 tokens"

case "$tool" in
  Read)
    short="$(basename "$target")"
    file_lines="?"
    read_cost_hint="~? tokens"
    if [ -f "$target" ]; then
      file_lines="$(wc -l < "$target" 2>/dev/null || echo '?')"
      if [ "$file_lines" != "?" ] && [ "$file_lines" -gt 0 ]; then
        read_tokens=$((file_lines * 4))   # ~4 tokens / line of source
        if [ "$read_tokens" -lt 200 ]; then
          read_cost_hint="<200 tokens"
        else
          read_cost_hint="~${read_tokens} tokens"
        fi
      fi
    fi
    if [ "$graphify_available" = "yes" ]; then
      graphify_line="**CODE STRUCTURE** (call graph / dependencies / impact / where used) — \"who calls X\", \"what depends on Y\", \"path between A and B\" → \`graphify query \"<question>\"\` ($GRAPHIFY_COST_HINT). Graph: $graph_nodes nodes / $graph_edges edges, last scan $graph_age."
    else
      graphify_line="**CODE STRUCTURE** → no \`graphify-out/\` in this project (graphify not initialised; run \`graphify update .\` to enable)."
    fi
    advisory="About to Read \`$short\` (~$file_lines lines, $read_cost_hint). MISHKAN has four knowledge surfaces — each answers a different question type (D-008):

- $graphify_line
- **THIS project's MEMORY** — what WE already decided, wrote, resolved (ADRs, runbooks, past sprints, resolved research) → \`mcp__cognee__search\` against the work graph $cog_work_hint ($COGNEE_COST_HINT).
- **CROSS-PROJECT REFERENCE** — what we learned on OTHER projects, ingested specs and standards, shared read-only library → \`mcp__cognee-curated__search\` $cog_curated_hint ($COGNEE_COST_HINT).
- **THIS file's literal content** — actual source / docs / config of \`$short\` → Read is the right tool, $read_cost_hint.

Pick the surface that matches your actual question."
    ;;
  Grep)
    # Verify whether the Grep target is actually a node in the current
    # graph. When yes → graphify is a sure win, we flag it. When no →
    # graphify has nothing on this identifier; don't burn 1.8k on a
    # query whose seed isn't in the graph.
    target_in_graph="unknown"
    if [ "$graphify_available" = "yes" ] && [ -f "$graph_json" ]; then
      # Graphify nodes carry the identifier in `label` (and a normalised
      # form in `norm_label`); `id` is the internal scope-prefixed key
      # ("file_path_segment_identifier") which never matches a bare grep.
      target_in_graph="$(jq -r --arg t "$target" '
        if (.nodes // []) | map((.label // empty), (.norm_label // empty)) | index($t)
        then "yes" else "no" end
      ' "$graph_json" 2>/dev/null || echo unknown)"
    fi
    if [ "$graphify_available" = "yes" ]; then
      case "$target_in_graph" in
        yes) graphify_line="**CODE STRUCTURE** (call graph / dependencies / impact) — who calls $target, what depends on it, path between symbols → \`graphify query \"who calls $target\"\` or \`graphify affected $target --depth 2\` ($GRAPHIFY_COST_HINT each). **\`$target\` IS a node in the graph — graphify will return real callers, including indirect ones Grep misses.** Graph: $graph_nodes nodes / $graph_edges edges, last scan $graph_age." ;;
        no)  graphify_line="**CODE STRUCTURE** → \`$target\` is NOT a node in the current graph ($graph_nodes nodes / $graph_edges edges, last scan $graph_age). Either truly absent (graphify won't help) or the graph is stale (\`/code-graph scan\` to refresh). Don't burn $GRAPHIFY_COST_HINT on a seedless query." ;;
        *)   graphify_line="**CODE STRUCTURE** (call graph / dependencies / impact) — who calls $target, what depends on it → \`graphify query \"who calls $target\"\` or \`graphify affected $target --depth 2\` ($GRAPHIFY_COST_HINT each, catches indirect callers Grep misses). Graph: $graph_nodes nodes / $graph_edges edges, last scan $graph_age." ;;
      esac
    else
      graphify_line="**CODE STRUCTURE** → no \`graphify-out/\` in this project (run \`graphify update .\` to enable; Grep stays valid in the meantime)."
    fi
    advisory="\`Grep $target\` on a bare identifier — MISHKAN has four knowledge surfaces and each answers a different question type (D-008):

- $graphify_line
- **THIS project's MEMORY** — \"why is $target the way it is, who decided it, when, in which sprint\" — our ADRs, runbooks, past research → \`mcp__cognee__search\` with $target as a term $cog_work_hint ($COGNEE_COST_HINT).
- **CROSS-PROJECT REFERENCE** — \"is $target a standard term elsewhere, what does the spec / curated learning say about it\" → \`mcp__cognee-curated__search\` $cog_curated_hint ($COGNEE_COST_HINT).
- **LITERAL text occurrences** — \"every line that contains the exact string \`$target\`, regardless of meaning\" → Grep is the right tool.

Pick the surface that matches your actual question."
    ;;
esac

# Emit hookSpecificOutput.additionalContext via stdout. Claude Code
# prepends this to the tool call context. Never sets permissionDecision
# — this is advisory, not gating.
jq -cn --arg ctx "$advisory" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse", additionalContext:$ctx}}' 2>/dev/null

exit 0
