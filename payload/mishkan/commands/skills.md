---
description: Surface the most relevant installed skills for the current task (advisory; you decide what to load).
argument-hint: "[optional task description; defaults to the current message context]"
---

Run the **skill-discovery** layer against the current task.

Task (from arguments, fall back to the active message): $ARGUMENTS

Steps:

1. If a task description was passed as `$ARGUMENTS`, use it verbatim.
   Otherwise, write a one-paragraph summary of what the user is trying to
   do right now.
2. Invoke the router:
   ```bash
   python3 ~/.claude/mishkan/scripts/skill-discovery-router.py \
       --task "<task summary>"
   ```
3. Parse the JSON response. Surface the three buckets to the user with this
   shape:
   - **must_load** — name, one-line description, origin tag
   - **should_consider** — name, one-line description, origin tag
   - **adjacent** — name only (cheaper context)
4. If `stale_rebuild_needed: true`, tell the user to run
   `/mishkan-skills-reindex`.
5. If buckets are all empty, surface that fact — the miss is already logged
   to `~/.claude/mishkan/skill-discovery/misses.jsonl` for tuning.
6. **Do not auto-load** any non-`mishkan` skill for a stateful operation;
   ask the engineer first. Generative work may be loaded after reading the skill's
   description.

This command is advisory. The actual loading decision stays with the model
and with the engineer. Apply the skill-discovery skill (`~/.claude/mishkan/skills/skill-discovery/`)
for interpretation rules.
