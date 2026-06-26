#!/usr/bin/env bash
# MISHKAN — idempotently ensure the CURATED box (global singleton) is up + seeded.
# Called by /ares-init. The curated box is shared across ALL projects, so this
# NEVER recreates or reseeds an already-running, already-populated box — it only
# fills what's missing. Safe to run repeatedly.
#
# Does: ensure .env.curated exists (generated from the example, reusing the work
# stack's LLM key + a fresh Neo4j password) -> ensure curated_db -> bring the box
# up if down -> seed only if the curated graph is empty. See decision D-007.
set -euo pipefail

runtime_home() {
  if [[ -n "${ARES_HOME:-}" ]]; then printf '%s' "$ARES_HOME"; return; fi
  if [[ -n "${MISHKAN_HOME:-}" ]]; then printf '%s' "$MISHKAN_HOME"; return; fi
  if [[ -d "$HOME/.ares" || ! -d "$HOME/.claude/mishkan" ]]; then printf '%s' "$HOME/.ares"; return; fi
  printf '%s' "$HOME/.claude/mishkan"
}
ARES_HOME_RES="$(runtime_home)"
COGNEE_DIR="${ARES_HOME_RES}/cognee"
cd "$COGNEE_DIR" || { echo "cognee dir not found: $COGNEE_DIR" >&2; exit 1; }

docker_name_exists() {
  docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$1"
}

prefer_existing_name() {
  local primary="$1" legacy="$2"
  if docker_name_exists "$legacy" && ! docker_name_exists "$primary"; then
    printf '%s' "$legacy"
  else
    printf '%s' "$primary"
  fi
}

COGNEE_PG_CONTAINER="${COGNEE_PG_CONTAINER:-$(prefer_existing_name ares-cognee-pg mishkan-cognee-pg)}"
CURATED_MCP_CONTAINER="${CURATED_MCP_CONTAINER:-$(prefer_existing_name ares-curated-mcp mishkan-curated-mcp)}"
CURATED_NEO4J_CONTAINER="${CURATED_NEO4J_CONTAINER:-$(prefer_existing_name ares-curated-neo4j mishkan-curated-neo4j)}"
if [[ "$COGNEE_PG_CONTAINER" == mishkan-* || "$CURATED_MCP_CONTAINER" == mishkan-* || "$CURATED_NEO4J_CONTAINER" == mishkan-* ]]; then
  COGNEE_WORK_NETWORK="${COGNEE_WORK_NETWORK:-mishkan-cognee_cognee_net}"
  COGNEE_MCP_IMAGE="${COGNEE_MCP_IMAGE:-mishkan/cognee-mcp}"
else
  COGNEE_WORK_NETWORK="${COGNEE_WORK_NETWORK:-ares-cognee_cognee_net}"
  COGNEE_MCP_IMAGE="${COGNEE_MCP_IMAGE:-ares/cognee-mcp}"
fi
export COGNEE_PG_CONTAINER CURATED_MCP_CONTAINER CURATED_NEO4J_CONTAINER COGNEE_WORK_NETWORK COGNEE_MCP_IMAGE

# 0. work stack owns the shared network + Ollama + Postgres — it must be up first.
if ! docker ps --format '{{.Names}}' | grep -qx "$COGNEE_PG_CONTAINER"; then
  echo "work stack not running — bring it up first (docker-compose.yml), then re-run." >&2
  exit 1
fi

# 1. ensure .env.curated (SOPS-manage the real file; this is the bootstrap fallback).
if [ ! -f .env.curated ]; then
  [ -f .env.curated.example ] || { echo ".env.curated.example missing" >&2; exit 1; }
  echo "generating .env.curated (reusing work LLM key; fresh local passwords)..."
  LLMKEY="$(grep '^LLM_API_KEY=' .env | cut -d= -f2-)"
  PGPW="$(grep '^DB_PASSWORD=' .env | cut -d= -f2-)"
  umask 077
  sed -e "s|^LLM_API_KEY=.*|LLM_API_KEY=${LLMKEY}|" \
      -e "s|^GRAPH_DATABASE_PASSWORD=.*|GRAPH_DATABASE_PASSWORD=$(openssl rand -hex 16)|" \
      -e "s|^DB_PASSWORD=.*|DB_PASSWORD=${PGPW}|" \
      -e "s|^DEFAULT_USER_PASSWORD=.*|DEFAULT_USER_PASSWORD=$(openssl rand -hex 20)|" \
      .env.curated.example > .env.curated
  chmod 600 .env.curated
fi

# 2. ensure the isolated curated_db in the shared Postgres.
if ! docker exec "$COGNEE_PG_CONTAINER" psql -U cognee -d cognee_db -tAc \
     "SELECT 1 FROM pg_database WHERE datname='curated_db'" | grep -q 1; then
  docker exec "$COGNEE_PG_CONTAINER" psql -U cognee -d cognee_db -c \
    "CREATE DATABASE curated_db OWNER cognee;"
fi

# 3. bring the curated box up if it's not already running.
if ! docker ps --format '{{.Names}}' | grep -qx "$CURATED_MCP_CONTAINER"; then
  docker compose --env-file .env.curated -f docker-compose.curated.yml up -d
fi

# 4. wait for curated-mcp health (bounded).
echo "waiting for ${CURATED_MCP_CONTAINER}..."
for _ in $(seq 1 40); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$CURATED_MCP_CONTAINER" 2>/dev/null)" = "healthy" ] && break
  sleep 5
done

# 5. seed ONLY if the curated graph is empty (never reseed a populated singleton).
N4PW="$(grep '^GRAPH_DATABASE_PASSWORD=' .env.curated | cut -d= -f2-)"
COUNT="$(docker exec "$CURATED_NEO4J_CONTAINER" cypher-shell -u neo4j -p "$N4PW" --format plain \
         "MATCH (n:CuratedResource) RETURN count(n);" 2>/dev/null | tail -1 | tr -dc '0-9')"
if [ "${COUNT:-0}" = "0" ]; then
  echo "curated graph empty — seeding..."
  "${ARES_HOME_RES}/scripts/seed-curated-library.sh"
else
  echo "curated library already populated (${COUNT} nodes) — leaving as-is."
fi

echo "curated box ready on :${CURATED_MCP_PORT:-7730}"
