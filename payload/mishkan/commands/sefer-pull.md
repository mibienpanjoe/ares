---
description: Trigger a Sefer documentation pull outside the milestone (event-driven).
argument-hint: "<event: architecture-decision|security-finding-closed|schema-change> [detail]"
---

Trigger a Sefer documentation pull using the **sefer-pull** skill, Mode B
(triggered pull).

Event: $ARGUMENTS

Jehoshaphat coordinates. Pull only from the team that triggered the event and
update only the affected docs:

- `architecture-decision` → ARCHITECTURE.md + new ADR (Joah, MADR).
- `security-finding-closed` → THREAT_MODEL.md + security posture (Shevna).
- `schema-change` → data docs + migration runbook (Joah).

Sefer writes to `docs/` only — never code. Every doc dated, Diátaxis quadrant
declared, sourced from Cognee/reporters. English only.
