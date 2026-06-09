# Changelog

All notable changes to MISHKAN are documented here. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.6] — 2026-06-09

Observability hardening release. Live testing against a real multi-session,
prompt-cached, mixed-hook-history project surfaced a stack of bugs in the watch
daemon and TUI — running agents not appearing, duplicate rows, the context
gauge reading zero, workflows stuck "running", and a fleet-wide selective-ingest
permission bug. All fixed at the root. No API changes.

### Fixed

- **Observability — a tombstoned session's agents never reappeared.** When a
  session went quiet (parent transcript stale during an agent run),
  `session_discover` spuriously stopped it and the daemon tombstoned it; the
  tombstone check then dropped every later event for it — *before*
  confirm-on-first-event could re-admit it — so its running agents stayed
  invisible. A live event for a tombstoned session now un-tombstones and
  re-confirms it (safe: `bus_tail` seeks to EOF, so a fresh event is genuine
  activity, never a replayed ghost; a truly-ended session produces no events
  and stays gone).

- **Observability — TUI rendered each agent on two rows.** The `agent_spawn`
  key scheme evolved (older events carry the correlation id at top-level
  `subagent_id`; newer ones carry `tool_use_id` in payload). When a snapshot
  entry and a live delta for the same agent resolved different keys, the TUI
  kept two `agents_active` entries with the same `name` → two rows. The key
  chain is unified (`tool_use_id` → `subagent_id` → name) and same-name ghost
  entries under a stale key are swept on spawn/complete. Trade-off: two
  genuinely-concurrent agents of the *same* subagent_type now render as a
  single row (display-only; the daemon still tracks them separately).

- **Observability — running agents never appeared because their session was
  never confirmed.** The authority gate applied events only for sessions
  confirmed by `session_discover`, which confirms solely by the parent
  transcript's mtime (< 60s). During an agent run the parent transcript is quiet
  (the subagent writes to nested `subagents/agent-*.jsonl`), so the session was
  never confirmed and every `agent_spawn`/`tool_call`/`token_usage` for it was
  buffered and dropped — `agents_active` stayed empty even with spawns streaming
  in the bus. The gate now confirms a session on its **first live bus event**
  (not only via the transcript poll); safe because `bus_tail` seeks to EOF (no
  historical replay can resurrect a dead session) and the tombstone still blocks
  just-stopped sessions. Pairs with the keep-busy-sessions-alive fix: first
  event gets a session in, activity keeps it in.

- **Selective ingest was broken on every project (file-permission bug).**
  `mishkan-ingest.sh` staged its runner script via `mktemp` (mode 0600) and
  `docker cp`-ed it into the Cognee container, which preserves the 0600 mode and
  the host UID — so the container's non-root user could not read it and every
  ingest died with `Errno 13 Permission denied` before `add`/`cognify`/`memify`
  ever ran. `chmod 0644` the staged runner before the copy. Verified end-to-end:
  a doc now flows add → cognify → memify and lands in the graph.

- **Observability — active sessions were deleted mid-agent-run, so running
  agents never showed.** Session liveness was driven solely by the parent
  transcript's mtime (< 60s). But a subagent's activity is written to nested
  `subagents/agent-*.jsonl` files, so the parent transcript goes quiet during a
  run — `session_discover` then declared the session dead, and the daemon
  `pop`-ed the whole session (wiping `agents_active`) and tombstoned it, after
  which the agent's own `tool_call`/`agent_complete` events were dropped. Net
  effect: agents ran but never appeared in Active Agents/Agents, and
  usage/graphify flickered to 0 whenever the transcript was quiet. Liveness is
  now refreshed by any bus event (`last_event_mono`), and a `session_stop` is
  ignored while the session is busy (active agents OR a bus event within
  `SESSION_KEEPALIVE_S = 90s`); genuinely idle sessions are still cleaned up and
  the phantom-session tombstone still holds.

- **Observability — Usage "context" gauge read ~0% under prompt caching.** The
  gauge divided cumulative *uncached* `tokens_in` (a handful of tokens per turn
  once caching kicks in) by the context window, so it pinned near zero while the
  real footprint sat in `cache_read`. The daemon now tracks a per-session
  `last_context_tokens` (the most-recent turn's `cache_read + cache_write +
  tokens_in`, set not summed) and the TUI gauges against that, falling back to
  `tokens_in` on older snapshots. The TOKENS table and cost stay cumulative.

- **Observability — workflow runs stuck at "running" forever.** `workflow_start`
  / `workflow_update` were falling through unhandled in the daemon (so
  `workflows_active` was always empty), and no `workflow_complete` is ever
  emitted (the Workflow tool returns at launch; completion arrives out-of-band).
  The daemon now handles those events and ages a run with no activity for
  `WORKFLOW_STALE_TTL_S` (900 s) to status `"stale"` in the snapshot, so zombie
  `(unknown) [running]` rows clear instead of lingering. A cold-started daemon
  with no workflow events shows none.

- **Observability — agent tracking never showed live agents.** `agent_spawn`
  was emitted by the PostToolUse hook, so it fired when a subagent *finished*,
  and `agent_complete` was never emitted at all — the active-agent count only
  ratcheted up and no running agent ever appeared. `agent_spawn` now fires at
  PreToolUse (start), `agent_complete` at PostToolUse, and `agents_active` is
  keyed by `tool_use_id` (daemon and TUI) so concurrent agents of the same
  type don't collide. The TUI shows the human agent name, never the
  `tool_use_id`.

- **Observability — graphify query count was always 0.** Queries were detected
  by watching `graphify-out/memory/`, which the interactive `graphify query`
  never writes to. Detection moved to a `Bash` branch in `post-tool-observe.sh`
  that observes real `graphify query` / `graphify update` invocations.
  `graphify_tail` is demoted to stats-only (node/edge counts) and no longer
  fires a phantom `graphify_scan` on every daemon restart; a `stats_only`
  probe updates sizes but is not counted as a scan.

- **Observability — Usage tab froze after connect.** The tab read the session
  id under `session_id`/`sid`, but the daemon emits `session`; live deltas were
  dropped (it only populated from the snapshot). Now reads `session` first.

- **Observability — Workflows tab crashed on launch (`BadIdentifier`).** A run
  whose id resolved to `(unknown)` produced an invalid Textual widget id
  (`wf-(unknown)` — parentheses are illegal). List items now use index-based
  ids and map back to the real id/name on selection; surfaced when a fresh
  daemon re-ingested a workflow event the previous one had tailed past.

- **Observability — duplicate daemons / unreliable stop.** `mishkan-watchd
  start` refuses to steal a live socket (no more orphan daemons), and `stop`
  verifies the PID before `SIGTERM` and exits cleanly when nothing is running.

## [0.2.5] — 2026-06-09

First complete stable release, cut through the proper draft → publish →
CI gate (0.2.4 was published manually, bypassing the release notes).
Functionally it is 0.2.4 plus the label/doc corrections below; no
behavioural change. Supersedes and deprecates 0.2.4.

### Fixed

- **Observability package versions caught up to reality.** `mishkan-watch`
  and `mishkan-watchd` were still stamped `0.1.0` in `pyproject.toml` and
  `__version__` despite shipping three added tabs (Org-Ref · Usage · Skills)
  and several fixes across 0.2.0–0.2.4. Stamped `0.2.5`, aligned to the
  harness version, so they stop lying about their own maturity. The
  `mishkan-watch` description still said "5-tab dashboard" — now "8-tab".

- **Stale install note.** `docs/usage/01-installation.md` claimed the npx
  package was "published from v0.2.0"; the first npm release was 0.1.0.
  Reworded to "published to npm" so it can't drift again.

## [0.2.4] — 2026-06-09

Metadata-correction release. Functionally identical to 0.2.3 in code; it
ships the version strings and changelog that 0.2.3 should have carried.
0.2.3 is deprecated in its favour.

### Fixed

- **Version metadata realigned to the real release.** Published 0.2.3
  shipped with its changelog section labelled `[0.2.1]`, its actually-
  shipped items still parked under `[Unreleased]`, and the README status
  line reading `v0.2.1`. `0.2.1` and `0.2.2` were never published to npm —
  they existed only as git tags ("already taken"), which forced the real
  publish to `0.2.3`. All references now name `0.2.3` as the release those
  features shipped in, the shipped `[Unreleased]` items are folded into the
  `[0.2.3]` section, and feature-attribution refs across the docs read
  `v0.2.3`. The orphan `v0.2.1` git tag is retired.

- **`mishkan-resume` reconciles the remote before reading local state.**
  The command read `./CLAUDE.md` and the local working copy first, so a
  local copy sitting behind the remote (stale version + tag) drove a wrong
  "release pending" summary. It now runs `git fetch --tags --prune`,
  reconciles behind/ahead and version-vs-published-tag, fast-forwards a
  clean local move, and surfaces any divergence — before reasoning. Also
  handles the harness-source-repo case (no project `CLAUDE.md`) and an
  un-bootstrapped Cognee without fabricating state.

## [0.2.3] — 2026-06-07

The "discoverability + durability" release. Everything we'd promised becomes
findable at runtime; the observability stack stops hallucinating sessions on
restart; Graphify ships end-to-end and pays for itself in tokens; the workflow
portfolio doubles under a written governance contract.

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

- **Workflows tab crash on `DuplicateIds`** — `_render_list` called `lv.clear()` without awaiting the returned `AwaitRemove`, so the Textual DOM still held old items when `set_timer(0.1)` re-fired during mount. Made `_render_list` async with proper `await`, and `on_mount`/`apply_snapshot`/`apply_event` all coordinate through the async path or `call_later`.

- **State tests stale after phantom-session gate** — four `test_state.py` assertions sent events without a preceding `session_start`, which the `_confirmed_alive` gate (de77c0c) now requires. Prefixed each with `session_start`.

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

[Unreleased]: https://github.com/Y4NN777/mishkan-cc-harness/compare/v0.2.6...HEAD
[0.2.6]: https://github.com/Y4NN777/mishkan-cc-harness/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/Y4NN777/mishkan-cc-harness/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/Y4NN777/mishkan-cc-harness/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/Y4NN777/mishkan-cc-harness/compare/v0.2.0...v0.2.3
[0.2.0]: https://github.com/Y4NN777/mishkan-cc-harness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Y4NN777/mishkan-cc-harness/releases/tag/v0.1.0
