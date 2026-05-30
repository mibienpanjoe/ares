---
name: mishkan-ingest
description: Selectively ingest specific documents into the project's cognee work store. Use to deliberately add docs to memory instead of bulk-ingesting a whole tree — the default is "nothing enters memory unless tagged or invoked", which prevents PII bleed (e.g. real addresses in incident reports) and oversized-doc embedding failures. Walks ./docs/ filtered by a `mishkan: ingest` YAML frontmatter tag, or accepts explicit paths. Always runs cognify → memify after adding.
---

# mishkan-ingest

Deliberate, selective entry into the project's **work** cognee store (`cognee`,
:7777). Pairs with the cross-project **curated** store (`cognee-curated`, :7730,
read-only) — this skill only touches work.

## When to use

- Adding a freshly tagged doc to project memory.
- Refreshing memory after a doc materially changed.
- One-off pulls from outside the standard `docs/` tree.

## Usage

```bash
# Default: walk ./docs/ for docs tagged `mishkan: ingest`
bash ~/.claude/mishkan/scripts/mishkan-ingest.sh --tagged-only

# Explicit files (no tag check)
bash ~/.claude/mishkan/scripts/mishkan-ingest.sh docs/SECURITY.md docs/ROADMAP.md

# Different dataset (default: basename of cwd)
bash ~/.claude/mishkan/scripts/mishkan-ingest.sh --dataset=research docs/research.md
```

## Tagging a doc as memory-eligible

Put a YAML frontmatter block at the top of the file:

```yaml
---
mishkan: ingest
---

# Doc title
…
```

That single tag is enough. Optional: any other frontmatter (author, date, etc.)
stays as-is.

## What the skill runs

1. Selects files — tagged-only filter, or the explicit list you passed.
2. Stages them into the work cognee-mcp container.
3. Runs `cognee.add(files, dataset_name=<project>)` → `cognify` → `memify` —
   extraction *then* enrichment, always paired (decision per the harness flow).
4. Respects the work box's LLM rate-limit throttle and persistent storage.

## Constraints

- Never writes to `cognee-curated` (that's the cross-project reference, read-only).
- Skips non-`.md` files in directory walks (extend the script if you need others).
- One doc per `--dataset` per run is fine; rerun for additional datasets.
- Does NOT delete existing data — additive. Use `cognee.prune` if you need a reset.

## Default behaviour (zero args)

Walks `./docs/` looking for `mishkan: ingest` tags. If none, exits cleanly with
"no docs selected" — the deliberate default: **memory is opt-in, not bulk**.
