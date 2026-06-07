---
description: Aggregate the skill-discovery miss log into a tuning report (top patterns + reasons + window).
argument-hint: "[--top N]"
---

Surface the skill-discovery miss-log signal so we know which skills need
better triggers and whether the thresholds are tuned to the actual score
distribution.

Run the aggregator:

```bash
python3 ~/.claude/mishkan/scripts/skill-discovery-misses.py --top 10
```

The report covers:

- **Total misses** in the log and the observation window.
- **By reason** — `no_match_above_threshold` (router ran, scores too low),
  `index_missing_or_unreadable` (indexer hasn't run), `no_live_entries`
  (every entry's source_path is dead), `router_exception:*` (bug).
- **Top N patterns** — task signatures that produced empty buckets,
  grouped by their sorted unique keywords so the same shape clusters.
  Each pattern carries a count, last_seen, and an example task.

Two tuning levers, in order:

1. **Description tuning** (preferred). If the same pattern shows up in the
   top-N and a skill clearly *should* have caught it, enrich that skill's
   `description` so the keywords used in the task hit. This is the
   D-011 §"Phase 1 → Phase 2 path" rule: tune descriptions before
   threshold (description fixes are free; threshold changes affect every
   future routing).
2. **Threshold tuning** (only after 2 sprints of stable distribution).
   Lower `--threshold-high` if real matches are being demoted to
   `should_consider`; raise it if `must_load` is over-firing on
   marginally-relevant skills.

Surface the report verbatim, then call out:

- Any pattern with count ≥ 5 — that's a recurring miss worth a description
  edit.
- A miss rate (`total / sessions-since-first-seen`) over ~10% — the index
  or trigger surface is the wrong shape for the workload.
- `router_exception:*` reasons — those are bugs; escalate to Bezalel.

If the miss log is empty, say so — that is success, not nothing-to-report.
