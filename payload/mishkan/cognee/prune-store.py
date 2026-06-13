# MISHKAN — prune a cognee store to empty. Runs INSIDE a cognee-mcp container
# (needs the cognee package + the live .env config). Wipes ALL data AND system
# metadata in that container's graph + vector + relational stores.
#
# Used by reset-knowledge-data.sh to clear cognee-memory (:7777) during a full
# knowledge-data reset to the stable baseline. Mirrors the prune the seed does
# (ingest-curated.py) but standalone — prune only, no re-write.
#
# DESTRUCTIVE and IRREVERSIBLE. Not meant to be run standalone on the host;
# the orchestrator docker-execs it under the engineer's hand.
import asyncio

from cognee import prune


async def main():
    await prune.prune_data()
    await prune.prune_system(metadata=True)
    print(">> PRUNED (data + system metadata)", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
