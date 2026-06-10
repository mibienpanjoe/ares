# MISHKAN — cognee-mcp server image (HTTP transport on 7777).
# Builds the official cognee-mcp (topoteretes/cognee · cognee-mcp/) at a PINNED
# git ref. Cognee core is a Python library; cognee-mcp exposes it over MCP.
# Refs: https://docs.cognee.ai/cognee-mcp/mcp-local-setup

ARG PYTHON_VERSION=3.12-slim
FROM python:${PYTHON_VERSION}

# Pin the cognee git tag or commit — build fails if unset (no floating refs).
ARG COGNEE_MCP_REF
RUN test -n "$COGNEE_MCP_REF" || (echo "ERROR: set COGNEE_MCP_REF to a pinned cognee git tag/commit" >&2 && false)

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    COGNEE_PORT=7777

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir uv

# Non-root runtime user (least privilege). Own /app BEFORE the heavy steps and
# run them as `cognee`, so the multi-GB venv is created with correct ownership —
# avoids a final `chown -R /app` that takes 20+ min over the ML dependency tree.
RUN useradd --create-home --uid 10001 cognee \
 && mkdir -p /app && chown cognee:cognee /app
USER cognee
WORKDIR /app

# Clone cognee at the pinned ref and install the MCP server's deps (as cognee).
RUN git clone https://github.com/topoteretes/cognee.git . \
 && git checkout "$COGNEE_MCP_REF"
WORKDIR /app/cognee-mcp

# MISHKAN overlay patch 1/2 — align cognee CORE to the pinned wrapper ref.
# cognee-mcp pins the core LOOSELY against PyPI (>=1.0.0,<2.0.0), so uv sync
# would install a different core version than the checked-out wrapper. That skew
# is what makes the recall patch below collide with the core's own user= pass
# ("authorized_search() got multiple values for keyword argument 'user'"). This
# rewrites the core dep to a `@ file:///app` direct reference so uv builds the
# core from the same checkout. Idempotent + fail-loud. Must run before uv sync.
COPY --chown=cognee:cognee patches/cognee-mcp-core-align.py /app/_mishkan_core_align.py
RUN python /app/_mishkan_core_align.py

# MISHKAN overlay patch 2/2 — cognee-mcp recall()/search() omit `user=` (upstream
# cognee issue #2855, unfixed through v1.1.2), which breaks the read/search path
# with "'NoneType' object has no attribute 'id'". Apply to the checked-out
# source before uv sync. Idempotent + fail-loud: the build fails if the anchor
# call-sites move on a COGNEE_MCP_REF bump, so we never ship a silently-unpatched
# (still-broken) image. Drop this COPY/RUN once a fixed cognee-mcp ref is pinned.
COPY --chown=cognee:cognee patches/cognee-mcp-recall-user.py /app/_mishkan_patch.py
RUN python /app/_mishkan_patch.py

RUN uv sync --all-extras

# Pre-create the persisted-storage root owned by cognee (uid 10001). A named
# volume mounted here inherits this ownership on first creation, so cognee can
# write ingested files/system data without a manual chown. DATA_ROOT_DIRECTORY /
# SYSTEM_ROOT_DIRECTORY (in .env) point under this path so data survives recreate.
RUN mkdir -p /app/cognee-mcp/.cognee_system

EXPOSE 7777

# HTTP transport has no plain GET health endpoint (the /mcp endpoint may 405 on
# GET), so liveness is a TCP connect check on the port.
HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=40s \
  CMD python -c "import socket,sys; s=socket.create_connection(('127.0.0.1',7777),2); s.close()" || exit 1

# HTTP transport, all interfaces, port 7777, endpoint /mcp.
CMD ["uv", "run", "cognee-mcp", "--transport", "http", "--host", "0.0.0.0", "--port", "7777"]
