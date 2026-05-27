---
description: Your customizable engineering standards. Inherits the harness defaults (y4nn-standards.md) and OVERRIDES them on any conflict. This file is yours — edit freely; the installer never overwrites it.
alwaysApply: true
---

# Engineer Standards — your layer

This file is **yours to own**. It loads alongside the harness defaults in
`y4nn-standards.md` and takes precedence: **where this file and the defaults
conflict, this file wins.** Where this file is silent, the defaults apply
unchanged.

The installer places this file once and then never touches it — your edits are
safe across harness updates. (The defaults *do* refresh on update, so keep your
changes here, not there.)

## How to use this file

- **Add** standards the defaults don't cover (your stack quirks, team conventions,
  domain rules).
- **Override** a default by restating it your way under the matching heading and
  noting it supersedes the default.
- **Tighten or relax** a default explicitly — e.g. raise a coverage bar, or allow
  a tool the defaults forbid — and say why, so agents apply it with understanding.

Keep the same verbose style as the defaults: state the rule and the reason. An
agent that knows *why* applies the rule correctly in unforeseen cases.

---

## Overrides

<!-- Restate any default you want to change. Example:

### 9. Commit format — override
Use Conventional Commits with a leading gitmoji for this project's team norm.
Supersedes default rule 9 (which forbids emojis) for THIS project only.
Why: the team's release tooling parses gitmoji.

-->

*(none yet — defaults apply in full)*

## Additions

<!-- Standards the defaults don't mention. Examples:

### Testing bar
Business logic requires ≥ 80% line coverage; PRs below the bar do not merge.
Why: <your reason>.

### Preferred libraries
Date handling uses Temporal (not Moment/dayjs). HTTP client is the platform fetch
with a typed wrapper, never axios.
Why: <your reason>.

### Domain rules
<rules specific to your domain — money handling, PII, latency budgets, etc.>

-->

*(add yours here)*

---

*Inherits `y4nn-standards.md`. This file wins on conflict. Yours to maintain.*
