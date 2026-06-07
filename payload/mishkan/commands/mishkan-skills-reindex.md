---
description: Rebuild the universal skill-discovery index by rescanning every installed skill root.
argument-hint: "(no arguments)"
---

Rebuild the universal skill-discovery index.

Run the indexer in manual-rebuild mode:

```bash
python3 ~/.claude/mishkan/scripts/skill-discovery-indexer.py --manual
```

The indexer scans, in precedence order:

1. `~/.claude/mishkan/skills/`        (origin = mishkan)
2. `~/.claude/skills/`                (origin = user)
3. `~/.claude/plugins/*/skills/`      (origin = plugin)
4. `<current-repo>/.claude/skills/`   (origin = project)

It writes `~/.claude/mishkan/skill-discovery/index.json` and prints a summary
of how many entries were indexed and how many name collisions were recorded.

After the rebuild, surface:

- The total count.
- The number of collisions (if non-zero, mention they live in
  `index.json.meta.collisions`).
- Any errors logged to `~/.claude/mishkan/skill-discovery/indexer-errors.jsonl`
  (read the last 5 lines if the file exists).

If the rebuild fails (non-zero exit, parse error), do **not** retry blindly —
surface the error to Y4NN.
