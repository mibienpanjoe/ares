#!/usr/bin/env python3
"""MISHKAN overlay patch — align cognee CORE to the pinned cognee-mcp ref.

The Dockerfile clones the cognee monorepo at COGNEE_MCP_REF (e.g. v1.1.0) and
runs `uv sync` inside `cognee-mcp/`. But cognee-mcp's pyproject pins the core
LOOSELY against PyPI:

    "cognee[postgres-binary,docs,neo4j]>=1.0.0,<2.0.0"

so `uv sync` installs the core from PyPI at whatever the latest 1.x happens to
be — a DIFFERENT version than the checked-out wrapper. That skew is what breaks
the read path even after the recall/search `user=` patch (cognee-mcp-recall-
user.py): the v1.1.0 core's recall() forwards `user=` exactly once, but the
drifting PyPI core's recall() passes it both positionally and as a keyword, so
the wrapper's injected `user=` collides:

    authorized_search() got multiple values for keyword argument 'user'

The fix: resolve the core from the LOCAL checkout (`/app`, the monorepo root,
which is a PEP-517 `cognee` package built by hatchling) via a PEP 508 direct
reference. Then wrapper + core + their transitive deps are all the same ref, and
the recall patch — written against that ref — works end to end. This is exactly
the mechanism the upstream dev left commented out (a `@ file:` direct ref),
generalised off their hard-coded local path to the in-container clone.

Properties (mirrors cognee-mcp-recall-user.py):
  - idempotent: re-running is a no-op (marker = the rewritten dep string).
  - fail-loud: if the loose-pin anchor is not found (a COGNEE_MCP_REF bump moved
    or already fixed it), exits non-zero so the build fails instead of silently
    shipping a still-skewed image.

Drop this patch (and its Dockerfile COPY/RUN) once cognee-mcp pins its core
tightly to the wrapper ref upstream and COGNEE_MCP_REF is bumped to it.
"""
from __future__ import annotations

import pathlib
import sys

TARGET = pathlib.Path("/app/cognee-mcp/pyproject.toml")
OLD = '"cognee[postgres-binary,docs,neo4j]>=1.0.0,<2.0.0"'
NEW = '"cognee[postgres-binary,docs,neo4j] @ file:///app"'


def main() -> int:
    if not TARGET.is_file():
        print(f"MISHKAN ERROR: {TARGET} not found", file=sys.stderr)
        return 1

    src = TARGET.read_text()
    if NEW in src:
        print("MISHKAN: cognee core already aligned to /app checkout; skipping")
        return 0

    count = src.count(OLD)
    if count != 1:
        print(
            f"MISHKAN ERROR: expected exactly 1 core-dep anchor, found {count}. "
            "cognee-mcp/pyproject.toml changed its core pin — review "
            "payload/mishkan/cognee/patches/cognee-mcp-core-align.py against the "
            "pinned COGNEE_MCP_REF.",
            file=sys.stderr,
        )
        return 1

    TARGET.write_text(src.replace(OLD, NEW))
    print("MISHKAN: cognee core pinned to /app checkout (file:///app)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
