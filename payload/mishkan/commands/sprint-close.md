---
description: Close the current sprint — reporters surface, Nehemiah aggregates, Bezalel reviews, Sefer pulls, memory promotion, next sprint begins.
---

Close the current sprint milestone. First **produce a `/plan`** of what will be
closed, what should be promoted to memory/docs, and whether Cognee is enabled for
this project. Surface the plan to Y4NN for approval.
Then run:

1. Each **Team Reporter** surfaces its `team-report.json` (Maaseiah, Igal,
   Elasah, Ahikam, Zaccur, Huldah) — via the **sprint-report** skill.
2. **Nehemiah** aggregates all six team reports.
3. **Bezalel** reviews architectural and security flags.
4. **Sefer** runs a sequential pull (**sefer-pull** skill, Mode A) — changelogs,
   ADRs, API docs, runbooks, team docs updated in `docs/`.
5. Resolved research + decisions promoted by blast radius. In native mode, update
   `CLAUDE.md` / `AGENTS.md` / `docs/` and rely on runtime memory. In
   `cognee`/`hybrid` mode, use the **cognee-promote** skill to write the Cognee
   project graph — gated by Nehemiah + Bezalel.
6. Observability aggregation runs (`bash {{MISHKAN}}/scripts/observability-aggregate.sh`)
   to produce per-tool and per-outcome counts plus per-session activity from
   `logs/*.jsonl`. Improvement-layer queries refresh from the produced summary.
7. Update `./CLAUDE.md` to the next sprint (S+1) and reset milestone.

Stateful operations stop at Y4NN's hands. Reporters surface structured summaries
only. English only.
