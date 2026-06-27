# 12 — The `ares` CLI

> One control surface for the harness and its knowledge stack. ADR **D-015**.

Every command is **`ares <object> <verb>`** — it names *what it operates on*.
The legacy `mishkan` alias is kept for compatibility.
The one exception is self-management (`install` / `uninstall` / `status`), where the
object is the tool itself (so `npx ares-harness install`, not the doubled
`… harness install`).

> **Who runs these:** you do. The CLI executes because a *human* invokes it. Agents
> never get this bin (rule 5 / D-005), and the observability TUI only *surfaces*
> commands to copy — it never runs them.

## Manage the harness

| Command | Does |
|---|---|
| `ares install --target claude\|codex\|opencode\|all [--memory native\|cognee\|hybrid]` | Install / refresh target files (idempotent). `native` is default. |
| `ares project init --target claude\|codex\|opencode\|all [--memory native\|cognee\|hybrid]` | Scaffold target-native project wiring. Cognee MCP is written only with `cognee`/`hybrid`. |
| `ares uninstall [--purge]` | Remove Claude target files (`--purge` also drops `y4nn-standards.md`) |
| `ares migrate legacy-mishkan` | Copy `~/.claude/mishkan` into `~/.ares` without deleting the legacy runtime |
| `ares uninstall --legacy-mishkan` | Remove only the old `~/.claude/mishkan` runtime after migration |
| `ares status --target claude\|codex\|opencode\|all` | Install state **+ live knowledge-stack health** in one view |
| `ares runtime check --target claude\|codex\|opencode\|all [--dir <project>] [--strict]` | Non-destructive runtime readiness checklist: CLI availability, global target files, optional project wiring, MCP/hooks/commands/skills, and manual proof commands |

`runtime check` does not start Claude Code, Codex, or OpenCode. It confirms the
installed surface is ready and prints the exact runtime invocation to use for
manual proof. Pass `--dir <project>` to include target-native project wiring.
Add `--strict` when you want missing files or missing runtime CLIs to produce a
non-zero exit code.

## Knowledge

| Command | Does |
|---|---|
| `ares knowledge configure` | Wizard: LLM provider + cognee secrets → writes `.env` + `ACCESS.txt` |
| `ares knowledge ingest [--tagged-only] [--dataset=X] [paths…]` | Add docs to **this project's** store (`add → cognify → memify`) |
| `ares knowledge curate` | Review + approve research-found resources into the **shared curated library** (D-016). Walks the candidate queue Baruch fills; on approval, an *additive* (no-prune, dedup) write. Stateful — you run it. |
| `ares knowledge reset` | **Destructive** — full reset of the knowledge layer to the stable baseline: wipes every work store (container + volume), prunes `cognee-memory`, re-seeds `cognee-curated` from the canonical YAML. Type-to-confirm. Stateful — you run it. Work stores recreate on the next `/ares-init`. |
| `ares knowledge-stack up [--build]` | Bring the optional Cognee shared infra up (memory `:7777` + curated `:7730` + ollama/pg). **Guided:** preflights config, names any gap, stops — never a cryptic docker error. `--build` only for the first image build. |
| `ares knowledge-stack down` | Stop it — containers down, volumes/data survive (confirms) |
| `ares knowledge-stack restart` | down + up |
| `ares knowledge-stack status` | Detailed per-container health |
| `ares project-work-store [<slug>] up` | Provision this project's own isolated store (slug → current dir) |
| `ares project-work-store [<slug>] down` | Stop it — data volume kept |
| `ares project-work-store [<slug>] reset` | Wipe it — removes container **and** data volume (confirms) |

**`knowledge-stack` vs `project-work-store`** is infra-lifecycle (`up` a shared stack)
vs data-lifecycle (`reset`/wipe a per-project store) — named differently on purpose.

## Inspect / observe

| Command | Does |
|---|---|
| `ares code-graph status \| open \| scan` | The project's code graph (Graphify) |
| `ares observability install \| open` | The live monitor — install the daemon+TUI, or open it |
| `ares org show [--json]` | The 45-agent organisation reference |
| `ares model show \| set \| reset` | Re-tier which Claude model an agent runs on (D-017) |

## Re-tier the agent fleet — `ares model`

Every MISHKAN agent runs on a Claude tier (D-002). The shipped defaults live in
`model-routing.yaml`; **your** overrides live in `model-routing.local.yaml`, an overlay
the installer never clobbers — so re-tiering survives `ares install`, and you never
edit 45 frontmatter files.

| Command | Does |
|---|---|
| `ares model show` | Effective tier per agent (default + your overrides), marking overrides and flagging any **dormant** tier |
| `ares model set <agent\|team\|all> <tier>` | Override a tier. `<tier>` ∈ `opus \| sonnet \| haiku \| fable`. `<team>` is an org id (`mishmar`, `migdal`, …); `all` = every agent |
| `ares model reset [<agent\|team\|all>]` | Drop override(s); no argument clears them all (back to shipped defaults) |

Changes take effect on the **next delegation** — the `model-route.py` hook reads the
overlay live; no reinstall needed. Use it for cost (drop a tier), availability (a tier
can be suspended — see the **fable** note below), or preference.

> **`fable` is dormant.** Claude Fable 5 was suspended for all customers on 2026-06-12
> (export-control directive). `ares model set … fable` warns and confirms; agents
> routed to it will fail to spawn until access is restored. The tier value is kept so
> re-enabling is one command if it returns.

The TUI binary is `ares-watch`; `ares-watchd start|stop|status` is the manual
daemon control. In the TUI, **`c`** copies the fix command for a down store to your
clipboard (it shows the command — it never runs it).

## Project init composes the verbs

With `--memory native` (default), `/ares-init` uses runtime memory and versioned
docs; it does not run Cognee. With `--memory cognee|hybrid`, `/ares-init` may run
`knowledge-stack up` (ensure the shared infra, confirm-if-down) then
`project-work-store up` (this project's store) after human confirmation — the same
guided/preflight path, but only for projects that opted into Cognee.

## Deprecated aliases

The pre-D-015 flat names still work (hidden, undocumented) so nothing breaks mid-
migration: `configure-knowledge` → `knowledge configure`, `ingest` → `knowledge
ingest`, `observability` → `observability install`, `watch` → `observability open`,
`org` → `org show`. Prefer the object-first forms.
