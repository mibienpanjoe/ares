# ARES Runtime Portability Plan

> Planning document for migrating the current Claude Code-first MISHKAN harness
> into a publishable `ares-harness` package with target adapters for Claude Code,
> Codex CLI, and OpenCode.

## Objective

Make the harness recoverable from npm and usable outside Claude Code without a
large, fragile rewrite.

The end state is:

- Public package: `ares-harness`
- Primary CLI: `ares`
- Legacy CLI: `mishkan` kept as a compatibility alias for at least one release
- Runtime-neutral home: `~/.ares`
- Target installs:
  - `ares install --target claude`
  - `ares install --target codex`
  - `ares install --target opencode`

The Red Rising / ARES naming of teams and agents is a separate organization
rename. Do not mix it into the runtime-portability migration until the target
adapter layer is stable.

## Implementation Status

Current branch: `ares-runtime-portability`.

Implemented in the first pass:

- `ares` CLI entrypoint, with `mishkan` kept as a legacy alias.
- Invocation-aware help text and legacy alias warning.
- Brand/runtime constants for `ares`, `mishkan`, `~/.ares`, `~/.codex`, and
  OpenCode config home.
- Target-aware CLI surface:
  - `ares install --target claude|codex|opencode|all`
  - `ares status --target claude|codex|opencode|all`
  - `ares runtime check --target claude|codex|opencode|all`
- Codex target adapter:
  - `~/.codex/AGENTS.md`
  - `~/.codex/agents/*.toml`
  - `~/.agents/skills/*/SKILL.md`, a portable shared skill tree with native
    invocation guidance for Codex and OpenCode
  - managed MCP block in `~/.codex/config.toml`
  - managed `SessionStart`, `PreToolUse`, and `PostToolUse` hooks for skill
    indexing, `apply_patch` security, timing, and observability
  - `~/.ares` payload cache
- OpenCode target adapter:
  - `~/.config/opencode/AGENTS.md`
  - `~/.config/opencode/agents/*.md`
  - `~/.config/opencode/commands/*.md`
  - shared `~/.agents/skills/*/SKILL.md`; obsolete managed copies under
    `~/.config/opencode/skills` are removed during migration to avoid
    nondeterministic duplicate discovery
  - `~/.config/opencode/plugins/ares-session.js` for the safe
    `session.created` skill-index refresh
  - `~/.config/opencode/plugins/ares-tool-hooks.js` for native
    `tool.execute.before/after` security, tracing, and observability
  - MCP entries in `~/.config/opencode/opencode.json`
  - `~/.ares` payload cache
- Local verification scripts: `npm run check`, `npm run check:cli`,
  `npm run check:layout`, `npm run check:runtimes`, `npm run check:hooks`,
  `npm run check:ingest`,
  `npm run check:work-store`, `npm run check:curated`,
  `npm run check:observability`, `npm run check:compose`, `npm run check:docs`,
  `npm run check:packlist`, and `npm run check:package`.
  - It now runs the CLI commands and asserts generated target artifacts:
    Codex hooks/shared skills/MCP, OpenCode commands/agents/shared
    skills/MCP, and
    project-level target files.
  - It scans the generated portable skill tree for stale
    runtime instructions such as `~/.claude/mishkan`, `mishkan knowledge`,
    `/mishkan-init`, `mishkan-work-*`, and legacy Cognee container names.
  - It also asserts target skill frontmatter names are unique, match their
    directory names, carry descriptions, and avoid non-portable plain YAML
    scalars. The legacy `mishkan-init` source skill is intentionally not copied
    into the portable target skill tree because the adapter generates the
    native `ares-init` skill.
  - The selective-ingest surface now uses `ares: ingest` as the primary
    frontmatter tag while keeping `mishkan: ingest` as a legacy alias in the
    underlying script. The Codex/OpenCode shared skill tree exposes `ares-ingest`,
    not `mishkan-ingest`.
  - `check:ingest` runs the real ingest shell script against an isolated fake
    Docker executable and proves tagged-only mode accepts both `ares: ingest`
    and the legacy tag, excludes untagged docs, and still accepts explicit
    untagged paths.
  - It verifies `ares model show` remains ARES-branded and does not suggest
    legacy `mishkan model` commands; installed model-routing overlays now point
    users at `ares install` and `ares model set/reset`.
  - It verifies `--wiring-only` on a separate temporary project: target-native
    state, MCP/config, and hooks are written, while docs, project agents,
    target-native commands and shared skills are not generated.
  - It verifies brownfield no-clobber behavior: existing `AGENTS.md`,
    `CLAUDE.md`, docs, Claude MCP/settings, Codex agent files, and OpenCode
    command files are preserved while managed blocks and mergeable config are
    added.
  - It also asserts compatibility aliases: legacy `mishkan` help warning,
    local `~/.local/bin/ares` and `~/.local/bin/mishkan` links when local bin
    exists, Claude `/ares-init` and legacy `/mishkan-init` command symlinks,
    and preservation of legacy command bodies alongside ARES command bodies.
  - It verifies the legacy removal guard: `ares uninstall --legacy-mishkan`
    refuses to delete `~/.claude/mishkan` when `~/.ares` is absent, unless the
    caller explicitly passes `--force`.
  - The docs gate prevents high-traffic usage docs from regressing to stale
    `mishkan-harness`, `/mishkan-init`, `mishkan-work-*`, old MCP alias
    instructions, the pre-ARES memory-layer topology, or direct
    `~/.claude/mishkan/scripts/mishkan-ingest.sh` usage instead of
    `ares knowledge ingest`. It now covers install, project init,
    orchestration, memory, selective ingest, provider profiles,
    troubleshooting, glossary, workflows, observability, Graphify, skill
    discovery, and the usage index.
  - The observability gate runs watchd state/source tests with Python bytecode
    disabled so package checks do not leave `__pycache__` artifacts behind.
  - The compose gate renders the shared/curated/UI stack and the work-store
    stack with synthetic env values when Docker Compose is available, then
    asserts ARES names and rejects legacy `mishkan-*` names.
  - `check:cli` now exercises `ares runtime check` in temporary target homes,
    proving the readiness diagnostic does not require mutating the user's real
    runtime directories.
  - `ares runtime check --dir <project>` additionally verifies target-native
    project wiring for Claude, Codex, and OpenCode; invalid project paths fail
    early without mutation.
  - `check:runtimes` installs all targets and initializes an isolated project,
    then invokes any installed real CLIs without a model request. On the local
    2026-06-19 audit it proved Claude Code 2.1.144 parses both project MCP
    entries, Codex CLI 0.141.0 resolves global/project instructions, ARES
    skills, and MCP entries, and OpenCode 1.15.13 resolves ARES MCP, agents,
    commands, and skills. The OpenCode check uses an offline empty model
    catalog and `--pure`; plugin callback behavior is exercised separately by
    `check:cli`.
- Claude target migration:
  - payload cache now installs to `~/.ares`
  - `~/.claude/agents`, `~/.claude/skills`, and `~/.claude/commands` symlink
    into `~/.ares`
  - Claude hooks now resolve to `~/.ares/hooks`
  - `/ares-init`, `/ares-resume`, and `/dependency-audit` aliases are generated
    while legacy `/mishkan-*` command files remain available
  - existing `~/.claude/mishkan` is copied into `~/.ares` on first migration
    and remains a fallback when `~/.ares` does not exist
  - explicit migration commands are available:
    `ares migrate legacy-mishkan` copies legacy files into `~/.ares` without
    deleting them, and `ares uninstall --legacy-mishkan` removes only the old
    `~/.claude/mishkan` runtime after migration
- Target-aware project init:
  - `ares project init --target claude|codex|opencode|all`
  - `--wiring-only` mode for mature projects
  - `--dir`, `--name`, and `--stack` options for scripted/bootstrap flows
  - managed project guidance blocks for `CLAUDE.md` and/or `AGENTS.md`
  - project-specific agents, commands, hooks, and MCP wiring without
    duplicating the global portable skill tree
  - target-native MCP/config scaffolding plus audited global tool-hook adapters;
    project Codex hooks keep only `SessionStart` to avoid duplicate global and
    project tool-hook execution
  - per-project Cognee work-store MCP entries are not written with placeholder
    ports; memory/curated MCP entries are generated first, and work-store wiring
    is deferred until `ares project-work-store up` has a real port
- Publishable package path:
  - package metadata now uses `ares-harness`
  - bins include `ares`, `ares-harness`, and legacy `mishkan` /
    `mishkan-harness`
  - `prepack` runs `npm run check`
  - `CHANGELOG.md` is included in package files
  - local tarball recovery is automated by `check:package`: it creates the
    `.tgz` with scripts disabled, installs it offline into a temporary npm
    prefix, runs `ares-harness` plus the legacy `mishkan` bin, installs all
    three targets into an isolated temporary home, initializes an all-target
    project, and runs global/project readiness checks
- Observability / skill-discovery runtime aliases:
  - `ares-watch` and `ares-watchd` are the primary uv tool package/binary names
  - legacy `mishkan-watch` and `mishkan-watchd` console scripts remain aliases
  - daemon, TUI, hooks, bus, usage parser, and skill-discovery now prefer
    `ARES_HOME`, `ARES_LOG_DIR`, `ARES_STATE_DIR`, and `~/.ares`
  - legacy `MISHKAN_*` variables and `~/.claude/mishkan` remain fallbacks
  - Codex/OpenCode command surfaces now generate `ares-skills-*` and
    `ares-org-reference` aliases in addition to `ares-init` / `ares-resume`

Still open:

- Safe write security, tracing, and observability are active across the three
  runtimes. Claude-only advisory hooks remain target-specific: model routing,
  knowledge-route context, task-skill context, and stop reporting are not
  claimed as portable where the host lacks equivalent events or context
  injection semantics.
- Non-model runtime loading is now automated for locally installed Claude Code,
  Codex, and OpenCode CLIs. Interactive proof still remains for actually
  invoking `/ares-init`, `$ares-init`, a custom agent/subagent, and Cognee tools
  inside authenticated model sessions. `ares runtime check` provides the
  non-destructive readiness checklist and prints the manual proof commands.
- Knowledge stack defaults now use ARES Docker names; live migration validation
  remains pending against a real stack with local secrets.
- Observability Codex/OpenCode active-session discovery is implemented. A local
  runtime log/storage audit on 2026-06-18 added passive tool, token, and
  compaction extraction for Codex plus passive session, tool, and token
  extraction for OpenCode. Subagent semantic mapping remains unclaimed until
  runtime-specific agent records are identified.

## Completion Audit - 2026-06-20

| Phase | Current evidence | Status |
|---|---|---|
| 0 - safety baseline | branch `ares-runtime-portability`; legacy help/org/model commands run in `check:cli` | complete |
| 1 - ARES alias | package exposes `ares` plus legacy bins; invocation-aware help is asserted | complete |
| 2 - constants | `BRAND`, `LEGACY_BRAND`, `ARES_HOME`, `RUNTIME_HOME`, target manifests; direct legacy payload paths are rejected by `check:layout` | complete |
| 3 - ARES home | isolated installs use `~/.ares`; legacy merge, guard, status, and removal paths are asserted | complete |
| 4 - target install API | bare install is proven Claude-only; each named target and `all` are exercised | complete |
| 5 - Claude adapter | global/project files, links, commands, hooks, rules, MCP, and reinstall idempotence are asserted | complete |
| 6 - Codex adapter | real CLI loads instructions, skills, MCP, and enabled stable hooks; payload contracts are tested | implementation complete; authenticated `/hooks` and model workflow acceptance pending |
| 7 - OpenCode adapter | real CLI loads config/agent/command/skill/MCP; native plugin callbacks block and emit telemetry | implementation complete; authenticated command/agent/MCP workflow acceptance pending |
| 8 - project init | full and wiring-only initialization run independently for Claude, Codex, and OpenCode, plus all-target and brownfield cases | complete |
| 9 - knowledge names | rendered Compose and fake-runtime migration paths prove ARES defaults and legacy reuse | implementation complete; live stack validation with local secrets/volumes pending |
| 10 - observability | renamed binaries, aliases, three runtime sources, state tests, and hook telemetry are covered | complete to the stated early-signal exit criterion; non-Claude subagent enrichment remains optional follow-up |
| 11 - package | dry-run packlist, offline real-tarball recovery, registry publish, and isolated `npx` recovery pass | complete for npm publication; live runtime acceptance remains separate |
| 12 - organization rename | explicitly excluded by the first-pass non-goals and the user decision to keep current teams/agents | deferred |

The authoritative local gate is `npm run check`. External acceptance must not be
marked complete from indirect evidence: it requires authenticated runtime
sessions, a real knowledge stack owned by the engineer, and registry access.

Last full local gate: `npm run check` passed on 2026-06-26, including the
real-CLI configuration checks and offline installation from the packed tarball.

Registry publication gate: `ares-harness@0.2.7` was published to npm on
2026-06-26. `npm view ares-harness version` returned `0.2.7`, and an isolated
`HOME`/cache recovery test from `/tmp` passed with:

```bash
npx --yes ares-harness@0.2.7 help
npx --yes ares-harness@0.2.7 install --target codex
npx --yes --package=ares-harness@0.2.7 ares runtime check --target codex
```

## External Acceptance Runbook

These checks require machine-local credentials, network access, or a live Docker
runtime. They are intentionally not part of `npm run check`.

1. Registry recovery:

   Status: complete for `ares-harness@0.2.7` on 2026-06-26.

   ```bash
   npm view ares-harness version
   npm publish --dry-run
   npm publish --access public
   ARES_HOME=/tmp/ares-npm-recovery HOME=/tmp/ares-npm-recovery \
     npx ares-harness install --target codex
   ```

   Evidence: the package is visible in the registry, `npx ares-harness` installs
   without using the local clone, and `ares runtime check --target codex` passes
   in the recovered home.

2. Authenticated target sessions:

   ```bash
   ares install --target all
   ares project init --target all --dir /tmp/ares-acceptance-project
   cd /tmp/ares-acceptance-project
   claude        # run /ares-init or /ares-resume
   codex         # run $ares-init or select ares-init through /skills
   opencode      # run /ares-init
   ```

   Evidence: each runtime loads ARES guidance, can invoke the native init
   surface, sees at least one custom agent/subagent, and lists the configured
   Cognee MCP tools. For Codex, `/hooks` must show the ARES hook commands as
   trusted or explicitly reviewed before the workflow proof.

3. Live knowledge stack:

   ```bash
   ares knowledge configure
   ares knowledge-stack up
   ares project-work-store up --dir /tmp/ares-acceptance-project
   docker ps --filter 'name=ares-' --format '{{.Names}}\t{{.Status}}'
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7777/mcp
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7730/mcp
   ```

   Evidence: shared memory and curated MCP endpoints return the expected MCP
   HTTP status, the project work store is reachable on its assigned port, new
   containers use `ares-*` names, and any existing `mishkan-*` containers are
   reused only through the documented legacy detection path.

## Source Findings

This plan is based on the current repo and runtime docs checked through
2026-06-19.

Codex official manual facts used:

- Codex reads durable instructions from global/project `AGENTS.md`, including
  `~/.codex/AGENTS.md` and project-scoped `AGENTS.md`.
- Codex skills are directories with `SKILL.md`, discovered from repo, user,
  admin, and system locations; plugins are the reusable distribution unit.
- Codex custom prompts were removed in CLI `0.117.0`. User-defined skills use
  `$skill-name` or the `/skills` picker; a literal `/ares-init` is not a
  supported custom command in Codex CLI.
- Codex MCP config lives in `config.toml` under `[mcp_servers.*]`.
- Codex hooks are configured in `hooks.json` or inline `[hooks]` config and
  support events including `PreToolUse`, `PostToolUse`, `SessionStart`,
  `SubagentStart`, `SubagentStop`, and `Stop`.
- Codex custom agents are TOML files under `~/.codex/agents/` or
  `.codex/agents/`, with `name`, `description`, and `developer_instructions`.

OpenCode docs facts used:

- OpenCode uses `AGENTS.md` for rules and supports Claude Code compatibility
  fallbacks, but ARES should generate native OpenCode files rather than relying
  on fallbacks.
- OpenCode agents can be configured in `opencode.json` or Markdown files under
  `~/.config/opencode/agents/` or `.opencode/agents/`.
- OpenCode commands are Markdown files under `~/.config/opencode/commands/` or
  `.opencode/commands/`.
- OpenCode MCP servers are configured under the `mcp` key in `opencode.json`.
- OpenCode skills are `SKILL.md` folders under `.opencode/skills`,
  `~/.config/opencode/skills`, `.agents/skills`, `~/.agents/skills`, and
  Claude-compatible skill paths.
- OpenCode automatically loads local JavaScript/TypeScript plugins from
  `.opencode/plugins/` and `~/.config/opencode/plugins/`; documented events
  include `session.created`, `tool.execute.before`, and `tool.execute.after`.

References:

- Codex manual: `https://developers.openai.com/codex/codex-manual.md`
- OpenCode docs: `https://opencode.ai/docs/`
- OpenCode agents: `https://opencode.ai/docs/agents/`
- OpenCode rules: `https://opencode.ai/docs/rules/`
- OpenCode commands: `https://opencode.ai/docs/commands/`
- OpenCode MCP: `https://opencode.ai/docs/mcp-servers/`
- OpenCode skills: `https://opencode.ai/docs/skills/`
- OpenCode plugins: `https://opencode.ai/docs/plugins/`

## Non-Goals For The First Pass

- Do not rename the 45 agents yet.
- Do not rename the six teams yet.
- Do not redesign Cognee or Graphify behavior.
- Do not remove Claude Code support.
- Do not publish a Red Rising-branded package.
- Do not make Codex/OpenCode feature parity claims until target smoke tests pass.

## Guiding Design

Separate three layers:

1. **Core harness data**
   Agent specs, skills, rules, workflows, org registry, model routing, Cognee
   scripts, Graphify integration, observability source code.

2. **Brand/runtime namespace**
   `ares`, `~/.ares`, env vars, logs, package name, binary name, npm metadata.

3. **Target adapters**
   Rendered artifacts for Claude Code, Codex, and OpenCode. Each target receives
   its own filesystem layout and config format.

The current repo has these layers interleaved under `payload/mishkan`. The
migration should split them gradually while keeping the existing install path
working.

## Command UX Policy

The desired user-facing intent should be consistent across runtimes:

```text
ares-init
ares-resume
sprint-close
sefer-pull
dependency-audit
```

Target adapters should make that intent feel native in each runtime:

- Claude Code: top-level slash commands such as `/ares-init`.
- OpenCode: top-level custom commands such as `/ares-init`, if supported by
  the native command loader.
- Codex: canonical implementation as skills, because Codex treats skills as the
  reusable workflow surface. The native invocation is explicit skill usage,
  for example `$ares-init`, or selecting `ares-init` through `/skills`.

Decision on 2026-06-16, refined on 2026-06-19: do not promise bare
`/ares-init` in Codex. Codex removed custom prompts in CLI `0.117.0`, and a
user-defined skill is not accepted as a literal `/<skill-name>` command. ARES
therefore installs `ares-init` only as a portable skill for Codex. The supported
forms are `$ares-init` and selection through `/skills`; exact slash parity would
require an upstream Codex change or a maintained Codex fork.

Do not rely on a runtime accepting Claude-style command files unless that
runtime documents the behavior natively. Generate native artifacts per target.

## Proposed Repository Shape

Introduce this structure before changing behavior deeply:

```text
payload/
  core/
    agents/
    skills/
    rules/
    workflows/
    config/
    templates/
    cognee/
    observability/
    org/
    scripts/
  targets/
    claude/
      commands/
      hooks/
      templates/
      install/
    codex/
      templates/
      hooks/
      renderers/
    opencode/
      templates/
      renderers/
  legacy/
    mishkan/
```

This can be introduced through copy/move commits, not all at once. The existing
`payload/mishkan` can remain as a compatibility mirror during the transition.

Implemented first step: `payload/core/manifest.json` is now the only CLI entry
to the current core source tree, and `payload/targets/<target>/manifest.json`
defines each target's instruction, agent, command, hook, and init surfaces.
`check:layout` rejects direct CLI coupling to `payload/mishkan`. Moving the
physical domains can therefore happen later by changing the core manifest,
without changing the target adapter contract.

## Implementation Plan

### Phase 0 - Safety Branch And Baseline

1. Create a branch:

   ```bash
   git checkout -b refactor/ares-runtime-portability
   ```

2. Capture current behavior:

   ```bash
   node bin/mishkan.js help
   node bin/mishkan.js org show --json
   node bin/mishkan.js model show
   ```

3. Add a small smoke-test script later, but for the first pass keep manual
   commands enough. The current package has no test harness.

Exit criteria:

- Current `mishkan` CLI behavior is understood and documented.
- No functional changes yet.

### Phase 1 - Add ARES CLI Alias Without Breaking MISHKAN

Goal: make `ares` exist while `mishkan` still works.

1. Rename nothing on disk yet.
2. Add a new bin entry in `package.json`:

   ```json
   "bin": {
     "ares": "bin/mishkan.js",
     "mishkan": "bin/mishkan.js"
   }
   ```

3. Update CLI help so it prints `ares` when invoked as `ares`, and `mishkan`
   only as legacy when invoked as `mishkan`.
4. Add deprecation text for the legacy command:

   ```text
   mishkan is a legacy alias; use ares
   ```

5. Keep the npm package name unchanged in this phase.

Exit criteria:

```bash
node bin/mishkan.js help
```

still works, and after npm-style linking both `ares` and `mishkan` call the same
CLI.

### Phase 2 - Introduce Brand Constants

Goal: stop adding new hardcoded `mishkan` strings.

1. Add central constants in the CLI:

   ```js
   const BRAND = "ares";
   const LEGACY_BRAND = "mishkan";
   const ARES_HOME = join(HOME, ".ares");
   const LEGACY_HOME = join(CLAUDE, "mishkan");
   ```

2. Do not flip storage yet. First make reads/writes route through helpers:

   - `runtimeHome()`
   - `targetHome(target)`
   - `legacyHome()`
   - `displayCommand()`
   - `legacyWarning()`

3. Add env var support:

   - `ARES_HOME`
   - keep `MISHKAN_HOME` as legacy fallback

4. Update shell/Python hooks to resolve:

   ```bash
   ARES_HOME="${ARES_HOME:-$HOME/.ares}"
   MISHKAN_HOME="${MISHKAN_HOME:-$HOME/.claude/mishkan}"
   ```

   but still prefer the existing MISHKAN paths until Phase 3.

Exit criteria:

- No behavior change.
- New code uses constants/helpers.
- `rg 'mishkan' bin payload/mishkan/hooks payload/mishkan/scripts` shows only
  expected legacy or user-visible strings.

### Phase 3 - Create Runtime-Neutral ARES Home

Goal: use `~/.ares` as the canonical payload cache.

1. Change install to copy core payload to:

   ```text
   ~/.ares/
   ```

2. For Claude target, install symlinks/config into:

   ```text
   ~/.claude/
   ```

   but those symlinks should point into `~/.ares`, not
   `~/.claude/mishkan`.

3. During transition, if `~/.claude/mishkan` exists and `~/.ares` does not,
   copy or migrate it with a clear message.

4. Do not delete legacy data automatically. Provide:

   ```bash
   ares migrate legacy-mishkan
   ares uninstall --legacy-mishkan
   ```

   only after the migration is stable.

Exit criteria:

- `ares install --target claude` installs from `~/.ares`.
- Existing `mishkan status` can still detect legacy installs and tell the user
  how to migrate.

### Phase 4 - Add Target-Aware Install API

Goal: make Claude Code just one install target.

1. Change CLI surface:

   ```bash
   ares install --target claude
   ares install --target codex
   ares install --target opencode
   ares install --target all
   ```

2. Keep bare install defaulting to Claude for one release:

   ```bash
   ares install
   ```

   should mean:

   ```bash
   ares install --target claude
   ```

3. Split installer functions:

   - `installCorePayload()`
   - `installClaudeTarget()`
   - `installCodexTarget()`
   - `installOpenCodeTarget()`
   - `installObservability()`
   - `installKnowledgeStackFiles()`

4. Add target status:

   ```bash
   ares status
   ares status --target claude
   ares status --target codex
   ares status --target opencode
   ```

Exit criteria:

- Claude install behavior remains equivalent to current behavior.
- Codex/OpenCode targets may still be stubs, but the CLI shape is stable.

### Phase 5 - Claude Target Adapter

Goal: preserve current behavior through the new target architecture.

Generate/copy:

```text
~/.claude/CLAUDE.md
~/.claude/agents/*.md
~/.claude/skills/*/SKILL.md
~/.claude/commands/*.md
~/.claude/settings.json hooks
~/.claude/rules/*
```

Target-specific notes:

- Claude commands remain the current slash-command Markdown files.
- Claude agents remain Markdown frontmatter agents.
- Claude hooks remain `settings.json` hook entries.
- Claude project init still writes `.mcp.json` until later phases.

Exit criteria:

```bash
ares install --target claude
ares status --target claude
```

matches current `mishkan install/status` behavior.

### Phase 6 - Codex Target Adapter

Goal: generate native Codex artifacts from the core harness.

Generate/copy:

```text
~/.codex/AGENTS.md
~/.codex/agents/*.toml
~/.agents/skills/*/SKILL.md
~/.codex/hooks.json
~/.codex/config.toml additions for MCP
```

Adapters:

1. **Identity**
   Convert `payload/user/CLAUDE.md` into a Codex global `AGENTS.md`.
   Keep it concise; Codex has a default project-doc byte budget.

2. **Project state**
   For Codex projects, generate `AGENTS.md` at the project root instead of
   `CLAUDE.md`. Optionally keep `CLAUDE.md` only when installing Claude target.

3. **Agents**
   Convert each Markdown agent into a TOML custom agent:

   ```toml
   name = "nathan"
   description = "..."
   developer_instructions = """
   ...
   """
   model = "..."
   ```

   Codex custom agents use `developer_instructions`; the converter should strip
   Claude-only frontmatter fields and preserve the body.

4. **Skills**
   Copy core skills into `~/.agents/skills`. Codex natively discovers that
   location.

5. **Commands**
   Preserve the intent names, but do not treat Claude-style slash commands as
   portable. Codex skills are the canonical reusable workflow surface. Convert
   important commands into skills first:

   - `ares-init`
   - `ares-resume`
   - `sprint-close`
   - `sefer-pull`
   - `dependency-audit`

   Preferred Codex invocation:

   ```text
   $ares-init
   ```

   or through:

   ```text
   /skills
   ```

   Do not generate `~/.codex/prompts`: custom prompts were removed in Codex CLI
   `0.117.0`. Literal `/ares-init` parity is not implementable from harness
   files alone.

6. **MCP**
   Write Codex MCP tables into `~/.codex/config.toml` or project
   `.codex/config.toml`:

   ```toml
   [mcp_servers.cognee]
   url = "http://127.0.0.1:<port>/mcp"
   ```

7. **Hooks**
   Convert supported hook events into `~/.codex/hooks.json`.
   Keep hook command scripts shared where possible, but add Codex payload
   parsing branches because Codex hook JSON is not guaranteed to match Claude
   Code hook JSON exactly.

   Implemented:

   - Global and project Codex installs merge a managed `SessionStart` command
     hook into `hooks.json`.
   - This hook runs `session-start-skill-index.sh`, which does not parse hook
     payloads and is safe across Codex's documented hook lifecycle.
   - The global install adds `PreToolUse` security/trace and `PostToolUse`
     observability hooks. Codex's canonical `apply_patch` payload is adapted
     from `tool_input.command`; only added lines are scanned, and one
     `file_change` event is emitted per patched file.
   - Project `hooks.json` keeps only `SessionStart`, avoiding duplicate tool
     hooks when Codex merges user and project layers.
   - `model-route`, knowledge-route, and task-skill advisory hooks remain
     Claude-specific until their event and context semantics have target-native
     equivalents.

Exit criteria:

```bash
ares install --target codex
codex /status
codex /hooks
codex /mcp
codex "Summarize active instructions and available ARES skills."
```

shows ARES instructions, hooks, MCP servers, and skills.

### Phase 7 - OpenCode Target Adapter

Goal: generate native OpenCode artifacts.

Generate/copy:

```text
~/.config/opencode/AGENTS.md
~/.config/opencode/agents/*.md
~/.config/opencode/commands/*.md
~/.agents/skills/*/SKILL.md
~/.config/opencode/opencode.json
```

Adapters:

1. **Identity**
   Convert user-level identity into `~/.config/opencode/AGENTS.md`.

2. **Project state**
   Generate project `AGENTS.md` for OpenCode projects. OpenCode can fall back to
   `CLAUDE.md`, but the target should be native and not rely on compatibility.

3. **Agents**
   Convert core agents to OpenCode Markdown agents:

   ```md
   ---
   description: ...
   mode: subagent
   model: ...
   permission:
     edit: deny
     bash: ask
   ---

   instructions...
   ```

4. **Commands**
   Convert command Markdown files into `.opencode/commands` or global
   `~/.config/opencode/commands`.

5. **Skills**
   Install the same runtime-neutral skills used by Codex under
   `~/.agents/skills`. OpenCode discovers this path natively. Do not duplicate
   ARES skills under `~/.config/opencode/skills`, because OpenCode scans both
   roots concurrently and duplicate names can resolve nondeterministically.

6. **MCP**
   Write OpenCode MCP config under the `mcp` key in `opencode.json`.

7. **Hooks**
   OpenCode plugin hooks are native but their payloads differ from Claude.
   Install one audited global plugin for `session.created`; it invokes
   `session-start-skill-index.sh` and remains fail-open. Install a second plugin
   for `tool.execute.before/after`: it maps OpenCode `write`, `edit`,
   `apply_patch`, `bash`, and `skill` arguments to the shared hook schema,
   blocks security denials by throwing from the native before hook, and sends
   completed calls to ARES observability.

Exit criteria:

```bash
ares install --target opencode
opencode
/init
```

then verify:

- `AGENTS.md` loads.
- A custom command appears.
- A custom agent can be `@` mentioned.
- Skills are visible to the skill tool.
- Cognee MCP tools are available.

### Phase 8 - Project Init Becomes Target-Aware

Goal: make `ares init` render target-native project files.

Add CLI:

```bash
ares project init --target claude
ares project init --target codex
ares project init --target opencode
ares project init --target all
```

Outputs:

Claude:

```text
CLAUDE.md
.mcp.json
.claude/settings.json
.claude/settings.local.json
.claude/rules/*
```

Codex:

```text
AGENTS.md
.codex/config.toml
.codex/hooks.json
.codex/agents/*
```

OpenCode:

```text
AGENTS.md
opencode.json
.opencode/agents/*
.opencode/commands/*
```

Shared:

```text
~/.agents/skills/* (global portable workflows; not copied into each project)
docs/
graphify-out/ (generated, ignored)
Cognee project work store
```

Exit criteria:

- A new empty project can be initialized for each target.
- A mature project can choose "wiring only" for each target.

### Phase 9 - Knowledge Stack Rename

Goal: move runtime containers and env names from `mishkan-*` to `ares-*`.

Rename only after target adapters work.

Planned names:

```text
mishkan-cognee-*       -> ares-cognee-*
mishkan-curated-*      -> ares-curated-*
mishkan-work-<slug>    -> ares-work-<slug>
MISHKAN_HOME           -> ARES_HOME
MISHKAN_LOG_DIR        -> ARES_LOG_DIR
```

Compatibility:

- Detect existing `mishkan-*` containers.
- Offer migration or continued legacy mode.
- Never delete volumes automatically.

Implemented so far:

- New compose defaults use `ares-cognee-*`, `ares-curated-*`, `ares-work-*`,
  `ares/cognee-mcp`, `ares/cognee-backend`, and `ares/cognee-frontend`.
- `ensure-curated-box.sh`, `ensure-work-store.sh`, ingest, seed, promote, and
  reset scripts detect existing legacy `mishkan-*` containers and continue on
  that runtime when it is the only installed stack.
- The CLI passes ARES Docker defaults to Compose, while respecting explicit
  user environment overrides.
- `knowledge-stack status` reports both `ares-*` and legacy `mishkan-*`
  containers.
- `project-work-store down/reset` targets an existing legacy store if present;
  new stores default to `ares-work-<slug>`.
- Destructive reset covers both `ares-work-*` and `mishkan-work-*` stores, with
  the existing type-to-confirm gate.
- `check:work-store` executes `ensure-work-store.sh` against an isolated fake
  Docker CLI and proves three naming paths: fully ARES-native defaults, reuse
  of an existing healthy legacy container, and an ARES container temporarily
  attached to the only existing legacy shared network.
- `check:curated` executes `ensure-curated-box.sh` against an isolated runtime
  copy and fake Docker CLI. It proves a fresh curated box uses only ARES
  Postgres/container/network/image names and an existing legacy curated stack
  is reused without mixing ARES resources into it.

Exit criteria:

- New installs use `ares-*`. Status: implemented and covered by CLI smoke tests.
- Existing installs get a safe migration path. Status: legacy detection plus
  explicit `ares migrate legacy-mishkan` / `ares uninstall --legacy-mishkan`
  commands are implemented and covered by `check:cli`; full live Docker
  migration remains a manual/runtime validation item because this repo does not
  contain active `.env` / `.env.curated` secrets.

Static Compose validation:

- `scripts/check-compose.mjs` now renders the full shared/curated/UI stack in a
  temporary copy with synthetic `.env` and `.env.curated` when Docker Compose is
  available:

  ```bash
  docker compose \
    -f docker-compose.yml \
    -f docker-compose.hardening.yml \
    -f docker-compose.selfhosted.yml \
    -f docker-compose.curated.yml \
    -f docker-compose.ui.yml \
    -f docker-compose.curated-ui.yml \
    config
  ```

  Verified rendered names include `ares-cognee`, `ares-cognee-mcp`,
  `ares-cognee-pg`, `ares-ollama`, `ares-curated-mcp`,
  `ares-curated-neo4j`, `ares/cognee-mcp`, `ares/cognee-backend`, and
  `ares/cognee-frontend`; no `mishkan-cognee-*`, `mishkan-curated-*`, or
  `mishkan/cognee-*` names appear.

- Rendered the per-project work-store compose with:

  ```bash
  WORK_PROJECT=demo WORK_PORT=7890 COGNEE_MCP_REF=v1.1.0 \
  COGNEE_MCP_IMAGE=ares/cognee-mcp \
  COGNEE_WORK_NETWORK=ares-cognee_cognee_net \
  docker compose -f docker-compose.work.yml -f docker-compose.hardening.yml config
  ```

  Verified rendered names include `ares-work-demo`,
  `ares-work-demo_work_data`, `ares/cognee-mcp`, and
  `ares-cognee_cognee_net`; no legacy `mishkan-work-*` or `mishkan/cognee-*`
  names appear.

### Phase 10 - Observability Rename And Multi-Runtime Sources

Goal: rename observability and add Codex/OpenCode event sources.

Rename binaries:

```text
mishkan-watchd -> ares-watchd
mishkan-watch  -> ares-watch
```

Keep aliases for one release if feasible.

Implemented so far:

- `ares-watch` / `ares-watchd` package and console-script names.
- Legacy `mishkan-watch` / `mishkan-watchd` console-script aliases.
- Systemd unit name changed to `ares-watchd.service`.
- Default socket/log/state paths now resolve through `ARES_HOME`/`~/.ares`,
  with `MISHKAN_HOME`/`~/.claude/mishkan` fallback.
- MCP probe also reads ARES-managed Codex `.codex/config.toml` and OpenCode
  `opencode.json` blocks.
- Session discovery now runs separate sources for Claude Code, Codex, and
  OpenCode:
  - Claude: `~/.claude/projects`
  - Codex: `CODEX_HOME/sessions`, defaulting to `~/.codex/sessions`
    (`ARES_CODEX_THREADS_DIR` remains accepted as a legacy override)
  - OpenCode: `ARES_OPENCODE_SESSIONS_DIR`, `OPENCODE_DATA_DIR`, or
    `~/.local/share/opencode`
- Snapshot sessions now carry `runtime` and `jsonl_path`.
- Non-Claude session ids are prefixed (`codex:<id>`, `opencode:<id>`) to
  avoid collisions with Claude session ids.
- `ares-watchd install-service` writes the Codex/OpenCode session dirs into
  the generated systemd user unit.
- `HarnessState` has a direct regression test for runtime/jsonl_path snapshot
  fields. Verified with:

  ```bash
  PYTHONDONTWRITEBYTECODE=1 python3 \
    payload/mishkan/observability/watchd/tests/test_state.py
  ```

Add sources:

- Claude Code source: current JSONL/hook bus behavior.
- Codex source: active-session discovery is implemented from Codex session
  JSONL files under `~/.codex/sessions`. A local transcript audit on
  2026-06-18 found `session_meta`, `event_msg`, `response_item`,
  `turn_context`, and `compacted` records; `session_tail` now extracts Codex
  tool calls, token usage, and compaction events from that shape.
- OpenCode source: active-session discovery and passive event extraction are
  implemented from OpenCode storage JSON under `storage/session`,
  `storage/message`, and `storage/part`. A local storage audit on 2026-06-18
  found session metadata, assistant message token records, and tool part
  records; `opencode_storage` now emits session_start/session_stop,
  token_usage, and tool_call events.

Remaining limitation: Codex/OpenCode subagent semantics are not claimed yet.
The current passive sources extract tools, tokens, compacting/session state, and
runtime labels, but neither audited format has been mapped to ARES
`agent_spawn` / `agent_complete` events.

Exit criteria:

- `ares-watch` works for Claude target.
- Codex/OpenCode appear as target tabs or source labels even if early signal is
  limited to session/tool events.

### Phase 11 - Publishable Package

Goal: make npm recovery real.

1. Change package metadata:

   ```json
   {
     "name": "ares-harness",
     "bin": {
       "ares": "bin/ares.js",
       "mishkan": "bin/ares.js"
     }
   }
   ```

2. Keep package files:

   ```json
   "files": ["bin/", "payload/", "docs/", "README.md", "CHANGELOG.md"]
   ```

3. Add a prepack verification script:

   ```bash
   node bin/ares.js help
   node bin/ares.js org show --json
   ```

4. Publish dry run:

   ```bash
   npm pack --dry-run
   npm pack
   ```

5. Install from tarball in a temp home:

   ```bash
   HOME=/tmp/ares-home npx ./ares-harness-*.tgz install --target claude
   HOME=/tmp/ares-home npx ./ares-harness-*.tgz status
   ```

Exit criteria:

- A lost-machine recovery path exists:

  ```bash
  npx ares-harness install --target codex
  ```

Implemented so far:

- `package.json` publishes `ares-harness` with `ares`, `ares-harness`, and
  legacy `mishkan` / `mishkan-harness` bins.
- `files` includes `bin/`, `scripts/`, `payload/`, `docs/`, `README.md`, and
  `CHANGELOG.md`.
- `prepack` runs `npm run check`, which chains `check:layout`, `check:cli`, `check:runtimes`,
  `check:hooks`, `check:ingest`, `check:work-store`, `check:curated`, `check:observability`,
  `check:compose`, `check:docs`, `check:packlist`, and `check:package`.
- `scripts/check-cli.mjs` verifies target installs and project init by
  inspecting generated Codex/OpenCode/Claude artifacts, not just process exit
  codes. It also executes the generated OpenCode before/after callbacks and
  proves a hardcoded secret is blocked while safe writes emit telemetry.
- `scripts/check-hooks.mjs` feeds representative Claude and Codex payloads to
  the shared scripts, including multi-file patches, removal-only secrets, and
  exact `file_change` line counts.
- `scripts/check-observability.mjs` runs the watchd state/source tests when
  Python is available, with bytecode writes disabled.
- `scripts/check-packlist.mjs` uses
  `npm pack --dry-run --json --ignore-scripts` as the package manifest gate, so
  `prepack` can verify npm contents without recursively triggering itself.
- `scripts/check-package.mjs` creates a real tarball with lifecycle scripts
  disabled, installs it offline into a temporary npm prefix, executes the ARES
  and legacy bins, installs Claude/Codex/OpenCode into an isolated temporary
  home, initializes an all-target project, and runs both global and project
  readiness checks.
- Packaging excludes Python build artefacts (`__pycache__`, `*.pyc`) through the
  npm `files` allowlist exclusions. The packlist gate asserts required runtime,
  docs, script, and OpenCode parser files are present and that Python cache
  entries and local tarballs are absent.
- The automated package recovery gate verifies Claude `/ares-init`, Codex ARES
  guidance plus `ares-init`/`ares-ingest`, OpenCode guidance/command/skill/plugin
  artifacts, and all-target project wiring, while excluding the legacy
  `mishkan-init` target skill from Codex.

### Phase 12 - Organization Rename

Goal: rename teams/agents only after runtime portability is stable.

Inputs:

- Red Rising / ARES naming decision.
- Public-IP risk decision:
  - fully character-based private edition, or
  - generic ARES/Color-inspired public edition.

Implementation:

- Add `config/naming.yaml`.
- Update `org.json`.
- Rename agent files and frontmatter.
- Update `model-routing.yaml`.
- Update workflow `agentType` references.
- Update skills and docs.
- Keep legacy aliases where possible.

Exit criteria:

- `ares org show --json` lists the new org.
- No old agent/team identifiers remain except in migration notes:

  ```bash
  rg "nehemiah|bezalel|chosheb|panim|yasad|mishmar|migdal|sefer"
  ```

## Compatibility Policy

For one transition release:

- `mishkan` CLI remains an alias.
- `/mishkan-*` Claude commands remain aliases or wrappers.
- `~/.claude/mishkan` is detected and migrated, not deleted.
- Existing Cognee volumes are never deleted by automatic migration.

After one stable `ares` release:

- Legacy CLI remains only if maintenance cost is low.
- Legacy docs move to a migration appendix.
- New installs do not create `~/.claude/mishkan`.

## Verification Checklist

Run after every phase:

```bash
git status --short
node bin/mishkan.js help
node bin/mishkan.js org show --json
node bin/mishkan.js model show
```

Once `ares` exists:

```bash
node bin/ares.js help
node bin/ares.js status
node bin/ares.js runtime check --target all
node bin/ares.js org show --json
```

Target smoke tests:

```bash
ares install --target claude
ares install --target codex
ares install --target opencode
ares status --target all
ares runtime check --target all
```

Project smoke tests:

```bash
ares project init --target claude
ares project init --target codex
ares project init --target opencode
```

## Risks

- Hook payloads differ across runtimes; hook scripts need adapter parsing, not
  blind reuse.
- Codex slash-command extensibility should not be treated like Claude commands;
  use skills as the canonical Codex reusable workflow surface.
- OpenCode supports Claude compatibility, but relying on it would preserve the
  old namespace and weaken the point of ARES.
- Cognee container rename can strand volumes if done carelessly. Migration must
  be explicit and non-destructive.
- A full agent rename before runtime adapters would multiply the debugging
  surface.

## First Concrete Pull Request

Keep PR 1 small:

1. Add this plan.
2. Add `ares` as a CLI bin alias.
3. Add invocation-aware help text.
4. Add no runtime path changes.
5. Verify old `mishkan` commands still work.

That PR establishes the public direction without risking the installer.
