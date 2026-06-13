# 12 — The `mishkan` CLI

> One control surface for the harness and its knowledge stack. ADR **D-015**.

Every command is **`mishkan <object> <verb>`** — it names *what it operates on*.
The one exception is self-management (`install` / `uninstall` / `status`), where the
object is the tool itself (so `npx mishkan-harness install`, not the doubled
`… harness install`).

> **Who runs these:** you do. The CLI executes because a *human* invokes it. Agents
> never get this bin (rule 5 / D-005), and the observability TUI only *surfaces*
> commands to copy — it never runs them.

## Manage the harness

| Command | Does |
|---|---|
| `mishkan install` | Install / refresh into `~/.claude` (idempotent) |
| `mishkan uninstall [--purge]` | Remove it (`--purge` also drops `y4nn-standards.md`) |
| `mishkan status` | Install state **+ live knowledge-stack health** in one view |

## Knowledge

| Command | Does |
|---|---|
| `mishkan knowledge configure` | Wizard: LLM provider + cognee secrets → writes `.env` + `ACCESS.txt` |
| `mishkan knowledge ingest [--tagged-only] [--dataset=X] [paths…]` | Add docs to **this project's** store (`add → cognify → memify`) |
| `mishkan knowledge curate` | Review + approve research-found resources into the **shared curated library** (D-016). Walks the candidate queue Baruch fills; on approval, an *additive* (no-prune, dedup) write. Stateful — you run it. |
| `mishkan knowledge-stack up [--build]` | Bring the shared infra up (memory `:7777` + curated `:7730` + ollama/pg). **Guided:** preflights config, names any gap, stops — never a cryptic docker error. `--build` only for the first image build. |
| `mishkan knowledge-stack down` | Stop it — containers down, volumes/data survive (confirms) |
| `mishkan knowledge-stack restart` | down + up |
| `mishkan knowledge-stack status` | Detailed per-container health |
| `mishkan project-work-store [<slug>] up` | Provision this project's own isolated store (slug → current dir) |
| `mishkan project-work-store [<slug>] down` | Stop it — data volume kept |
| `mishkan project-work-store [<slug>] reset` | Wipe it — removes container **and** data volume (confirms) |

**`knowledge-stack` vs `project-work-store`** is infra-lifecycle (`up` a shared stack)
vs data-lifecycle (`reset`/wipe a per-project store) — named differently on purpose.

## Inspect / observe

| Command | Does |
|---|---|
| `mishkan code-graph status \| open \| scan` | The project's code graph (Graphify) |
| `mishkan observability install \| open` | The live monitor — install the daemon+TUI, or open it |
| `mishkan org show [--json]` | The 45-agent organisation reference |
| `mishkan model show \| set \| reset` | Re-tier which Claude model an agent runs on (D-017) |

## Re-tier the agent fleet — `mishkan model`

Every MISHKAN agent runs on a Claude tier (D-002). The shipped defaults live in
`model-routing.yaml`; **your** overrides live in `model-routing.local.yaml`, an overlay
the installer never clobbers — so re-tiering survives `mishkan install`, and you never
edit 45 frontmatter files.

| Command | Does |
|---|---|
| `mishkan model show` | Effective tier per agent (default + your overrides), marking overrides and flagging any **dormant** tier |
| `mishkan model set <agent\|team\|all> <tier>` | Override a tier. `<tier>` ∈ `opus \| sonnet \| haiku \| fable`. `<team>` is an org id (`mishmar`, `migdal`, …); `all` = every agent |
| `mishkan model reset [<agent\|team\|all>]` | Drop override(s); no argument clears them all (back to shipped defaults) |

Changes take effect on the **next delegation** — the `model-route.py` hook reads the
overlay live; no reinstall needed. Use it for cost (drop a tier), availability (a tier
can be suspended — see the **fable** note below), or preference.

> **`fable` is dormant.** Claude Fable 5 was suspended for all customers on 2026-06-12
> (export-control directive). `mishkan model set … fable` warns and confirms; agents
> routed to it will fail to spawn until access is restored. The tier value is kept so
> re-enabling is one command if it returns.

The TUI binary is `mishkan-watch`; `mishkan-watchd start|stop|status` is the manual
daemon control. In the TUI, **`c`** copies the fix command for a down store to your
clipboard (it shows the command — it never runs it).

## Project init composes the verbs

`/mishkan-init` runs `knowledge-stack up` (ensure the shared infra, confirm-if-down)
then `project-work-store up` (this project's store) — the same guided/preflight path,
so a fresh project comes up working without you knowing the topology.

## Deprecated aliases

The pre-D-015 flat names still work (hidden, undocumented) so nothing breaks mid-
migration: `configure-knowledge` → `knowledge configure`, `ingest` → `knowledge
ingest`, `observability` → `observability install`, `watch` → `observability open`,
`org` → `org show`. Prefer the object-first forms.
