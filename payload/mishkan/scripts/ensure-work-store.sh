#!/usr/bin/env bash
# MISHKAN — idempotently ensure a per-project cognee work store is up (D-012).
#
# Mirrors ensure-curated-box.sh. Safe to run repeatedly: does nothing if the
# named container is already healthy. Called by /mishkan-init; prints the chosen
# host port on stdout so the caller can patch .mcp.json.
#
# Usage:
#   ensure-work-store.sh [<project-slug> [<host-port>]]
#
#   project-slug  — identifier for this project's store (default: basename $PWD)
#   host-port     — explicit host port to bind (default: auto-assigned from 7800)
#
# Port assignment (when not provided):
#   Base 7800 + (CRC32-style hash of slug mod 200) → range 7800-7999.
#   The range avoids the shared stores (7777 = work singleton, 7730 = curated).
#   If the computed port is already in use by another process or container, the
#   script scans upward (wrapping within 7800-7999) until a free port is found.
#   The assigned port is printed on stdout; capture it:
#     PORT=$(ensure-work-store.sh wisemoney)
#
# Bring-up command issued (for reference):
#   WORK_PROJECT=<slug> WORK_PORT=<port> COGNEE_MCP_REF=<ref> \
#   docker compose \
#     -f docker-compose.work.yml \
#     -f docker-compose.hardening.yml \
#     -p mishkan-work-<slug> \
#     up -d
#
# Runtime assumptions the engineer must validate on first real bring-up:
#   1. Ollama reachability: mishkan-ollama must be running and joined to
#      mishkan-cognee_cognee_net. If it is down, cognee will fail at cognify
#      time with an embedding error. Ensure the selfhosted stack is up first:
#        docker compose -f docker-compose.selfhosted.yml up -d
#      OR set LLM_PROVIDER + LLM_API_KEY in .env to a cloud embedding provider.
#   2. Embedded store paths: cognee v1.1.0 has NO env binding for the graph file
#      path — it auto-derives under SYSTEM_ROOT_DIRECTORY. The compose sets the
#      data/system roots under the Dockerfile-owned /app/cognee-mcp/.cognee_system
#      (writable by uid 10001) and mounts the per-project volume there. Validate
#      on first bring-up that cognee writes its graph under that path:
#        docker exec <container> find /app/cognee-mcp/.cognee_system -maxdepth 3
#   3. Stale GRAPH_DATABASE_URL in .env: harmless — GRAPH_DATABASE_PROVIDER=
#      ladybug bypasses the URL lookup entirely. No action needed.
#   4. COGNEE_MCP_REF must be set in .env (or exported). The script reads it
#      from .env automatically if not already exported. Same ref used to build
#      the base image. Do NOT change this to a different tag without rebuilding.

set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Resolve paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COGNEE_DIR="${HOME}/.claude/mishkan/cognee"

# /mishkan-init copies payload into ~/.claude/mishkan; run from that location.
# If the script is being tested directly from the repo payload, fall back to
# the sibling cognee directory.
if [ ! -d "$COGNEE_DIR" ]; then
  COGNEE_DIR="$(cd "${SCRIPT_DIR}/../cognee" && pwd)"
fi

cd "$COGNEE_DIR" || { echo "cognee dir not found: $COGNEE_DIR" >&2; exit 1; }

COMPOSE_WORK="${COGNEE_DIR}/docker-compose.work.yml"
COMPOSE_HARDENING="${COGNEE_DIR}/docker-compose.hardening.yml"

[ -f "$COMPOSE_WORK" ]     || { echo "missing: $COMPOSE_WORK" >&2;     exit 1; }
[ -f "$COMPOSE_HARDENING" ] || { echo "missing: $COMPOSE_HARDENING" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Resolve project slug
# ---------------------------------------------------------------------------
WORK_PROJECT="${1:-$(basename "$PWD")}"
# Sanitise: lowercase, replace non-alnum with hyphens, strip leading/trailing hyphens.
WORK_PROJECT="$(printf '%s' "$WORK_PROJECT" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')"
[ -n "$WORK_PROJECT" ] || { echo "project slug is empty after sanitisation" >&2; exit 1; }

CONTAINER_NAME="mishkan-work-${WORK_PROJECT}"
COMPOSE_PROJECT="mishkan-work-${WORK_PROJECT}"

# ---------------------------------------------------------------------------
# 2. Idempotency check — if already healthy, just print port and exit
# ---------------------------------------------------------------------------
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  if [ "$STATUS" = "healthy" ]; then
    # Extract the bound host port from the running container.
    RUNNING_PORT="$(docker inspect -f '{{range $p,$b := .NetworkSettings.Ports}}{{range $b}}{{if $b}}{{$b.HostPort}}{{end}}{{end}}{{end}}' "$CONTAINER_NAME" 2>/dev/null | head -1)"
    echo "work store for '${WORK_PROJECT}' already healthy on :${RUNNING_PORT}" >&2
    printf '%s\n' "$RUNNING_PORT"
    exit 0
  fi
  # Container exists but is not healthy yet — fall through to wait loop.
fi

# ---------------------------------------------------------------------------
# 3. Resolve COGNEE_MCP_REF (from env or .env file)
# ---------------------------------------------------------------------------
if [ -z "${COGNEE_MCP_REF:-}" ]; then
  if [ -f "${COGNEE_DIR}/.env" ]; then
    # shellcheck disable=SC1091
    COGNEE_MCP_REF="$(grep '^COGNEE_MCP_REF=' "${COGNEE_DIR}/.env" | cut -d= -f2- | tr -d '[:space:]' | head -1)"
  fi
fi
[ -n "${COGNEE_MCP_REF:-}" ] || {
  echo "COGNEE_MCP_REF is not set — export it or add it to ${COGNEE_DIR}/.env" >&2
  exit 1
}
export COGNEE_MCP_REF

# ---------------------------------------------------------------------------
# 4. Resolve host port
# ---------------------------------------------------------------------------
PORT_BASE=7800
PORT_RANGE=200  # 7800-7999

if [ -n "${2:-}" ]; then
  # Explicit port supplied by the caller.
  WORK_PORT="$2"
else
  # Deterministic start: hash of slug mod PORT_RANGE, offset from PORT_BASE.
  # Pure bash CRC32 is complex; use a simple additive hash (good enough for
  # a 200-slot range with short slugs):
  #   sum of ASCII values of slug characters mod PORT_RANGE
  _hash=0
  for (( i=0; i<${#WORK_PROJECT}; i++ )); do
    _char="${WORK_PROJECT:$i:1}"
    _hash=$(( _hash + $(printf '%d' "'$_char") ))
  done
  _candidate=$(( PORT_BASE + (_hash % PORT_RANGE) ))

  # Scan upward (wrapping within the range) to find a free port.
  _checked=0
  while true; do
    # Check if already bound by a Docker container (any container, not just ours).
    if ! docker ps --format '{{.Ports}}' | grep -q "127.0.0.1:${_candidate}->"; then
      # Also check for non-Docker processes.
      if ! ss -tlnp 2>/dev/null | grep -q ":${_candidate} " && \
         ! ss -tlnp 2>/dev/null | grep -q ":${_candidate}$"; then
        WORK_PORT="$_candidate"
        break
      fi
    fi
    _checked=$(( _checked + 1 ))
    if [ "$_checked" -ge "$PORT_RANGE" ]; then
      echo "no free port found in range ${PORT_BASE}-$(( PORT_BASE + PORT_RANGE - 1 ))" >&2
      exit 1
    fi
    _candidate=$(( PORT_BASE + ((_candidate - PORT_BASE + 1) % PORT_RANGE) ))
  done
fi

export WORK_PROJECT WORK_PORT

echo "provisioning work store: project='${WORK_PROJECT}' container='${CONTAINER_NAME}' port='${WORK_PORT}'" >&2

# ---------------------------------------------------------------------------
# 5. Bring up (only if container is not already running)
# ---------------------------------------------------------------------------
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  docker compose \
    -f "$COMPOSE_WORK" \
    -f "$COMPOSE_HARDENING" \
    -p "$COMPOSE_PROJECT" \
    up -d || {
      echo "docker compose up failed for project '${WORK_PROJECT}'" >&2
      exit 1
    }
fi

# ---------------------------------------------------------------------------
# 6. Wait for container health (bounded: 40 × 5 s = 200 s max)
# ---------------------------------------------------------------------------
echo "waiting for ${CONTAINER_NAME} to become healthy..." >&2
_attempts=0
while true; do
  _status="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  if [ "$_status" = "healthy" ]; then
    break
  fi
  _attempts=$(( _attempts + 1 ))
  if [ "$_attempts" -ge 40 ]; then
    echo "timed out waiting for ${CONTAINER_NAME} (last status: ${_status:-unknown})" >&2
    echo "check logs with: docker logs ${CONTAINER_NAME}" >&2
    exit 1
  fi
  sleep 5
done

echo "work store '${WORK_PROJECT}' ready on :${WORK_PORT}" >&2

# Print the port on stdout so callers can capture it (e.g. /mishkan-init
# substituting the port into .mcp.json):
#   PORT=$(ensure-work-store.sh <slug>)
printf '%s\n' "$WORK_PORT"
