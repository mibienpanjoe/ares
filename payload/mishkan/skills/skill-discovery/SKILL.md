---
name: skill-discovery
description: Universal skill-discovery layer for the main session. Routes a task to the most relevant installed skills across MISHKAN, the user's ~/.claude/skills, plugin-bundled skills, and project-local skills. Returns three buckets — must_load, should_consider, adjacent — capped at 13 entries total. Advisory only; the model decides what to actually load. Use when a task arrives and you suspect a relevant skill exists but you cannot remember its name, when the surface of installed skills has grown past what fits in working memory, or when /skills is invoked explicitly.
---

# skill-discovery — main-session router

> The harness has dozens of installed skills across four roots. This layer
> answers one question for the main session: *given this task, which skills
> should I be aware of right now?* It does **not** load skills; it surfaces
> them. The loading decision remains with the model.

---

## When to invoke

- A new task arrives and the relevant skill name is not immediately obvious.
- The user types `/skills` (the slash command runs this skill directly).
- A workflow declares `relevant_skill_categories` and asks for skill candidates
  before its first stage runs.
- You catch yourself about to do work you suspect a skill already encodes —
  ask the router before improvising.

**Do not invoke** when the right skill is already named in the request, or
when the work is trivial enough that no skill applies (a one-line edit, a
direct git command, a clear file read).

---

## How to invoke

Run the router script with the task description on `--task` (or piped on
stdin). The router reads the universal index at
`~/.claude/mishkan/skill-discovery/index.json` and emits a 3-bucket JSON.

```
python3 ~/.claude/mishkan/scripts/skill-discovery-router.py \
    --task "<one-paragraph task summary>" \
    [--workflow <workflow-name>] \
    [--relevant-categories cat1,cat2]
```

If the index is missing or stale, run the indexer first (it is also wired to
session-boot via `--stat-only`):

```
python3 ~/.claude/mishkan/scripts/skill-discovery-indexer.py --rebuild
```

---

## Interpreting the three buckets

The router returns three buckets, hard-capped at **13 entries total**:

| Bucket | Cap | Semantics | What you do |
|---|---|---|---|
| `must_load` | ≤ 3 | Score ≥ threshold_high; strong trigger match | Load these into context; treat them as the directly-relevant skills for the task. |
| `should_consider` | ≤ 5 | Mid-band score; partial match | Skim the description; load if the work clearly intersects. Prefer keeping these *as references* over auto-loading them. |
| `adjacent` | ≤ 5 | Low score but same category | Awareness only; mention if relevant; do not load by default. |

**Bias rule.** When the count is tight (e.g. must_load is full but a
should_consider entry looks more relevant than a borderline must_load entry),
prefer enriching should_consider rather than padding must_load. The cost of
loading a wrong skill is higher than the cost of skipping a marginal one.

---

## Trust asymmetry — load only what you trust for the work

Each entry carries an `origin` field: `mishkan`, `user`, `plugin`, `project`.

- `mishkan` entries are harness-authored and trusted by default.
- `user` / `plugin` / `project` entries are third-party and carry a `trust`
  warning in the router output.

**Rule.** Never auto-load a non-MISHKAN skill for a stateful operation
(anything in y4nn-standards §5: `git push`, SSH to production, `docker exec`
on prod, `sudo`, schema migration, log forensics). Surface them; ask the engineer
before loading.

For generative work (boilerplate, doc draft, refactor sketch), non-MISHKAN
skills can be loaded once you've read the description and judged the fit.

---

## Name collisions

The indexer enforces precedence order at index time:
**mishkan → user → plugin → project**. Collisions are recorded in
`index.json.meta.collisions` (a shadowed skill is not silently dropped — it
is logged). If you suspect a collision is shadowing the skill you want, run
`/mishkan-skills-reindex` and inspect `meta.collisions`.

---

## Failure mode — fail-open

If the router returns empty buckets, the request is recorded in
`~/.claude/mishkan/skill-discovery/misses.jsonl` for later tuning. Continue
the task without the discovery layer — the absence of a router result is not
a blocker.

If the index is missing or unreadable, the router returns
`stale_rebuild_needed: true` and `warnings: ["index_missing_or_unreadable"]`.
Run `/mishkan-skills-reindex` and retry.

---

## Phase 1 scope (canary)

This skill is wired in two places only in Phase 1:

1. The `/skills` slash command — invokes the router on the current task.
2. The `mishkan-init` workflow — calls the router in an early phase as an
   advisory hint to Bezalel before doc generation.

Other workflows route through their own craft skills as before. Phase 2 will
broaden integration once the canary has produced enough misses-log signal
to tune thresholds.
