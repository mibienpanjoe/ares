# 05 — Selective ingest

> Goal: explain how documents enter the work cognee graph, and why the default
> is "memory is opt-in, not bulk".

## The contract

**Nothing enters the work graph unless tagged or explicitly invoked.** This is
the harness-wide rule that the `mishkan-ingest` skill enforces. It solves two
real problems hit during the build (commit `6213611`):

- **PII bleed.** Bulk-ingesting `docs/` pulls in incident reports that contain
  real email addresses, internal hostnames, ticket numbers — all of which then
  sit in the project graph alongside curated reference material.
- **Oversized-doc embedding failures.** `nomic-embed-text` rejects chunks
  larger than 8,192 tokens with a 422; one too-large document jams cognify
  retries indefinitely.

Both go away when you choose what enters memory deliberately.

## Two ways to select

### 1. Frontmatter tag (standing intent)

Add a YAML frontmatter block at the very top of a doc:

```yaml
---
mishkan: ingest
---

# Doc title
…
```

That single key is enough. Any other frontmatter (`author`, `date`, etc.)
co-exists fine. The tag means *"this doc is part of the project's persistent
memory"*. The skill default mode walks `./docs/` and ingests every tagged file.

### 2. Explicit paths (ad-hoc pull)

Skip the tag, name the files:

```bash
bash ~/.claude/mishkan/scripts/mishkan-ingest.sh docs/SECURITY.md docs/ROADMAP.md
```

Useful for one-off pulls or when the doc lives outside the standard `docs/`
tree.

## Invoking the skill

```bash
# Default — walk ./docs/ for tagged docs
bash ~/.claude/mishkan/scripts/mishkan-ingest.sh --tagged-only

# Explicit files (no tag required)
bash ~/.claude/mishkan/scripts/mishkan-ingest.sh path/to/a.md path/to/b.md

# Override the dataset name (default is basename of $PWD)
bash ~/.claude/mishkan/scripts/mishkan-ingest.sh --dataset=research docs/research.md

# Show inline help
bash ~/.claude/mishkan/scripts/mishkan-ingest.sh --help
```

## What the skill runs

1. **Selects files.** Tagged-only walks `./docs/` (or any directory you pass)
   and keeps only `.md` files whose YAML frontmatter contains `mishkan: ingest`.
   Explicit paths skip the filter.
2. **Stages** the files into the work cognee-mcp container at
   `/home/cognee/ingest_buf/`.
3. **Runs `cognee.add(files, dataset_name=<project>)`** — registers and chunks
   under the target dataset.
4. **`cognify(datasets=[<project>])`** — LLM extracts entities + relationships.
   Subject to the work box's `LLM_RATE_LIMIT_*` throttle and now-persistent
   storage (commits `70d3c2e` + `e24fabf`).
5. **`memify(dataset=<project>)`** — embeds the triplet layer into pgvector
   (commit `210f92b` made this automatic after every cognify).

Output marks each step: `>> added N file(s) -> <dataset>`, `>> cognified`,
`>> memified`.

## Naming the target dataset

By default the dataset is named after the project directory:

```bash
cd ~/code/aiobi-mail
bash ~/.claude/mishkan/scripts/mishkan-ingest.sh --tagged-only
# → ingests into dataset "aiobi-mail" in the work store
```

Override with `--dataset=<name>` when:

- You want a sub-corpus of the project (`--dataset=architecture-only`).
- The basename collides with another project (rename one).
- You want to ingest into a personal dataset (e.g. `--dataset=research`).

The skill **never** writes to `cognee-curated`. The curated store is read-only
in normal use; only the harness's `seed-curated-library.sh` writes to it, and
that targets `mishkan-curated-mcp` explicitly.

## A worked example

Tag two docs and leave the rest untouched:

```bash
cd ~/code/aiobi-mail

# tag SECURITY.md and ROADMAP.md
for f in docs/SECURITY.md docs/ROADMAP.md; do
  if ! head -1 "$f" | grep -qx '---'; then
    printf '%s\n%s\n%s\n\n' '---' 'mishkan: ingest' '---' | cat - "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  fi
done

# run the skill
bash ~/.claude/mishkan/scripts/mishkan-ingest.sh --tagged-only

# verify in the graph
docker exec mishkan-cognee-pg psql -U cognee -d cognee_db -tc \
  "SELECT d.name, count(dd.data_id) AS items
   FROM datasets d LEFT JOIN dataset_data dd ON dd.dataset_id=d.id
   WHERE d.name='aiobi-mail' GROUP BY d.name;"
```

The other docs in `docs/` (the 79KB migration report, French PDFs, stale
upstream READMEs) stay out of the graph. Re-running the skill picks up newly
tagged files only; previously-cognified docs are skipped via cognee's pipeline
status.

## Re-ingesting after a doc changes

The skill is additive. To refresh a doc that's already been cognified:

1. Edit the doc.
2. Mark its existing dataset entry as needing reprocessing (cognee tracks
   per-data-item pipeline status). If a clean reset is wanted:
   ```python
   # one-shot, run inside the work mcp container
   import asyncio, cognee
   from cognee.modules.users.methods import get_default_user
   from cognee.modules.data.methods import get_datasets, delete_dataset
   async def m():
       u = await get_default_user()
       for d in await get_datasets(u.id):
           if d.name == "<project>": await delete_dataset(d)
   asyncio.run(m())
   ```
3. Rerun `mishkan-ingest.sh --tagged-only`.

That removes the relational dataset records cleanly. Note: with cognee access
control off, deleting a dataset does **not** remove the graph nodes — for a
true reset, also drop the graph labels for that dataset. See
[Troubleshooting](./07-troubleshooting.md) for the cleanup pattern used during
the build.

## What the skill is *not*

- Not a sync. It does not detect deletions or watch the filesystem.
- Not a translator. Non-markdown files are skipped in directory walks.
- Not a curation tool for the **curated** store. Curated is a separate seed
  flow (`seed-curated-library.sh` against the curated MCP).
- Not an autonomous "cognee always knows everything" mechanism. The whole
  point is *deliberate* memory.

## See also

- The skill itself: `payload/mishkan/skills/mishkan-ingest/SKILL.md`.
- The script: `payload/mishkan/scripts/mishkan-ingest.sh`.
- Commit `6213611` (introduction).
- Memory layer architecture: [04](./04-memory-layer.md).
- Provider profiles (cognify uses the LLM): [06](./06-llm-providers.md).
- If cognify errors on the last doc:
  [Troubleshooting](./07-troubleshooting.md#cognify-stuck-on-the-last-doc).
