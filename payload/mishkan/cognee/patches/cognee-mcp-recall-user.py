#!/usr/bin/env python3
"""MISHKAN overlay patch for cognee-mcp (v1.1.0 .. v1.1.2).

Upstream defect (cognee issue #2855): CogneeClient.recall() and .search() in
direct/local mode call cognee.recall()/cognee.search() WITHOUT a `user=`
argument, so the core resolves the user itself and — under several conditions
(notably a Neo4j graph backend, where the non-ACL search branch runs) — the
read path dereferences `.id` on a None and raises:

    'NoneType' object has no attribute 'id'

The WRITE path works because add()/cognify()/remember() initialise the user and
datasets; only the READ path is broken. The sibling methods delete() and
list_datasets() already do `user = await get_default_user()` and pass it — this
patch makes recall()/search() do the same, mirroring that exact pattern.

Properties:
  - idempotent: re-running is a no-op (marker `_mishkan_gdu`).
  - fail-loud: if the two anchor call-sites are not found (e.g. a cognee-mcp
    upgrade moved or fixed them), exits non-zero so the build fails loudly
    instead of silently shipping an unpatched (still-broken) image.
  - indentation-safe: the injected lines copy the anchor line's own indent.

Drop this patch (and its Dockerfile COPY/RUN) once a cognee-mcp release lands
the fix upstream and COGNEE_MCP_REF is bumped to it.
"""
from __future__ import annotations

import pathlib
import sys

TARGET = pathlib.Path("/app/cognee-mcp/src/cognee_client.py")
MARKER = "_mishkan_gdu"
IMPORT = "from cognee.modules.users.methods import get_default_user as _mishkan_gdu"

# (anchor line — matched after lstrip; kwargs-dict the call splats)
EDITS = [
    ("return await self.cognee.recall(query_text=query_text, **kwargs)", "kwargs"),
    ("results = await self.cognee.search(**search_kwargs)", "search_kwargs"),
]


def main() -> int:
    if not TARGET.is_file():
        print(f"MISHKAN ERROR: {TARGET} not found", file=sys.stderr)
        return 1

    src = TARGET.read_text()
    if MARKER in src:
        print("MISHKAN: cognee-mcp recall/search user= patch already applied; skipping")
        return 0

    out: list[str] = []
    applied = 0
    for line in src.splitlines(keepends=True):
        stripped = line.lstrip()
        indent = line[: len(line) - len(stripped)]
        hit = next((kw for anchor, kw in EDITS if stripped.startswith(anchor)), None)
        if hit is not None:
            out.append(f"{indent}{IMPORT}\n")
            out.append(f'{indent}{hit}["user"] = await _mishkan_gdu()\n')
            out.append(line)
            applied += 1
        else:
            out.append(line)

    if applied != len(EDITS):
        print(
            f"MISHKAN ERROR: expected {len(EDITS)} patch site(s), found {applied}. "
            "cognee-mcp source changed — review payload/mishkan/cognee/patches/"
            "cognee-mcp-recall-user.py against the pinned COGNEE_MCP_REF.",
            file=sys.stderr,
        )
        return 1

    TARGET.write_text("".join(out))
    print(f"MISHKAN: cognee-mcp recall/search user= patch applied ({applied} sites)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
