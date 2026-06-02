#!/usr/bin/env bash
# validate-research-log.sh — enforce the research-log.schema.json contract.
#
# Usage:
#   validate-research-log.sh <path-to-research-log.json>
#
# Exit codes:
#   0  → valid
#   1  → invalid (schema violation or missing required field)
#   2  → environment problem (jq/ajv missing, schema not found, file unreadable)
#
# Why this exists: Baruch is the terminal stage of the research pipeline. Its
# output is the durable record of every research run. A free-text reporter
# eventually drifts — a schema-validated one cannot. This script is the
# enforcement layer around payload/mishkan/templates/research-log.schema.json.

set -euo pipefail

LOG_PATH="${1:-}"
if [[ -z "$LOG_PATH" ]]; then
  echo "usage: $(basename "$0") <path-to-research-log.json>" >&2
  exit 2
fi
if [[ ! -r "$LOG_PATH" ]]; then
  echo "error: cannot read $LOG_PATH" >&2
  exit 2
fi

SCHEMA_CANDIDATES=(
  "${MISHKAN_HOME:-$HOME/.claude/mishkan}/templates/research-log.schema.json"
  "$(dirname "$0")/../templates/research-log.schema.json"
)
SCHEMA_PATH=""
for c in "${SCHEMA_CANDIDATES[@]}"; do
  if [[ -r "$c" ]]; then SCHEMA_PATH="$c"; break; fi
done
if [[ -z "$SCHEMA_PATH" ]]; then
  echo "error: research-log.schema.json not found in any known location" >&2
  printf '  searched: %s\n' "${SCHEMA_CANDIDATES[@]}" >&2
  exit 2
fi

# Layer 1 — JSON well-formedness (fast, always available).
if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 2
fi
if ! jq -e . "$LOG_PATH" >/dev/null 2>&1; then
  echo "invalid: $LOG_PATH is not valid JSON" >&2
  exit 1
fi

# Layer 2 — Required-field check (works without ajv; mirrors schema 'required').
REQUIRED=(agent team sprint trigger query_intent tools_invoked
          research_output_summary applied_to_task outcome
          knowledge_graph_write curated_library_match)
missing=()
for f in "${REQUIRED[@]}"; do
  if ! jq -e --arg k "$f" 'has($k)' "$LOG_PATH" >/dev/null 2>&1; then
    missing+=("$f")
  fi
done
if (( ${#missing[@]} > 0 )); then
  echo "invalid: missing required fields: ${missing[*]}" >&2
  exit 1
fi

# Enum checks (cheap, semantic).
trigger=$(jq -r '.trigger' "$LOG_PATH")
case "$trigger" in
  faced_problem|requested) ;;
  *) echo "invalid: trigger must be one of faced_problem|requested (got '$trigger')" >&2; exit 1 ;;
esac

outcome=$(jq -r '.outcome' "$LOG_PATH")
case "$outcome" in
  resolved|partial|blocked) ;;
  *) echo "invalid: outcome must be one of resolved|partial|blocked (got '$outcome')" >&2; exit 1 ;;
esac

sprint=$(jq -r '.sprint' "$LOG_PATH")
if [[ ! "$sprint" =~ ^S[0-9]+$ ]]; then
  echo "invalid: sprint must match ^S[0-9]+\$ (got '$sprint')" >&2
  exit 1
fi

# Layer 3 — Full JSON Schema validation when ajv is available.
# This catches additionalProperties, type mismatches, and format violations
# that the layer-2 fast checks do not.
if command -v ajv >/dev/null 2>&1; then
  if ! ajv validate -s "$SCHEMA_PATH" -d "$LOG_PATH" --strict=false >/dev/null 2>&1; then
    echo "invalid: schema validation failed (ajv):" >&2
    ajv validate -s "$SCHEMA_PATH" -d "$LOG_PATH" --strict=false >&2 || true
    exit 1
  fi
elif command -v check-jsonschema >/dev/null 2>&1; then
  if ! check-jsonschema --schemafile "$SCHEMA_PATH" "$LOG_PATH" >/dev/null 2>&1; then
    echo "invalid: schema validation failed (check-jsonschema):" >&2
    check-jsonschema --schemafile "$SCHEMA_PATH" "$LOG_PATH" >&2 || true
    exit 1
  fi
else
  # No JSON-Schema validator available; layers 1+2 still ran.
  echo "warn: ajv/check-jsonschema not installed; ran fast checks only" >&2
fi

echo "valid: $LOG_PATH"
exit 0
