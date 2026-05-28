# MISHKAN — structured ingest of the curated library into Cognee.
# Runs INSIDE the cognee-mcp container (it needs the cognee package + the live
# .env config: graph=Neo4j, vector=pgvector, embeddings=Ollama). Reads a JSONL
# of CuratedResource entries and writes typed Team + CuratedResource nodes via
# Cognee's low-level DataPoint API — NO LLM extraction (cognify), so it costs
# only embedding calls. Use local Ollama embeddings to avoid cloud rate walls
# on bulk ingest (Gemini free-tier embeddings 429 on ~100 nodes).
#
# Invoked by seed-curated-library.sh; not meant to be run standalone on the host.
#
#   JSONL path via COGNEE_CURATED_JSONL (default /home/cognee/curated-resources.jsonl)
#
# WARNING: prunes the graph first (clean, reproducible seed). Run before real
# session knowledge accumulates, or it wipes that too.
import asyncio
import json
import os
from typing import List

from cognee.low_level import setup, DataPoint
from cognee.pipelines import run_tasks, Task
from cognee.tasks.storage import add_data_points
from cognee.tasks.storage.index_graph_edges import index_graph_edges
from cognee.modules.users.methods import get_default_user
from cognee.modules.data.methods import load_or_create_datasets
from cognee import prune

JSONL = os.environ.get("COGNEE_CURATED_JSONL", "/home/cognee/curated-resources.jsonl")


class CuratedResource(DataPoint):
    name: str
    team: str
    url: str
    problem_class: str
    source_tier: str
    metadata: dict = {"index_fields": ["name", "problem_class"]}


class Team(DataPoint):
    name: str
    resources: List[CuratedResource]
    metadata: dict = {"index_fields": ["name"]}


def build_nodes(_data=None):
    teams: dict[str, list] = {}
    with open(JSONL) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            teams.setdefault(d["team"], []).append(
                CuratedResource(
                    name=d["name"],
                    team=d["team"],
                    url=d["url"],
                    problem_class=d.get("problem_class", ""),
                    source_tier=d.get("source_tier", "curated"),
                )
            )
    nodes = [Team(name=t, resources=rs) for t, rs in teams.items()]
    print(
        f">> built {len(nodes)} Team nodes, "
        f"{sum(len(t.resources) for t in nodes)} CuratedResource nodes",
        flush=True,
    )
    return nodes


async def main():
    await prune.prune_data()
    await prune.prune_system(metadata=True)
    print(">> pruned", flush=True)
    await setup()
    user = await get_default_user()
    datasets = await load_or_create_datasets(["curated_library"], [], user)
    tasks = [Task(build_nodes), Task(add_data_points)]
    async for status in run_tasks(tasks, datasets[0].id, None, user, "curated_seed"):
        print(">> status:", getattr(status, "status", status), flush=True)
    await index_graph_edges()
    print(">> SEEDED", flush=True)
    # Enrichment always follows the build: memify embeds the relationship/triplet
    # layer into the vector store (default tasks; embeddings-only, no LLM/quota).
    import cognee
    await cognee.memify(dataset="curated_library")
    print(">> MEMIFIED", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
