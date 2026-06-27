# {{PROJECT_NAME}} — Project State

> Seeded by `/mishkan-init`. This is the lean, dynamic project state artifact.
> It loads after the user-level harness identity and is injected last (after the
> cached static prefix) so sprint state stays at the end of context.

## Project

- **Name:** {{PROJECT_NAME}}
- **Stack:** {{STACK}}
- **Memory backend:** {{MEMORY_BACKEND}}
- **Cognee namespace:** {{COGNEE_NAMESPACE}}
- **Initialised:** {{DATE}}

## Design artifacts (in `docs/`)

- `docs/PRD.md` — product requirements
- `docs/SRS.md` — software requirements
- `docs/CONTRACT.md` — invariants + guarantees
- `docs/ARCHITECTURE.md` — system architecture
- `docs/THREAT_MODEL.md` — security threat model
- `docs/diagrams/C4/` — C4 diagrams
- `docs/adr/` — architecture decision records
- `docs/runbooks/` — operational runbooks

## Current sprint

- **Sprint:** {{SPRINT}}
- **Milestone:** {{MILESTONE}}
- **Mode:** {{MODE}}

### Tasks

<!-- maintained by Nehemiah; conforms to sprint-state.schema.json -->
{{TASKS}}

### Blockers

<!-- raised by any agent; Mishmar flags carry highest priority -->
{{BLOCKERS}}

### Open flags

{{FLAGS}}

---

*Updated at milestones by Nehemiah. Mirrored to Cognee only when Cognee is enabled. Restored by `/mishkan-resume`.*
