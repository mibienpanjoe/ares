---
name: sefer-pull
description: Run a Sefer documentation pull. Two modes — sequential pull at every sprint milestone (after all Team Reporters surface), and triggered pull on high-blast-radius events (major architecture decision, critical security finding closed, schema change). Reads Cognee + reporter outputs, writes to docs/ only.
---

# sefer-pull

Drive a Sefer documentation pull. Sefer is pull-based: it never writes code, only
`docs/`. It reads from Cognee and Team Reporter outputs.

## Mode A — sequential pull (at milestone)

Fires at every sprint milestone after all Team Reporters have surfaced.

1. Jehoshaphat coordinates. Pull all reporter outputs + relevant Cognee nodes.
2. **Joah** updates project-layer docs: changelog (Keep a Changelog), ADRs
   (MADR) for decisions made this sprint, API docs (from OpenAPI), runbook revisions.
3. **Shevna** updates team-layer docs: component library, security posture, infra
   topology, per-team outputs.
4. **Seraiah** updates org-layer docs if cross-project standards changed.
5. **Jehonathan** publishes the human-readable docs from the graph.
6. **Huldah** assembles the Sefer team-report.

## Mode B — triggered pull (event-driven, no waiting for milestone)

Fires immediately on a high-blast-radius event:
- major architecture decision by Bezalel/Nathan → update ARCHITECTURE + ADR
- critical security finding closed by Phinehas → update THREAT_MODEL + security posture
- schema change by Shallum → update data docs + migration runbook

Pull only from the team that triggered it; update only the affected docs.

## Constraints

Writes to `docs/` only — never code. Every doc dated, Diátaxis quadrant declared,
sourced from Cognee/reporters (no fabrication). Stateful operations hard stop.
English only.
