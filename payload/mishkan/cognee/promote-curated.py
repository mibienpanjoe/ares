# MISHKAN — ADDITIVE promotion of a single resource into the curated library (D-016).
# Runs INSIDE the cognee-curated-mcp container (needs the cognee package + the live
# .env config: graph=Neo4j, vector=pgvector, embeddings=Ollama). Writes ONE typed
# CuratedResource node via Cognee's low-level DataPoint API — NO LLM extraction
# (cognify), so it costs only embedding calls.
#
# This is the engineer-gated growth path for the curated library: a resource a
# research run found reusable, vetted by Shemaiah, queued by Baruch, and approved
# by the engineer via `mishkan knowledge curate`. Invoked by promote-curated.sh;
# not meant to be run standalone on the host.
#
#   Candidate JSON path via COGNEE_CANDIDATE_JSON (default /home/cognee/curated-candidate.json)
#
# CRITICAL — unlike ingest-curated.py (the seed), this NEVER prunes. The seed wipes
# and rewrites for a clean reproducible bootstrap; promotion is additive, so every
# pre-existing curated node MUST survive. Dedup by url is enforced by the caller
# (promote-curated.sh) against the seed manifest + the promoted ledger before this
# script is ever invoked — so reaching here means "write this new node".
import asyncio
import json
import os

from cognee.low_level import setup, DataPoint
from cognee.pipelines import run_tasks, Task
from cognee.tasks.storage import add_data_points
from cognee.tasks.storage.index_graph_edges import index_graph_edges
from cognee.modules.users.methods import get_default_user
from cognee.modules.data.methods import load_or_create_datasets

CANDIDATE = os.environ.get("COGNEE_CANDIDATE_JSON", "/home/cognee/curated-candidate.json")


class CuratedResource(DataPoint):
    name: str
    team: str
    url: str
    problem_class: str
    source_tier: str
    metadata: dict = {"index_fields": ["name", "problem_class"]}


def build_node(_data=None):
    with open(CANDIDATE) as fh:
        d = json.load(fh)
    for required in ("name", "team", "url"):
        if not d.get(required):
            raise SystemExit(f"promote-curated: candidate missing required field '{required}'")
    node = CuratedResource(
        name=d["name"],
        team=d["team"],
        url=d["url"],
        problem_class=d.get("problem_class", ""),
        source_tier=d.get("source_tier", "curated"),
    )
    print(f">> built 1 CuratedResource node: {node.name} ({node.url})", flush=True)
    return [node]


async def main():
    # NO prune — additive. Pre-existing curated nodes must survive.
    await setup()
    user = await get_default_user()
    datasets = await load_or_create_datasets(["curated_library"], [], user)
    tasks = [Task(build_node), Task(add_data_points)]
    async for status in run_tasks(tasks, datasets[0].id, None, user, "curated_promote"):
        print(">> status:", getattr(status, "status", status), flush=True)
    await index_graph_edges()
    print(">> PROMOTED", flush=True)
    # Enrichment follows the build: memify embeds the relationship/triplet layer
    # (default tasks; embeddings-only, no LLM/quota).
    import cognee
    await cognee.memify(dataset="curated_library")
    print(">> MEMIFIED", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
