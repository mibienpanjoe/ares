---
name: sprint-report
description: Assemble a Team Reporter's milestone output. Collects the team's research logs, decisions, task state, security findings, and Cognee writes into a team-report.json conforming to the schema. Used by each Team Reporter at milestone (invoked via the Stop reporter hook).
---

# sprint-report

Assemble a single team's milestone report. Invoked by a Team Reporter
(Maaseiah, Igal, Elasah, Ahikam, Zaccur, Huldah).

## Steps

1. Identify the team and current sprint/milestone from `./CLAUDE.md`.
2. Collect, for this sprint and team:
   - tasks by status (completed / in_progress / blocked)
   - research-log entries (count by outcome: resolved/partial/blocked + library_hits)
   - decisions made (with ADR refs where applicable)
   - security findings (Mishmar; others reference)
   - Cognee writes count
   - flags needing Nehemiah/Bezalel attention
3. Emit `team-report.json` conforming to
   `~/.claude/mishkan/templates/team-report.schema.json`.
4. Surface the report to Nehemiah. Do not surface raw logs — structured summary only.

## Boundaries

Reporters collect and assemble. No decisions, no codebase access, no `/plan`.
Write access limited to the report output and Cognee. English only.
