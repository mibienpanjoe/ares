# Changelog

All notable changes to MISHKAN are documented here. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Workflows tab crash on `DuplicateIds`** — `_render_list` called `lv.clear()` without awaiting the returned `AwaitRemove`, so the Textual DOM still held old items when `set_timer(0.1)` re-fired during mount. Made `_render_list` async with proper `await`, and `on_mount`/`apply_snapshot`/`apply_event` all coordinate through the async path or `call_later`.

- **State tests stale after phantom-session gate** — four `test_state.py` assertions sent events without a preceding `session_start`, which the `_confirmed_alive` gate (de77c0c) now requires. Prefixed each with `session_start`.

### Added

- **Knowledge-route advisory hook (D-009 amendment 2026-06-07 — Phase 2
  shipped).** `hooks/pre-tool-knowledge-route.sh` (renamed from
  `pre-tool-graphify-advisory.sh` since the scope is now all four
  knowledge surfaces, not just graphify). Fires on structural Read or
  bare-identifier Grep; injects a palette listing every surface
  MISHKAN exposes (Graphify code structure · Cognee work project
  memory · Cognee curated cross-project reference · Read/Grep literal
  content) with pre-formed commands tailored to the actual target.
  Carries real signals — graph node/edge count, last-scan staleness,
  per-route token cost estimate, a `jq` check that says whether the
  Grep target is actually a node in the current graph (so the agent
  doesn't burn ~1.8k tokens on a seedless query), and cognee work +
  curated node counts from the daemon's poll cache. Advisory-only —
  never sets `permissionDecision`. Fail-open. ≤ 50 ms p95.

- **D-009 scope amendment — 20 code-touching dev agents** carry
  `graphify-query-craft` (was 5). Yasad backend (Hizkiah, Nathan,
  Zadok, Shallum, Uriah) · Panim frontend (Salma, Oholiab, Asaph,
  Jahaziel) · Chosheb UI (Hiram) · Mishmar code-security (Ira, Joab,
  Hushai) · Migdal infra-code (Palal, Meshullam, Meremoth, Hanun) ·
  Sefer code-documentation (Joah, Shevna, Jehonathan). Reviewers and
  documentation specialists benefit from the call graph as much as
  writers; the original five-only scope read narrower than the
  benefit space.

- **`npx mishkan-harness code-graph [status|open|scan]`** CLI
  subcommand for inspecting the code-graph of the current project.
  Reads `graphify-out/graph.json` to print node/edge counts and last
  scan timestamp (`status`), opens `graph.html` in the browser
  (`open`), or runs `graphify update .` (`scan`). Mirrored as the
  `/code-graph` slash command so it's reachable from any Claude Code
  session.

- **Skill discovery Phase 2 (D-011 amendment 2026-06-07).** Three
  injection mechanisms turn the Phase 1 router into auto-discovery:
  (a) install-time `--rebuild` seeds the index from `bin/mishkan.js`;
  (b) `hooks/session-start-skill-index.sh` runs the indexer in
  `--stat-only` mode on every SessionStart (200 ms p95, rebuilds only on
  mtime drift); (c) `hooks/pre-tool-task-skill-route.sh` fires on every
  `Task` / `Agent` call and prepends a compact ≤ 600-token markdown
  advisory via `hookSpecificOutput.additionalContext`. Router gains
  `--format injection` mode (caps: 3 must_load + 3 should_consider,
  adjacent dropped). New `scripts/skill-discovery-misses.py` aggregator
  + `/mishkan-skills-misses` slash command surface miss-log signal for
  threshold tuning at sprint close. Trust marker preserved: non-`mishkan`
  entries are tagged `(community)` in the injection block. Fail-open
  end-to-end — every hook exits 0 on any error and never blocks the
  Task call. The `mishkan-init` Phase 1 canary is unchanged.

## [0.2.1] — 2026-06-07

The "discoverability + durability" release. Everything we'd promised becomes
findable at runtime; the observability stack stops hallucinating sessions on
restart; Graphify ships end-to-end and pays for itself in tokens; the workflow
portfolio doubles under a written governance contract.

### Added

- **Workflow portfolio expansion (ADR D-010).** 3 new org-level workflows
  (`mishkan-blast-radius`, `mishkan-knowledge-gap-discovery`,
  `mishkan-standards-rollout`) and 8 team-level workflows
  (`chosheb-feature-ship`, `panim-ds-rollout`, `yasad-data-migration-wave`,
  `yasad-schema-evolution`, `mishmar-security-gate`, `migdal-infra-change`,
  `migdal-dr-drill`, `sefer-release-notes`). Hard caps now 10 org-level + 4
  per team. Four named anti-patterns codified. PM+CTO co-ownership made
  explicit; soft-retirement under 2 fires across 3 sprints.

- **Org reference (D-006 amendment).** `npx mishkan-harness org [--json]` CLI,
  `/mishkan-org-reference` slash command, and a new TUI **Org-Ref** tab
  (key `6`) browsing the 45-agent org with mission, charter, Hebrew name,
  and Bible-source citation per agent and team. Single source of truth:
  `payload/mishkan/org/org.json`.

- **Graphify integration (D-008 verified, D-009 shipped).** Watchd source
  `graphify_tail` emits `graphify_scan` / `graphify_query` events; advisory
  PreToolUse nudge for the five code-writing specialists
  (`pre-tool-knowledge-route.sh`); craft skill `graphify-query-craft`;
  documentation `docs/usage/11-graphify.md`. Verified token reduction:
  88.1× on the MISHKAN harness corpus (was claimed 71.5×).

- **Skill discovery layer (ADR D-011).** Universal indexer + 3-mechanism
  router (trigger phrase, category prior, TF-IDF fallback) + 3-bucket
  output (`must_load` / `should_consider` / `adjacent`, hard cap 13).
  `/skills` and `/mishkan-skills-reindex` slash commands. Phase 1 canary
  wired into `mishkan-init` workflow. 196 skills indexable across the four
  sources (MISHKAN craft / community / plugin / project-local).

- **TUI observability additions.**
  - **Usage Overview** tab (key `7`) — harness-wide tokens / cost / context
    window estimate / per-session breakdown with per-agent token attribution.
  - **Skills** tab (key `8`) — every installed skill grouped by origin and
    category, cross-referenced to the ADRs that mention it.
  - **Workflow catalogue** in the Workflows tab — parses each script's
    `meta` block to surface description and `whenToUse` for the 18
    installed workflows (closes the "documented but invisible" gap on the
    17 dormant workflows the audit surfaced).
  - **Project filter** (`p` key) — toggles between current-project-only and
    all-projects view on Live's ACTIVE and WORKTREES panels.
  - **Inline role annotation** — `alias · role` next to each agent in Live
    and Agents tabs (loaded from `org.json`).
  - **Graphify card** added to Knowledge tab next to work + curated Cognee.
  - **CTO decisions cross-reference** — every skill surfaces which ADRs
    mention it (e.g. `mishkan-init → D-003, D-010`).

- **Eval baruch wired (closes a latent orphan).** GitHub Actions workflow
  `.github/workflows/eval-baruch.yml` runs the contract eval on every PR
  touching the schema / validator / agent prompt / craft skill / eval. New
  `/eval-baruch` slash command. Optional `pre-commit-eval-gate.sh` for
  local pre-commit invocation. Eval discoverable from `agents/baruch.md`.

### Changed

- **Documentation alignment** — README, `docs/usage/README.md`,
  `docs/usage/10-observability.md`, `docs/design/MISHKAN_observability.md`,
  `payload/mishkan/workflows/README.md` all reflect the new shape: 8 TUI
  tabs (was 5), 18 workflows (was 7), ADRs through D-011.

- **`sprint-close.md` step 6** now spells out the
  `observability-aggregate.sh` invocation it was conceptually relying on
  (was a textual hint that left the script as an unreferenced orphan).

- **Dynamic Context Injection marker** — corrected the misleading HTML
  comment in all 45 agent files plus `AGENT_SPEC.md`. The marker is a
  cacheable-prefix boundary and a reader-orientation aid; it is NOT a
  runtime injection mechanism. `./CLAUDE.md` is loaded by Claude Code's
  normal session-context propagation, not spliced at this point.

- **npm release pipeline split.** `.github/workflows/npm-publish.yml`
  triggers on `release: published` (not tag push) and verifies version;
  `.github/workflows/release-draft.yml` creates a draft GitHub Release on
  tag push so a human review precedes the npm publish.

### Fixed

- **Phantom session resurrection** — bus_tail no longer replays historical
  hook events on daemon start (seeks to EOF). The daemon's
  `_confirmed_alive` gate makes `session_discover` the sole authority on
  alive sessions; events for unknown sids buffer 15 s pending confirmation
  then drop. Stopped sids land in a 256-entry tombstone ring so lagging
  events can't resurrect them.

- **Cognee + Graphify state not propagated to TUI cards** — `apply_event`
  in Knowledge and Live tabs never mutated `_state["cognee"]` /
  `_state["graphify"]` from probe events, so cards stayed at zero even
  while the daemon emitted healthy probes every 30 s. Now mutated +
  re-rendered on each event.

- **Knowledge tab Graphify card invisible** — `.cognee-card` was hardcoded
  to `width: 50%`, which silently clipped the third (graphify) card off
  the layout. Now `width: 1fr` so all three cards share equally.

- **Encoded project paths broke worktree + graphify discovery** —
  `_project_paths_provider` returned the Claude Code encoded form
  (`-home-ogu-theY4NN-harness`) to consumers that needed an absolute path
  to call `Path.is_dir()`. Now decoded once in the shared provider so
  `worktree_poll` and `graphify_tail` actually open the projects.

- **Worktree storm of phantom removes** — `worktree_poll` emitted `remove`
  for every known worktree whenever the project list temporarily dropped
  (e.g. before `session_discover`'s first confirmation). Now stamps each
  known worktree with its owning project and only emits `remove` when the
  owner was actually polled this round.

- **Recent ops table columns were lying** — Knowledge tab's `ms` column
  showed event-type-specific metrics that weren't milliseconds; `query/path`
  was empty for events that don't carry those fields. Renamed to
  `detail` + `metric` with per-event-type content (cognee_op: url + node
  count; graphify_scan: project + n/e; graphify_query: question + type).

- **Status bar invisible** — `Footer` and `#status-bar` both docked to the
  same bottom slot, Footer winning. Compose order swapped + status-bar
  height bumped to 2 lines.

- **Graphify `_read_graph_stats` parsed the wrong key** — Graphify writes
  NetworkX node-link format with `links`, not `edges`. Stats now correctly
  read `links` (with backwards-compat fallback to `edges`).

### Removed

- **Orphans cleaned** — `payload/mishkan/templates/user-CLAUDE.md` (superseded
  by `payload/user/CLAUDE.md`). Two ambiguous schemas
  (`case-node.schema.json`, `observability-log.schema.json`) gained explicit
  `$comment` headers stating SPEC-ONLY status and the path to enforce them
  if and when needed.

## [0.2.0] — 2026-06-05

Observability stack ships. Documentation reorganised under `docs/usage/`.

### Added

- `mishkan-watchd` daemon + `mishkan-watch` TUI (5 tabs, status bar).
  Aggregates the Phase 1+1.5 event bus, 6 fail-open sources, exposed on a
  UNIX socket. Tabs: Live · Agents · Workflows · Knowledge · Activity.
- `docs/usage/` chapter set (01 installation through 10 observability).
- Three pillars README — orchestration, knowledge, observability.
- 7 dynamic workflows shipped (`mishkan-sprint-close`, `mishkan-init`,
  `mishkan-deep-research`, `mishkan-codebase-audit`,
  `mishkan-migration-wave`, `mishkan-architecture-panel`,
  `mishkan-release-readiness`).

### Changed

- Installer phasing reorganised; observability install is opt-in
  (phase 7).

## [0.1.0] — 2026-05-27

Initial npm release. The harness becomes distributable via
`npx mishkan-harness install`.

### Added

- 45 agents across 6 teams + 2 orchestrators + 6-stage research pipeline.
- Cognee work + curated stores with `cognify` / `memify` / search.
- Selective ingest (`mishkan-ingest` skill, `mishkan: ingest` frontmatter).
- LLM provider profiles for Gemini / NVIDIA / Ollama / OpenAI / Anthropic.
- Dependency-free `npx` installer with idempotent + non-clobbering semantics.
- ADRs D-001 through D-007.

[Unreleased]: https://github.com/Y4NN777/mishkan-cc-harness/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/Y4NN777/mishkan-cc-harness/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Y4NN777/mishkan-cc-harness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Y4NN777/mishkan-cc-harness/releases/tag/v0.1.0
