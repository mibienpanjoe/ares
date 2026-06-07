# 12 — Skill discovery

> Goal: surface the right installed skills for the current task without
> bloating context. Universal indexer + 3-mechanism router + 3-bucket
> output. Advisory — the model decides what to load. Decision: see
> [D-011](../design/MISHKAN_decisions.md#d-011--universal-skill-discovery-layer-added-2026-06-07).

## Why this exists

The harness ships 40+ MISHKAN craft skills, and the user surface adds
dozens more (`~/.claude/skills/`, plugin-bundled, project-local). Two
failure modes compete: silent reinvention (work that a skill already
encodes), and context bloat (loading too many skills "just in case"). The
discovery layer collapses that tension into a single advisory pass.

## What gets installed

| Component | Path | Role |
|---|---|---|
| Indexer | `~/.claude/mishkan/scripts/skill-discovery-indexer.py` | Scans every skill root, writes `index.json` |
| Router | `~/.claude/mishkan/scripts/skill-discovery-router.py` | Reads index, scores skills for a task, emits 3 buckets |
| Skill | `~/.claude/mishkan/skills/skill-discovery/` | Tells the main session how to invoke + interpret |
| `/skills` | `~/.claude/commands/skills.md` | Run the router on the current task |
| `/mishkan-skills-reindex` | `~/.claude/commands/mishkan-skills-reindex.md` | Manual full rebuild |

Output lands at `~/.claude/mishkan/skill-discovery/`:

```
index.json             — universal index, one entry per indexed skill
misses.jsonl           — every empty-result routing (tuning signal)
indexer-errors.jsonl   — per-skill indexer failures
```

## Roots scanned (precedence order)

The indexer scans these roots **in order**. First hit on a name wins;
shadowed entries are recorded in `meta.collisions`, not silently dropped:

1. `~/.claude/mishkan/skills/`  — `origin = mishkan`
2. `~/.claude/skills/`          — `origin = user`
3. `~/.claude/plugins/*/skills/` — `origin = plugin`
4. `<repo>/.claude/skills/`     — `origin = project`

## Indexer commands

```bash
# Full rescan (install/update default)
python3 ~/.claude/mishkan/scripts/skill-discovery-indexer.py --rebuild

# Cheap session-boot sweep (rebuilds only if mtime is newer than last_scan)
python3 ~/.claude/mishkan/scripts/skill-discovery-indexer.py --stat-only

# Manual rebuild (records manual=True in meta)
python3 ~/.claude/mishkan/scripts/skill-discovery-indexer.py --manual
```

## Router usage

The router accepts a task description on `--task` or on stdin, and emits a
3-bucket JSON to stdout:

```bash
python3 ~/.claude/mishkan/scripts/skill-discovery-router.py \
    --task "Refactor the auth module to use JWT with refresh tokens" \
    --relevant-categories security,backend
```

Output shape (abbreviated):

```json
{
  "task_summary": "...",
  "must_load": [
    { "name": "auth-implementation-patterns", "score": 7.2, "origin": "user",
      "category": "security", "trust": "third-party (user); ..." }
  ],
  "should_consider": [ ... ],
  "adjacent": [ ... ],
  "total_returned": 6,
  "warnings": [],
  "stale_rebuild_needed": false
}
```

## The 3 buckets — semantics

| Bucket | Cap | When it fires | What the model does |
|---|---|---|---|
| `must_load` | ≤ 3 | Score ≥ `threshold_high` (default 4.0) and strong trigger match | Load these into context as the directly-relevant skills. |
| `should_consider` | ≤ 5 | Mid-band (≥ `threshold_mid`, < `threshold_high`) | Skim description; load if the work clearly intersects. |
| `adjacent` | ≤ 5 | Low score, same category | Awareness only; mention if helpful; do not load. |

**Hard cap:** 13 total. **Bias rule:** prefer enriching `should_consider`
over padding `must_load` when scores are close — the cost of loading a
wrong skill is higher than the cost of skipping a marginal one.

## Trust asymmetry

Every entry carries an `origin` field. Non-`mishkan` entries (origin =
`user`, `plugin`, or `project`) carry a `trust` warning in the router
output and **must not be auto-loaded for stateful operations** — the
y4nn-standards §5 boundary (git push, SSH to prod, docker exec on prod,
sudo, schema migration, log forensics). For generative work, third-party
skills are fine to load once you've read the description.

## Refresh triggers

| Trigger | Mode | Notes |
|---|---|---|
| Install / update | `--rebuild` | Full rescan; runs once at install time |
| Session boot | `--stat-only` | mtime sweep vs `meta.last_scan`; rebuilds only on change |
| Manual | `--manual` (or `/mishkan-skills-reindex`) | Sets `meta.manual = true` |
| Stale entry at routing time | router drops + warns | `stale_rebuild_needed: true` in output |

## Failure modes — fail-open

Everywhere:

- Indexer error on a single skill → that skill is skipped, error recorded
  to `indexer-errors.jsonl`, index still writes.
- Router error → empty buckets, miss recorded to `misses.jsonl`, exit 0.
- Index missing/unreadable → router returns `stale_rebuild_needed: true`.

The discovery layer never blocks a session. If it fails, the only impact
is that you don't get the advisory pass — you fall back to memory and
explicit naming, which is exactly how the harness worked before D-011.

## Phase 1 scope

Wired in two places only:

1. `/skills` slash command — invoke the router on demand.
2. `mishkan-init` workflow — `SkillRouter` phase runs early; result is
   folded into Bezalel's signoff context as advisory.

Other workflows route through their existing craft skills unchanged.

## Phase 2 — automatic discovery

Phase 2 turns "the router exists" into "agents auto-discover skills
without being asked." Three injection mechanisms ship; the `mishkan-init`
canary above stays in place — Phase 2 adds auto-routing as the dominant
path everywhere else. All three are fail-open and never block.

### Mechanism 1 — install-time rebuild

The npm installer runs the indexer in `--rebuild` mode at the end of
phase 1, so `~/.claude/mishkan/skill-discovery/index.json` is seeded
before any session boots. A missing `python3` or an indexer error logs a
warning and the install continues; recover with
`/mishkan-skills-reindex`.

### Mechanism 2 — SessionStart drift check

`hooks/session-start-skill-index.sh` runs on every session boot and
calls the indexer in `--stat-only` mode. It compares each indexed
SKILL.md mtime against `meta.last_scan` and rebuilds only on drift.

| Property | Value |
|---|---|
| Hook event | `SessionStart` (matcher `""`) |
| p95 budget | 200 ms |
| Worst case | full rebuild — bounded by skill file count |
| Failure mode | exit 0 silently; router surfaces `index_missing_or_unreadable` on next call |

### Mechanism 3 — PreToolUse auto-injection on `Task` / `Agent`

`hooks/pre-tool-task-skill-route.sh` is the load-bearing piece. It:

1. Fires only on `Task` and `Agent` tool calls (matcher `Task|Agent`,
   sharing the same matcher block as `model-route.py`).
2. Reads the Claude Code hook stdin payload, extracts
   `tool_input.prompt`, and trims to 4 KB.
3. Runs the router with `--format injection --max-injection-tokens 600`.
4. Returns the resulting compact markdown block via the documented
   PreToolUse field `hookSpecificOutput.additionalContext` — Claude
   prepends it to the subagent's prompt.
5. Skips injection entirely when the buckets are empty (no
   "no skills found" noise).
6. Emits a `hook_fire` observability event for every fire (decision =
   `allow` with injection, `ok` without).

Hard caps:

- ≤ 3 `must_load` + ≤ 3 `should_consider` entries (Phase 1's `adjacent`
  bucket is dropped at injection time).
- ≤ 600 tokens of prepended markdown (router enforces by trimming
  `should_consider` tail-first).
- Trust marker preserved: non-`mishkan` entries are suffixed with
  `(community)` in the rendered block.

| Property | Value |
|---|---|
| Hook event | `PreToolUse` (matcher `Task\|Agent`) |
| p95 budget | 100 ms |
| Hard timeout | 1.5 s (kills a wedged interpreter; still exits 0) |
| Failure mode | no output, exit 0; Task call proceeds without advisory |

### Injection block shape

```
## Discovered skills (advisory)

**Load now (high relevance):**
- <name>: <one-line description>
- <name>: <one-line description>

**Consider:**
- <name>: <one-line description>

These skills were surfaced by the harness's skill-discovery router. Loading is your call.
```

### Disabling a mechanism per-session

Each mechanism is wired into `~/.claude/settings.json` after install. To
silence one without uninstalling the harness, edit
`settings.json` and remove the matching `hooks` entry:

| Mechanism | Match in settings.json |
|---|---|
| Install-time rebuild | (one-shot at install; nothing to disable runtime) |
| SessionStart drift check | `SessionStart` → command ending in `session-start-skill-index.sh` |
| PreToolUse Task injection | `PreToolUse` matcher `Task\|Agent` → command ending in `pre-tool-task-skill-route.sh` |

Project-local override: drop a `.claude/settings.local.json` in the
project with the same `hooks` event but an empty `hooks` array; Claude
Code merges project settings over user-level ones.

### Misses telemetry — surfacing the signal

Every empty-bucket routing lands in `misses.jsonl`. Aggregate it with:

```bash
python3 ~/.claude/mishkan/scripts/skill-discovery-misses.py --top 10
```

or the slash command `/mishkan-skills-misses`. The report clusters
recurring task patterns by sorted-keyword signature, breaks down by
reason (`no_match_above_threshold`, `index_missing_or_unreadable`,
`router_exception:*`, …), and dates the observation window.

Use it at sprint close to drive the **threshold-tuning process**:

1. Recurring pattern with count ≥ 5 and a clearly-applicable skill? Edit
   the skill's `description` to include the pattern's keywords.
   Description tuning is free; do it before threshold tuning.
2. If patterns still miss after description tuning *and* scores cluster
   just under `must_load`, lower `--threshold-high` from 4.0 to 3.5
   (one 0.5 step, one sprint at a time).
3. If `must_load` over-fires on marginal skills, raise `--threshold-high`
   to 4.5.
4. `router_exception:*` reasons are bugs — escalate to Bezalel, never
   tune around them.

## Troubleshooting

**`index_missing_or_unreadable` warning.**
Run `/mishkan-skills-reindex`. If that fails, inspect
`~/.claude/mishkan/skill-discovery/indexer-errors.jsonl`.

**Buckets all empty for a query that obviously matches a skill.**
The miss is already logged. Two likely causes:
- The skill's `description` does not contain the keywords the task used.
  Tune the description; do not lower the threshold.
- The skill's frontmatter is malformed and the indexer skipped it. Check
  `indexer-errors.jsonl`.

**A skill I expect to win the bucket is being shadowed by a duplicate
name in another root.**
Inspect `index.json.meta.collisions`. Precedence is
mishkan → user → plugin → project. Rename one of the duplicates.

**Indexer keeps rebuilding on every session boot.**
Something is touching a `SKILL.md` mtime. Check the
`meta.last_scan` value in `index.json` and compare to file mtimes under
the four roots; the offender is whatever has the newest mtime that
shouldn't.

## Tuning the thresholds

Defaults: `threshold_high = 4.0`, `threshold_mid = 1.5`. Both are
guesses from Phase 1 scaffolding. Don't tune them until the miss log
shows a stable distribution of scores around the cutoffs across at least
2 sprints — premature tuning chases noise.

Per-invocation overrides:

```bash
python3 ~/.claude/mishkan/scripts/skill-discovery-router.py \
    --task "..." \
    --threshold-high 5.0 \
    --threshold-mid 2.0
```
