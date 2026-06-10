# MISHKAN — Build Decisions

Decisions made at Phase 0 that govern the entire build. Each is locked unless
explicitly revisited with a dated entry below.

---

## D-001 — Cognee deployment: Local Docker

**Decision:** Cognee runs as a containerised service under
`~/.claude/mishkan/cognee/`, managed by Docker Compose.

**Rationale:** Aligns with the existing infrastructure discipline — everything
else runs through Docker Compose with multi-environment overlays, SOPS-managed
secrets, and hardening overlays. The knowledge graph stays local; no external
account or billing surface. Fastest install.

**Implications:**
- `.mcp.json` points the Cognee MCP at the local containerised endpoint.
- Secrets (DB password, API keys if any) managed via SOPS, never plaintext.
- A hardening overlay is applied on every container recreate.
- Backups are local; no cloud egress.

---

## D-002 — Model backend: Claude Code models only

**Decision:** Every agent runs on a Claude model tier. There is no local model
runtime and no local-model MCP wrapper.

**Rationale:** The target is Claude Code's native models. Introducing a local
runtime (Ollama / LM Studio / Docker Model Runner / llama.cpp) would add a whole
subsystem — an MCP wrapper, runtime health-checks, fallback logic, per-agent
runtime selection — for no benefit given the target. Removing it simplifies the
build materially.

**Implications:**
- Three tiers only: Opus, Sonnet, Haiku.
  - **Opus (9):** Nehemiah, Bezalel, all Team Leads, Jehonathan.
  - **Sonnet (22):** every agent that **writes code/config into the codebase**
    (precision matters on Y4NN's code) + senior specialists + research
    clarify/formulate/research. Includes all implementation specialists —
    Hizkiah, Salma, Hiram, Obed, Asaph, Palal, Meremoth, Hanun — plus Nathan,
    Zadok, Shallum, Ira, Benaiah, Joab, Hushai, Oholiab, Meshullam, Seraiah,
    Joah, Jakin, Ezra, Caleb.
  - **Haiku (14):** agents that do **not** write code — QA (Uriah, Jahaziel),
    all Team Reporters, pure advisors (Deborah, Rehum), Sefer team-layer docs
    (Shevna), research summarise/evaluate/report (Shaphan, Shemaiah, Baruch).

**Amendment 2026-05-27:** original split put implementation specialists on
Haiku for cost. Revised on Y4NN's preference — Sonnet writes his code more
precisely. Haiku retained only where no code is written (evaluate/collect/advise).
- Tier declared per-agent in frontmatter `model:` field.
- Overridable centrally via `~/.claude/mishkan/config/model-routing.yaml`.
- Cost discipline lives entirely in tier assignment + prompt caching +
  Cognee offloading. The observability loop surfaces expensive agents.

**Supersedes:** the original design §16 model assignment matrix, which assumed
local models for the fast tier. Local tiers are replaced by Haiku.

---

## D-003 — Install scope: User + Project hierarchy

**Decision:** `~/.claude/` carries permanent standards, agents, hooks, and rules
common across all work. A per-project `.claude/` carries project-specific state,
seeded by `/mishkan-init`.

**Rationale:** Matches the design doc's CLAUDE.md hierarchy. The user-level layer
is always warm and travels every project; the project layer holds sprint state,
the project CLAUDE.md, and project-scoped settings.

**Implications:**
- All MISHKAN artifacts live under `~/.claude/mishkan/` to avoid clobbering the
  existing user-level surface (5 agents, 8 commands, 152 skills, settings,
  command-validator script).
- `~/.claude/CLAUDE.md` and `~/.claude/rules/y4nn-standards.md` are introduced
  by MISHKAN (neither existed before).
- Commands are symlinked into `~/.claude/commands/` only after confirming no
  name collision.
- `/mishkan-init` seeds the project layer: `./CLAUDE.md`, `docs/`, project
  `.claude/settings.json`, Cognee project namespace.

---

## D-004 — Existing user-level surface is preserved, never overwritten

**Decision:** MISHKAN extends `~/.claude/`; it does not replace anything.

**Preserved as-is:** any pre-existing user-level `~/.claude/agents/*.md`,
`~/.claude/commands/*.md`, `~/.claude/skills/*`, `~/.claude/settings.local.json`,
and any existing helper scripts (e.g. a command-validator). The installer never
overwrites or removes files it did not place.

**Extended:** `~/.claude/settings.json` gains the MISHKAN hook registrations.
If a pre-existing `Bash` PreToolUse validator is present, the new security hook
chains alongside it rather than replacing it.

**Leveraged:** if the project provides its own ops specialist agent, the Migdal
and Mishmar teams reference it for environment-specific operational knowledge.

---

## D-005 — MISHKAN is a distributable npm package (added 2026-05-27)

**Decision:** MISHKAN ships as an npm package (`mishkan-harness`) installed via a
**dependency-free `npx` one-shot installer** (`npx mishkan-harness install`). The
installer **copies** the payload into `~/.claude/mishkan` (not symlinked to
node_modules), creates relative symlinks for agent/skill/command discovery, and
merges hooks into `~/.claude/settings.json` with paths resolved from
`os.homedir()` at install time.

**Rationale:** the harness must be portable and shareable, not bound to one
machine. The earlier hand-placed build hardcoded absolute paths (`/home/ogu/...`)
in settings.json and `projects.yaml`. The installer removes all machine-binding.

**Implications:**
- **Zero npm dependencies** in the installer — a security-first harness must not
  carry supply-chain risk, and Mishmar's own rules flag postinstall scripts, so a
  no-deps `npx` installer is the only consistent choice.
- Package layout: `bin/mishkan.js` (installer), `payload/mishkan/` (→ `~/.claude/mishkan`),
  `payload/user/` (→ user-level `CLAUDE.md` + `rules/`, placed only if absent),
  `payload/install/settings.hooks.json` (hook fragment with a `{{MISHKAN}}`
  placeholder resolved at install), `docs/engineer/` (canonical profile).
- Install is **idempotent** and **non-clobbering**: never overwrites a user's
  `CLAUDE.md`, `rules/y4nn-standards.md`, or any real (non-symlink) agent/command.
- `uninstall` removes the harness, its symlinks, and its hooks while preserving
  user-level files (`--purge` to also remove the user rule).
- `projects.yaml` is **discovery-based** (env / workspace-root / git-repo scan),
  carrying no hardcoded paths.
- Verified: full install→status→uninstall cycle in a throwaway `$HOME` with zero
  source-machine path leakage.

## D-006 — Engineer profile is canonical, replaceable, and propagated (added 2026-05-27)

**Decision:** the engineer the harness serves is described in
`docs/engineer/profile.md` — a single, replaceable source of truth. The runtime
load path is the generic `~/.claude/mishkan/profile.md` (not a person-specific
filename), so any engineer can adopt the harness by replacing one file.

**Propagation is two-layer:** `scripts/sync-profile.sh` does the mechanical
copy + reference/drift audit; **Seraiah** (Sefer org-layer agent) owns the
semantic re-derivation of digests drawn from the profile (the user-level
`CLAUDE.md` non-negotiables, engineering-identity docs) when it materially changes.

## D-007 — Curated library is a separate cognee store from project knowledge (added 2026-05-28)

**Decision:** the cross-project **curated library** lives in its own isolated
cognee store (`mishkan-curated-*`, MCP alias `cognee-curated`, port 7730),
physically separate from the **work** store that holds per-project knowledge
(`mishkan-cognee-*`, MCP alias `cognee`, port 7777). A project's `.mcp.json`
declares both: `cognee` (read+write its own graph) and `cognee-curated`
(read-only reference). The per-client memory dataset (`<client>_memory`, e.g.
`claude_code_memory`) is a legitimate part of the work store — never pruned.

**Why physical, not logical:** project ingestion pulls in code and data that can
include PII (the aiobi-mail test ingested real Gmail addresses), and with
`ENABLE_BACKEND_ACCESS_CONTROL=false` all datasets share one Neo4j graph — so
logical dataset tags alone leave them commingled in one store and one UI. Neo4j
Community allows only one database per instance, so true graph isolation requires
a separate Neo4j container. The curated box reuses the shared Ollama and the
shared Postgres *server* (own database `curated_db`) to keep the cost to one
small extra Neo4j. The curated library is small and regenerable
(`seed-curated-library.sh` → the curated box), so the split is cheap to maintain.

**Embeddings caveat (inherited):** the curated box embeds via **local Ollama** —
bulk seeding bursts embedding calls and cloud free-tier embeddings 429
(RESOURCE_EXHAUSTED).

## D-008 — Three-layer memory epistemology: structure / project semantics / curated cross-project (added 2026-06-05)

**Decision:** MISHKAN's knowledge surface is split into **three physically
separate stores**, each owning one epistemic question, with no overlap of write
authority:

| Store | Question it answers | Source of truth | Write authority |
|---|---|---|---|
| **Graphify** (per-project, local artifacts) | *How is the code structured?* — call graphs, dependents, god nodes, schema-to-code edges, file-to-symbol provenance | tree-sitter AST + optional LLM enrichment, deterministic, re-derivable from the repo | the build (`graphify` CLI), no agent writes by hand |
| **Cognee work** (`:7777`, `cognee` MCP) | *Why does this code exist? what did we decide? what did we learn on this project?* | curated project artifacts (PRD, SRS, ADRs, sprint reports, agent learnings) ingested via `mishkan-ingest` | agents, gated by `mishkan: ingest` frontmatter |
| **Cognee curated** (`:7730`, `cognee-curated` MCP, read-only from projects) | *What have we learned across all projects?* | promoted cross-harness knowledge, reference library | `/sprint-close` + `seed-curated-library.sh`, only |

Graphify v0.8.31 (MIT, [github.com/safishamsi/graphify](https://github.com/safishamsi/graphify))
joins the stack as a **third store**, not as a Cognee feeder, not as a Cognee
replacement.

### Force-tension

**What pushes toward a third layer.** Structural questions ("who calls
`apply_overlay`?", "what depends on `models.User`?", "where are the god nodes?",
"what tables does this service read?") are answered today by repeated grep and
file reads, which is exactly the failure mode the engineer profile names: token
waste, context bloat, and answers that drift because they reconstruct structure
from prose instead of reading it from the AST. Graphify gives a deterministic
graph, locally extracted, re-derivable from the repo at any time — the *opposite*
epistemic shape from Cognee work, which is a curated, lossy, LLM-summarised
narrative of decisions. Conflating the two in one store has already been rejected
once (D-007 separated curated from work for the same reason: different write
discipline, different trust shape).

**What pushes back.** Three stores is one more runtime, one more failure mode,
one more place for an agent to look in the wrong order. Graphify is a young
project (v0.8.x, ~10 weeks old at this writing) with a credible breaking-change
risk. Cognee already has a code-extraction notion (`codify`); adding Graphify
risks duplicating capability the harness already paid for. The boundary between
"structure" and "semantics" is not always crisp ("why does this function call
`Y`?" is both).

The tension resolves toward the split: the *write discipline* is what matters,
and the three stores have three different write disciplines (deterministic build
output / curated agent ingestion / cross-harness promotion). Collapsing any two
of them collapses one discipline into another and loses the property D-007 was
introduced to protect.

### Alternatives considered

1. **Keep only the two Cognee stores (status quo).** *Bad.* Structural questions
   stay grep-shaped — high token cost per question, answers that miss
   transitive edges and god-node patterns by construction. Cognee `codify`
   produces an LLM-summarised view of code, not a deterministic call graph: it
   is the wrong tool for "who depends on X" and was never meant to be that tool.
   Leaves the engineer's documented complaint about token waste unaddressed.

2. **Add Graphify as a third store with a hard write-discipline boundary.**
   *Chosen.* Each store answers one question, each has one writer, agents
   consult them in a documented order (Graphify first for structure, Cognee
   work for rationale, Cognee curated for cross-project precedent). Mirrors
   D-007's logic: physical separation when write discipline differs.

3. **Make Graphify a pre-processor / feeder into Cognee work.** Rejected.
   Graphify's value is that the graph is *deterministic and re-derivable* —
   pushing it through Cognee's LLM extraction layer destroys both properties.
   The output would be a lossy paraphrase of a graph that was exact, ingested
   into a store optimised for semantics not topology. It would also entangle
   Graphify's update cycle (per-commit) with Cognee's ingestion cycle (curated,
   sparse), forcing one to the cadence of the other.

4. **Substitute Cognee with Graphify entirely.** *Bad — door explicitly closed.*
   Graphify does not hold decisions, rationale, sprint reports, agent learnings,
   or the curated cross-project library. Replacing Cognee with Graphify would
   delete the "why" layer to gain a "how" layer. The two are orthogonal, not
   competing.

5. **Defer Graphify and re-evaluate after a measurement POC.** Rejected as the
   primary path because the write-discipline argument is independent of any
   token-saving number: even if Graphify saved zero tokens, the deterministic
   structural graph still belongs in its own store. A measurement POC is still
   useful but is out of scope here (see below).

### Invariants of boundary (the routing matrix agents follow)

- **Structure → Graphify.** "Who calls X", "what depends on Y", "god nodes",
  "files touching table Z", "transitive dependents of module M", "what does
  this file import / export". Deterministic; re-derivable; cite the graph node
  id.
- **Project rationale / decisions / learnings → Cognee work.** "Why did we
  choose X over Y", "what did sprint S3 conclude on auth", "what did Hizkiah
  learn about the embedding 429 issue". Curated; cite the ingested artifact.
- **Cross-project reference → Cognee curated.** "How have we handled rate
  limiting elsewhere", "what does the engineer profile say about commit
  format". Read-only from projects; cite the curated node id.
- **Ambiguous questions ("why does this function call Y?")** decompose into a
  structure half (Graphify: it calls Y at file:line, via path P, in branch B)
  and a semantics half (Cognee work: ADR D-00x decided that B owns Y because
  reasons). Agents answer both halves explicitly; they never fuse them into
  one store.
- **Write authority is exclusive.** No agent writes to Graphify (only the
  `graphify` CLI does, on its update trigger). No build process writes to
  Cognee work (only agents do, gated by `mishkan: ingest`). No project writes
  to Cognee curated (only `/sprint-close` and the seed script do).

### Integration

- **Runtime placement.** Graphify runs **per-project**, artifacts live under
  `.graphify/` in the project (`graph.html`, `GRAPH_REPORT.md`, `graph.json`),
  gitignored by default. No shared service, no port. The Neo4j export
  (`--neo4j-push`) targets a **dedicated Graphify Neo4j container** when used —
  it does **not** share the Cognee work store's Neo4j (port 7687 in that
  container is Cognee's; collision would commingle a deterministic AST graph
  with an LLM-summarised semantic graph, the exact conflation D-008 forbids).
  Most agent queries hit `graph.json` directly; Neo4j is opt-in for cross-repo
  graph queries and not part of the default install.
- **Re-extraction trigger.** Incremental refresh via `graphify --update` runs:
  (a) on a **post-commit hook** when files in `src/`, `lib/`, or
  language-specific source roots change, and (b) on `/sprint-close` as a
  belt-and-braces full re-extract. No cron — the engineer's stateful-operation
  rule applies: AI prepares the command, Y4NN runs it (the post-commit hook is
  local to his machine, run by his shell, not by an agent).
- **Agent consult order (PreToolUse hook).** Graphify ships a PreToolUse hook
  that nudges Claude Code toward graph-first queries. The MISHKAN integration
  is **deferred to a follow-up ADR** (see Out of Scope) — landing it requires
  threading through the existing Bash PreToolUse validator chain (D-004) and
  per-agent opt-in for the five code-writing specialists (Hizkiah, Salma,
  Oholiab, Nathan, Zadok). The hook is *available* but *not enabled by default*
  in this decision.
- **Citation discipline.** When an agent answers from Graphify, it cites the
  graph node id and the source `file:line`. When it answers from Cognee work,
  it cites the ingested artifact. No "according to the graph" without an id.

### Out of scope (explicitly not decided here)

1. ~~**Token-saving measurement POC.**~~ **CLOSED 2026-06-07** —
   POC executed on the MISHKAN harness with Graphify v0.8.33: **88.1×
   average reduction** across the 5 canonical structural questions
   (range 69.4× to 141.8×). The third-party 71.5× claim is **verified**
   in spirit — MISHKAN's actual measurement is +23 % higher (likely
   driven by Python-heavy AST shape vs the mixed TS corpora of the
   third-party benchmark). Full method, query-by-query results, and
   honest gaps in `docs/research/graphify-token-saving-poc.md`. The 88.1×
   figure may be cited as a MISHKAN claim. The 71.5× figure may be cited
   as a third-party point reference within the observed range.
2. **Refactor of the Explore agent / Hiram's exploration playbook.** Whether
   Hiram should consult Graphify before grep is a downstream agent change,
   not decided here.
3. **Unified Graph Explorer UI** combining Graphify's `graph.html` and
   Cognee's Neo4j browser. Not decided; each store keeps its own UI.
4. **Graphify PreToolUse hook enablement and routing.** Whether and how the
   hook fires for the five code-writing specialists, and how it composes with
   the existing Bash PreToolUse chain, is deferred to a follow-up ADR.
5. **Cognee `codify` deprecation.** Whether Cognee's own code-extraction
   feature is now redundant in MISHKAN given Graphify is not decided here —
   it stays available; `mishkan-ingest` continues to gate its use.
6. **Cross-project Graphify federation** (one graph across all projects in
   `projects.yaml`). Not in scope; Graphify is per-project for now.

### Consequences

**Positive.**
- Code-writing specialists (Hizkiah, Salma, Oholiab, Nathan, Zadok) get a
  deterministic structural answer for "who calls X" / "what depends on Y"
  without grep-shaped token spend.
- Write discipline stays sharp: three stores, three writers, three citation
  shapes. No agent has to guess where to write.
- Cognee work stays small and curated — it does not get polluted with
  AST-derived nodes that change on every commit.
- Graphify artifacts are re-derivable from the repo, so the third store has
  effectively zero backup obligation: delete `.graphify/` and rebuild.
- The boundary is testable: a CI check can refuse a commit that ingests
  AST-shaped content into Cognee work.

**Negative.**
- One more runtime to install, document, and teach 45 agents to route to.
- Graphify v0.8.x is young; a breaking change in node schema or CLI flags
  would touch every agent that cites a graph node id. Mitigation: cite by
  `file:line` alongside node id so the answer survives a schema change.
- The "structure vs semantics" line is not always crisp; some questions
  require both stores and a careful answer. Documented in the routing
  matrix above, but it adds cognitive load.
- The Neo4j-push path introduces a second Neo4j container if enabled —
  more memory, more secrets to manage. Mitigation: keep it opt-in; default
  is `graph.json` only.
- The deferred PreToolUse hook means agents must be *told* to consult
  Graphify first; the harness does not enforce it until the follow-up ADR
  lands.

**Supersedes / amends:** none. Extends D-001 (Cognee local Docker) and D-007
(curated vs work split) by adding a third epistemic layer on the same
discipline.

## D-009 — Graph-first PreToolUse gate for the five code-writing specialists (added 2026-06-05)

**Decision:** introduce a MISHKAN PreToolUse hook — `pre-tool-knowledge-route.py` —
that, for **exactly the five code-writing specialist agents** (Hizkiah, Salma,
Oholiab, Nathan, Zadok), runs alongside the existing security (D-004) and
model-routing hooks and **advises** — does not block — when a `Read` or `Grep`
call on source code looks like a structural query that Graphify (D-008) could
have answered deterministically. The hook is **advisory** (soft gate), not
hard-deny: it injects a permissionDecisionReason nudge plus, where supported, a
concrete `graphify search` command into the tool input metadata, but always
returns `allow`. Conformance is measured via the existing PostToolUse observer
chain; the gate **never** refuses the underlying tool call.

### Force-tension

**What pushes toward enforcement.** The five named agents are the harness's
heaviest token consumers — Hizkiah and Salma in particular routinely Read 6–10
files to answer "who calls X" or "what depends on Y", which D-008 just declared
the wrong store for that question. Without a runtime mechanism, the D-008
routing matrix is doctrine on paper that drifts the moment an agent is mid-task
and reaches for the familiar tool. The whole reason D-008 exists is to make
structural queries deterministic; leaving the enforcement at "we told them to"
collapses the discipline into a code-review aspiration.

**What pushes against a hard gate.** Three failure modes make hard-deny costly:
(a) the project may not yet be scanned (first run, fresh clone) — denying Read
would brick the agent until Y4NN runs `graphify`, violating the stateful-
operation contract that says AI prepares but does not execute scans; (b) the
graph can be stale (HEAD has moved since the last `--update`), so the agent's
correct move is to Read the source of truth, not the cached graph; (c) the
heuristic for "this query is structural" is necessarily fuzzy — a query like
"how does this function handle errors" is semantic and Graphify is the wrong
store for it. A hard gate would generate false-positive blocks on cases (a),
(b), and (c), creating the exact friction the engineer profile names as a
top complaint with AI tooling.

The tension resolves toward **soft gate + telemetry**: the hook nudges and
records, never blocks. If telemetry shows ≥80% of code-writing Reads now
preceded by `graphify search` after one sprint, the doctrine is working without
enforcement. If it does not, a future ADR can revisit hardening.

### Alternatives considered

1. **Hard gate — deny Read/Grep when no `graphify search` was observed in the
   agent's session within the last N tool calls.** *Bad.* Brittle on first-scan,
   stale-graph, and semantic-query cases; turns a coordination problem into a
   runtime block; violates the asymmetric-delegation contract by effectively
   forcing the agent to ask Y4NN to run a scan mid-task.

2. **Soft gate — advisory injection on suspected structural queries; always
   allow.** *Chosen.* Surfaces the doctrine at the exact moment it would
   otherwise be skipped, names the concrete command (`graphify search <symbol>`),
   and degrades gracefully when the graph is absent or stale. Composes cleanly
   with the existing Bash PreToolUse chain (D-004) and the Python model-routing
   hook because all three already follow the fail-open-on-error contract.

3. **Silent telemetry only — count the conformance ratio in the PostToolUse
   bus, no advisory in the prompt.** *Useful, but insufficient alone.* Without
   the in-prompt nudge, the agent has no feedback signal mid-task; the ratio
   would document drift rather than reduce it. Adopted as **phase 1**: ship the
   telemetry first (single sprint), then layer the advisory nudge on top once
   the baseline is measured. The full soft-gate behaviour is the **phase 2**
   target documented here.

4. **Skill-only doctrine — encode "graphify first on structural queries" in the
   five craft skills (`hizkiah-backend-impl-craft.md` etc.) and rely on agents
   to follow it.** *Insufficient.* The harness already has the precedent
   (D-004 PreToolUse security) that doctrine without a mechanism drifts;
   skills inform behaviour, hooks enforce shape. Adopted **alongside** the
   hook, not as a substitute.

5. **Expand the gate to all 45 agents.** Rejected as scope creep. The QA,
   reporter, research, and orchestration agents do not write code and rarely
   ask structural questions; gating them adds noise without changing behaviour.
   Expansion to Hiram (Explore) is the obvious next candidate but is deferred
   to the Explore-refactor ADR (D-008 Out of Scope #2).

### Invariants of the gate

- **Scope — exactly five agents.** The hook activates only when the invoking
  subagent is one of: **Hizkiah, Salma, Oholiab, Nathan, Zadok**. For any
  other agent (including Hiram, Caleb, all QA/reporters/orchestrators), the
  hook is a no-op. Adding an agent requires a new ADR.
- **Trigger condition (precise).**
  - **`Read`** on a file whose extension matches the Graphify-supported set:
    `.py .ts .tsx .js .jsx .mjs .cjs .go .rs .java .php .rb`. Configs,
    Markdown, YAML, lockfiles, and dotfiles are **not** triggers.
  - **`Grep`** when the `pattern` is a bare identifier (matches
    `^[A-Za-z_][A-Za-z0-9_]*$`) — i.e. clearly a symbol lookup, not a
    semantic regex. Patterns with `.*`, alternation, multiline, or non-word
    characters do **not** trigger.
  - **Explore** tool calls are out of scope (deferred ADR).
- **Fallback behaviour (graceful degradation).**
  - *No `.graphify/graph.json` in the project* → emit a single advisory line
    "Graphify not yet scanned for this project; ask Y4NN to run `graphify`
    (stateful op). Falling back to Read is correct for now." and `allow`.
  - *Graph stale* (`graph.json` mtime older than the most recent commit on
    HEAD) → emit "Graphify graph is older than HEAD; structural answer may
    be stale, prefer Read+cite for changes after `<sha>`." and `allow`.
  - *Trigger heuristic likely wrong* (the agent has already issued a
    `graphify search` in this session for a related symbol) → no nudge,
    silent allow. The PostToolUse counter still records the read.
- **Opt-out path.** Two mechanisms, in order of normalcy:
  1. Per-tool-call: a `tool_input.metadata.skip_graphify_nudge: true` field
     suppresses the advisory for that single call. Used when an agent has
     explicitly decided the query is semantic.
  2. Session-wide: env `MISHKAN_GRAPHIFY_NUDGE=off` disables the hook
     entirely (Y4NN debug escape). Recorded in the session-start observer
     so disablement is visible in sprint reports.
- **Performance budget.** The hook must add **≤ 50 ms p95** to PreToolUse
  latency. Implementation must avoid invoking `graphify search` itself
  inside the hook — it inspects `graph.json` metadata (mtime, presence)
  and the tool input shape only. If the hook exceeds 200 ms on any call,
  it self-disables for the remainder of the session and logs to the
  PostToolUse observer ("graphify nudge self-disabled: budget exceeded").
- **Fail-open contract.** Identical to D-004 and to `model-route.py`: any
  parse, IO, or format error → emit nothing, exit 0, never block.
- **Conformance metric.** Two numbers, recorded by `post-tool-observe.sh`
  per session and aggregated at `/sprint-close`:
  1. **Nudge-respect ratio** — of the Read/Grep calls that triggered an
     advisory, the fraction followed by a `graphify search` within the
     next 3 tool calls of the same agent.
  2. **Pre-Read graph consultation rate** — of all triggering Read/Grep
     calls by the five agents, the fraction preceded by **any**
     `graphify search` in the same session. Target ≥ 80% after one
     sprint of phase-2 operation.
  Both metrics are reported, neither is a gate.

### Integration

- **Hook file.** `payload/mishkan/hooks/pre-tool-knowledge-route.py`,
  registered alongside `pre-tool-security.sh` and `model-route.py` in the
  PreToolUse chain. Order: security (deny on violation) → model-route
  (inject model) → knowledge-route (advise). Each is independent and
  fail-open; chain order is for clarity, not correctness.
- **Subagent detection.** Reuses the same `subagent_type` field
  `model-route.py` already reads from `tool_input`. When the field is
  absent (top-level Claude Code session, not a subagent), the hook is a
  no-op — Y4NN is not in scope of the gate.
- **Advisory shape.** The hook returns
  `hookSpecificOutput.permissionDecision = "allow"` with a populated
  `permissionDecisionReason` quoting the exact `graphify search` command
  to try first. The agent sees the reason; nothing is enforced.
- **Phase 1 (this sprint).** Ship the hook in **telemetry-only mode**:
  trigger detection runs, metrics are recorded, no advisory text emitted.
  Establishes the baseline number for "how often do the five agents
  already consult Graphify before Read?".
- **Phase 2 (next sprint, conditional on phase-1 baseline).** Enable the
  advisory text. Re-measure. If nudge-respect ratio < 50% after one sprint,
  open a follow-up ADR — do not unilaterally promote to hard gate.

### Out of scope (explicitly not decided here)

1. **Token-saving measurement POC** (the 71.5× figure) — still separate, as
   in D-008 Out of Scope #1. The conformance metric here is behavioural
   (did the agent consult the graph?), not economic (how many tokens did
   it save?).
2. **Refactor of the Explore agent / Hiram's exploration playbook** —
   deferred per D-008 Out of Scope #2. The gate explicitly excludes
   Explore tool calls.
3. **Unified Graph Explorer UI** — out of scope, per D-008.
4. **Adding further agents to the gate** (e.g. Hiram once refactored, or
   any future code-writing specialist) — requires a new ADR amendment.
5. **Cognee-work consultation gate** — a symmetric soft-gate for semantic
   queries ("have we decided this before?") that would nudge toward
   Cognee MCP before a freeform reasoning answer. Plausible and consistent
   with the D-008 routing matrix, but not decided here. If pursued, it
   would follow this ADR's shape (advisory, fail-open, telemetry-first).
6. **Incremental re-extract on commit** — D-008 Out of Scope. The stale-
   graph fallback above accommodates the absence of incremental refresh;
   it does not commit the harness to provide one.
7. **Hard-deny mode** — explicitly deferred. The phase-2 advisory is the
   strongest enforcement this ADR sanctions. Any future hardening is a
   separate, dated decision.

### Consequences

**Positive.**
- The D-008 routing matrix gains a runtime mechanism for its highest-
  traffic edge (structural queries by code-writing specialists), without
  introducing a friction failure mode the engineer profile rejects.
- Telemetry-first phasing means the harness measures before it constrains;
  the phase-2 decision will be grounded in a baseline, not a guess.
- Fail-open contract preserves the property all MISHKAN hooks share: a
  broken hook never bricks delegation.
- Composable with the existing PreToolUse chain (D-004 security,
  model-route) without rewriting any of them; each hook stays small and
  inspectable.

**Negative.**
- One more hook to maintain, with its own heuristic surface (extension
  list, regex for "bare identifier", stale-graph detection). Each is a
  small calibration debt — false-positive nudges on semantic queries
  will accumulate small annoyance until the advisory wording is tuned.
- The stale-graph fallback depends on file mtime vs. HEAD commit time,
  which is approximate; an agent could pull a graph from a sibling
  checkout and have a wrong mtime [UNKNOWN — to verify in implementation
  whether this corner case warrants a content-hash check].
- Phase-2 enablement creates a sprint-boundary coordination point: the
  decision to flip the advisory on depends on phase-1 telemetry being
  reviewed, which is a `/sprint-close` agenda item that did not previously
  exist.
- The 50 ms p95 budget is tight for Python startup on cold cache;
  implementation may need to be a small Bash inspector instead, mirroring
  `pre-tool-security.sh`'s shape. [UNKNOWN — measure cold-start cost of
  the Python interpreter on Y4NN's machine before committing to language.]
- Documents an opt-out (`MISHKAN_GRAPHIFY_NUDGE=off`) which, like every
  opt-out, can become a habit that erodes the discipline. The session-
  start observer logging is the partial mitigation; review at
  `/sprint-close` is the rest.

**Supersedes / amends:** none. Extends D-008 (Graphify as third store) by
providing the runtime mechanism D-008 explicitly deferred (D-008 Out of
Scope #4). Composes with D-004 (existing PreToolUse Bash chain) without
modifying it.

## D-010 — Workflow portfolio discipline: four anti-patterns, two caps, PM+CTO co-ownership (added 2026-06-07)

**Decision:** the dynamic-workflow portfolio is governed by an explicit
discipline rather than ad-hoc accretion. Three rules together: (a) **hard
caps** — 10 top-level (org) workflows + 4 team workflows per team; (b) **four
named anti-patterns** that disqualify a candidate; (c) **PM + CTO joint
ownership** — every addition, retirement, or substitution goes through
Nehemiah and Bezalel together, never through a single agent's unilateral push.
A fire-count rule retires workflows that fire < 2× across 3 sprints, gated by
the same PM+CTO review.

### Force-tension

**What pushes toward accretion.** Workflows are the most powerful primitive
the harness exposes — typed contracts, parallel fan-out, adversarial verify
panels. Every recurring task looks like a candidate. Each team has 5–7
specialists, so "one workflow per team's main shipping flow" feels natural.
Six team-ship workflows × six teams + the 10 org-level = a portfolio of 46.
Without a cap, that is the asymptote: most workflows fire once, contribute
nothing, and add maintenance debt.

**What pushes against.** Workflow runtime cost is real (Bun-shape migrations
hit hundreds of agents and thousands of subagent-tokens per run). Each
workflow carries a contract surface that must be kept correct as agents
evolve. Workflows that fire rarely cannot pay back their codification cost.
Worse, workflows that look load-bearing but encode skill-shape (linear
sequence, no panel, no termination predicate) blur the distinction between
workflow and skill, eroding the discipline that makes the workflow tool
worth reaching for.

### Adopted shape

**(a) Hard caps.**

- **10 org-level workflows.** Current: `mishkan-sprint-close`,
  `mishkan-deep-research`, `mishkan-codebase-audit`, `mishkan-migration-wave`,
  `mishkan-architecture-panel`, `mishkan-release-readiness`, `mishkan-init`,
  `mishkan-blast-radius`, `mishkan-knowledge-gap-discovery`,
  `mishkan-standards-rollout`. Adding an 11th forces a retirement vote.
- **4 team-level workflows per team.** Current shipped count varies by team
  (Chosheb 1, Panim 2, Yasad 3, Mishmar 1, Migdal 2, Sefer 1). Spare slots
  per team are deliberately left open — candidates compete for them at
  PM+CTO review, not on a team lead's word.

**(b) Four anti-patterns.** A candidate that exhibits any of these is rejected
or reworked, regardless of fit:

1. **Skill-in-workflow-clothing.** Linear sequence, no parallelism, no
   termination predicate, no panel. That shape is a skill, not a workflow.
   If the cost-to-fan-out gain is < 2× wall-clock vs Task delegation, it
   does not earn the workflow tool.
2. **Workflow calling workflow without a contract.** Nested workflows are
   valid (cf. `release-readiness` → `codebase-audit`) **only** when the
   inner workflow's output schema is consumed structurally by the outer.
   Free-form nesting hides token cost, breaks retry semantics, and produces
   an opaque blob of subagent transcript that the orchestrator cannot
   reason over.
3. **Judge panels with non-orthogonal reviewers.** If two reviewers in a
   panel share ≥ 70% of their evaluation criteria, the panel is theatre —
   redundant votes from correlated judges. Each lens must be load-bearing
   and distinct (the canonical example is `mishkan-blast-radius`'s
   caller-side / data-contract / runtime-behavior triad).
4. **Workflow-as-status-page.** Orchestration that fans out to gather state
   without synthesis is a dashboard query, not a workflow. The synthesis
   stage is the workflow's reason to exist; if it is missing or trivial,
   the work belongs in observability, not in `Workflow()`.

**(c) PM + CTO joint ownership.** New workflow proposals are written as a
brief (problem, fan-out shape, termination predicate, expected fire-count,
anti-pattern self-check). Nehemiah owns delivery / recurrence justification;
Bezalel owns orchestration shape / schema contracts. Joint approval lands
the workflow under `payload/mishkan/workflows/`; unanimous rework lands it
under `payload/mishkan/workflows/proposed/` with the rework note; rejection
returns the brief to its proposer with the failing anti-pattern named.

**Soft-retirement rule.** A workflow that fires < 2 times across 3 consecutive
sprints surfaces in the next `/sprint-close` for PM+CTO review. The default
disposition is retirement to `proposed/`; the rebuttal is a concrete
upcoming-use justification.

### Alternatives considered

1. **No cap; allow accretion.** *Rejected.* This is the default state of every
   ungoverned workflow portfolio in the wild. The reference cases (OneRedOak,
   Bun-shape) show that production teams converge on 3–6 workflows after
   accretion; the cap codifies that ceiling rather than letting the harness
   relearn it under load.

2. **Per-team unilateral additions, no PM+CTO review.** *Rejected.* Without
   a joint gate the four anti-patterns reappear — every team adds the
   workflow that feels load-bearing from their vantage point, and the
   harness ends up with six near-identical feature-ship orchestrations.
   The June 2026 portfolio review surfaced exactly this drift (Sefer
   proposed two doc-generation workflows; both folded into skills under
   the gate).

3. **Workflow router that auto-selects per task.** *Deferred.* Selecting
   among 18 workflows by task description is the same problem as skill
   discovery (cf. `mishkan-skill-discovery`). Layering a router on top of
   workflows duplicates that infrastructure. Wait for the skill-discovery
   layer's telemetry before deciding whether workflows need their own
   router or can be discovered through the same surface.

4. **Cap of 6 org-level + 6 team workflows.** *Rejected after PM/CTO split
   verdict.* Bezalel preferred 6 load-bearing org-level; Nehemiah preferred
   10 with retirement-based pruning. Adopted 10 because the existing
   portfolio already contains 10 that pass the anti-pattern check; cutting
   to 6 would retire workflows that clear the bar by lottery, not by
   discipline. The retirement rule is the steady-state pressure.

### Invariants of the discipline

- **Org-level cap = 10.** Always. To add, retire.
- **Team-level cap = 4 per team.** Always. To add, retire from that team.
- **Anti-pattern self-check** is part of the proposal brief — proposer
  must name how the workflow avoids each of the four.
- **No solo additions.** Even Bezalel cannot land a workflow alone; the
  rules-rollout workflow exists precisely to prevent that drift.
- **`proposed/` is not a parking lot.** Workflows there carry a written
  promotion criterion (concrete fire-count, named use case).

### Consequences

**Positive.**
- The portfolio stays legible. An engineer (or new agent) can read all 18
  in an afternoon and know what each is for.
- The cost ceiling is bounded. Worst-case spend is the sum of 18 known
  shapes, not an unbounded sprawl.
- The anti-pattern catalogue gives proposers concrete language for self-
  review before bringing a brief, shortening the loop.
- The PM+CTO gate replays the same discipline used for architecture (D-002,
  D-007) — consistency across the harness's governance surfaces.

**Negative.**
- Some legitimate one-off orchestrations will fail the cap and have to wait
  for a retirement slot. The escape valve is `proposed/` — the work is not
  lost, just not active.
- The fire-count rule is approximate; a workflow that fires 1× per sprint
  but is genuinely load-bearing (e.g. quarterly audit) will trip the
  retirement default and need to argue itself back each time. Tuned by
  raising the window from 3 sprints to N if false-retirements appear.
- "Anti-pattern self-check" relies on the proposer's honesty about their
  candidate; a determined push can word-paint around it. Mitigation: the
  CTO half of the gate has explicit authority to reject on shape.

### Amendment (2026-06-10) — loop-until-QA-passes feature-ship workflows

**Trigger.** The engineer observed that the designed Lead → Specialist → QA
collaboration was not enforced in practice — the main session dispatched
specialists directly and self-graded, bypassing the chain, with no loop driving
work to a QA-clean state. The remedy is two-layer: a cross-cutting discipline in
`team-lead-craft` §6.1 (all six teams), and a deterministic, unskippable workflow
form where stakes justify it.

**Portfolio change (PM + CTO joint brief).**

- **Two NEW team workflows:** `yasad-feature-ship`, `panim-feature-ship`.
- **Three AMENDED workflows** gain a bounded retry loop in place (no new slot):
  `chosheb-feature-ship` (loop-until-ready), `mishmar-security-gate` and
  `migdal-infra-change` (conservative — one remediation-proposal cycle then
  escalate). Sefer is covered by the discipline layer only (no product to gate —
  a workflow there would be anti-pattern #4).

**Brief, per the proposal format.**

- *Problem.* The chain is bypassable; QA convergence is not enforced.
- *Fan-out shape.* `route → implement → parallel orthogonal QA panel →
  loop-until-zero-blockers (cap 3; 1–2 conservative for security/infra) →
  escalate`. ≥6 agents across panel × cycles.
- *Termination predicate.* Zero `blocker`-severity findings (keys off the
  existing structured QA verdicts — Uriah/Jahaziel agent contracts and the
  existing workflow `{ready}`/`{decision}`/`{safe}` fields; no new contract).
- *Expected fire-count.* High — once per shipped feature on the active team;
  comfortably clears the ≥10/quarter bar.
- *Anti-pattern self-check.* #1 cleared (termination predicate + parallel panel,
  not a linear skill); #2 cleared (no nesting); #3 cleared (panels are
  orthogonal — contract/tests/data; a11y/DS/QA; the panel excludes the
  implementer so no lens self-reviews); #4 cleared (synthesis is a QA-clean
  artifact or a structured escalation).

**Caps after this amendment.** Team-level total 8 → 10. Per-team: Yasad 3/4,
Panim 2/4; Chosheb/Mishmar/Migdal/Sefer unchanged (amendments use no new slot).
All within the 4/team cap.

**Loop-until-X is no longer single-use.** This supersedes the earlier framing
(`workflows/README.md`) that `knowledge-gap-discovery` was the only legitimate
loop-until-X. Bounded QA-convergence is now a sanctioned second case; the bound
(hard cycle cap + mandatory escalation, never silent settle) is what keeps it
inside the discipline. Security and infra loops are deliberately conservative:
no stateful op runs inside the loop (asymmetric delegation, rules §5).

**Supersedes / amends:** none. Codifies the discipline implicit in D-002
(Claude Code models only — capability discipline) and D-007 (separate stores
— epistemic discipline) onto the orchestration layer.

## D-011 — Universal skill-discovery layer (added 2026-06-07)

**Status:** adopted, Phase 1 canary.

**Context — the tension.** The harness now ships 40+ MISHKAN craft skills,
and the user surface adds dozens more (`~/.claude/skills/`, plugin-bundled,
project-local). When a task arrives, the main session cannot reliably
remember which skill applies — the list itself does not fit in working memory
without bloating context. Two failure modes compete:

1. **Reinvention.** The model improvises work that a skill already encodes,
   because the right skill was never surfaced. This is the silent failure —
   no error, just degraded output.
2. **Context bloat.** The model loads too many skills "just in case",
   spending tokens on dormant guidance that crowds out the work itself.

The tension is not "should we make skills discoverable" — it is *who* decides
which skills surface and *how much context* that decision consumes. D-010
governed workflow portfolio discipline by cap + anti-pattern self-check; the
same discipline applies one layer down, but the right instrument is a router,
not a cap (we *want* the long tail of installed skills, we just don't want to
pay for all of them at once).

### Alternatives considered

1. **TUI-only browsing.** *Rejected.* A `mishkan-skills browse` TUI is
   useful, but it puts the discovery cost on the engineer's reading time
   for every task. The model still wouldn't know which skill to mention
   in the first place, so the silent-reinvention failure mode persists.
   Kept as a Phase 2 nice-to-have, not the primary surface.

2. **Embedding-based matching.** *Rejected.* Local sentence-embedding
   model + cosine similarity would give better recall than TF-IDF on
   ambiguous queries. But: (a) it pulls in a model dependency (200MB+ at
   minimum) for a layer that runs in every session, (b) the inference
   latency is non-trivial at session boot, (c) the trigger-phrase match
   on `Use when…` lines already covers the common case because skill
   descriptions are written *for* matching. TF-IDF is the right fallback
   for the long tail. Revisit if miss-log analysis shows recurring
   semantic misses that token overlap cannot recover.

3. **MCP server.** *Rejected for Phase 1.* An MCP server for skill
   discovery would let other tools query the same index, but it adds a
   process to manage and a network surface. The Python-script + flat-file
   index has the same data shape with zero process overhead, and an MCP
   wrapper around it remains a free Phase 2 option once the index format
   stabilises.

4. **No discovery layer; keep the implicit reach.** *Rejected.* The
   forty-skill surface already exceeds what the model reaches reliably.
   The reinvention rate observed in sessions (anecdotal but consistent)
   was the trigger for this decision.

### Adopted shape

- **Universal indexer** (`payload/mishkan/scripts/skill-discovery-indexer.py`).
  Stdlib-only Python, scans four roots in precedence order:
  `~/.claude/mishkan/skills/` → `~/.claude/skills/` →
  `~/.claude/plugins/*/skills/` → `<repo>/.claude/skills/`.
  Output: single flat JSON at
  `~/.claude/mishkan/skill-discovery/index.json`.
  Each entry: `{name, source_path, origin, description, triggers,
  category, frontmatter_raw, sha256, indexed_at, mtime}`.
  Refresh triggers: install/update (full rebuild), session boot
  (`--stat-only` mtime sweep against `meta.last_scan`), manual
  `/mishkan-skills-reindex`. Stale entries (source_path gone) are dropped
  at routing time.

- **Router** (`payload/mishkan/scripts/skill-discovery-router.py`). Three
  matching mechanisms layered: (a) trigger-phrase weighted match
  (trigger = 3.0, description keyword = 1.0), (b) category prior
  (×1.5 multiplier when invoked from a workflow declaring
  `relevant_skill_categories`), (c) TF-IDF fallback when trigger pass
  yields < 3 results. Output: 3 buckets capped at 13 total —
  `must_load` ≤ 3, `should_consider` ≤ 5, `adjacent` ≤ 5.

- **Skill** (`payload/mishkan/skills/skill-discovery/SKILL.md`).
  Main-session-side. Tells the model how to interpret the 3 buckets
  and the trust asymmetry (mark, never auto-load, non-mishkan entries
  for stateful operations).

- **Slash commands.** `/skills` (invoke router on current task);
  `/mishkan-skills-reindex` (manual rebuild).

- **Phase 1 canary integration.** `mishkan-init` workflow declares
  `relevant_skill_categories` and runs a `SkillRouter` phase before PRD.
  Result is advisory and folded into Bezalel's signoff context. No
  other workflow is wired in Phase 1.

### Risks

1. **Context bloat from over-trusting `must_load`.** Mitigation: cap of 3,
   bias-rule in the skill (prefer should_consider over padding must_load),
   miss-log surfaces over-firing.
2. **Name collisions across roots.** Mitigation: precedence order at
   index time (mishkan wins); collisions recorded in
   `meta.collisions` rather than silently dropped.
3. **Trust asymmetry violations.** Mitigation: every non-mishkan entry
   carries an explicit `trust` warning; skill rule forbids auto-load
   of non-mishkan skills for stateful operations (D-002 / y4nn-§5).
4. **Stale index hiding real skills.** Mitigation: session-boot
   `--stat-only` sweep + drop-at-routing-time for dead `source_path`.
5. **Fail-closed makes the harness brittle.** Mitigation: the layer is
   fail-open end-to-end — indexer errors are per-skill skips, router
   exceptions return empty buckets, every miss is logged to
   `~/.claude/mishkan/skill-discovery/misses.jsonl` for tuning.

### Phase 1 → Phase 2 path

Phase 1 ships indexer + router + skill + slash commands + canary in
`mishkan-init`. Promotion to Phase 2 requires:

- **2 sprints of miss-log signal.** If the misses file shows recurring
  patterns the trigger-match cannot catch, tune `description` text on
  the implicated skills *before* reaching for embeddings.
- **Threshold validation.** Default thresholds (`high=4.0, mid=1.5`) are
  guesses on Phase 1 data; revisit at sprint close with the actual
  score distribution from the miss log and successful routings.
- **Broader workflow integration.** Once thresholds settle, add the
  `relevant_skill_categories` field + SkillRouter phase to the other
  org-level workflows that benefit (codebase-audit, release-readiness,
  knowledge-gap-discovery).
- **TUI browse surface** (optional). A `mishkan-skills` CLI that wraps
  the same index for cold-browsing without a task.
- **MCP wrapper** (optional). Exposes the router as an MCP tool so
  agents in other contexts (project-local subagents) can query the
  same surface.

**Supersedes / amends:** none. Layers under D-010 (workflow portfolio
discipline) one level down — the same discipline (cap + anti-pattern +
miss-log feedback) applied to the skill surface rather than the workflow
surface.

### Amendment 2026-06-07: Phase 2 shipped

Phase 1 ended at "the router exists." Phase 2 turns that into "agents
auto-discover skills without being asked," through three injection
mechanisms — none of them blocking, all fail-open.

1. **Install-time rebuild.** `bin/mishkan.js` install phase 1 spawns the
   indexer in `--rebuild` mode after the payload copy so
   `~/.claude/mishkan/skill-discovery/index.json` lands seeded before the
   first session boots. Fail-open: a missing `python3` or an indexer
   error logs a warning and the install continues; recovery path is
   `/mishkan-skills-reindex`.

2. **SessionStart drift check.** `hooks/session-start-skill-index.sh`
   runs the indexer in `--stat-only` mode on session boot. The indexer
   compares each SKILL.md mtime against `meta.last_scan` and rebuilds
   only on drift (or if the index file is missing). p95 budget: 200 ms,
   well within the SessionStart budget shared with the other boot hooks.
   Fail-open: any error → exit 0 silently.

3. **PreToolUse auto-injection on Task / Agent.**
   `hooks/pre-tool-task-skill-route.sh` reads the Task payload from
   stdin, extracts `tool_input.prompt`, runs the router in
   `--format injection` mode, and returns the resulting compact markdown
   block via `hookSpecificOutput.additionalContext` (the documented
   Claude Code PreToolUse field for prepending advisory context). Hard
   caps: ≤ 3 `must_load` + ≤ 3 `should_consider` entries, ≤ 600 tokens
   of prepended markdown, `adjacent` dropped at injection time
   (awareness-only doesn't justify its tokens here). Skip injection
   entirely on empty buckets — never pollute with "no skills found".
   p95 budget: 100 ms (worst-case timeout: 1.5 s as a hard floor). The
   `mishkan-init` Phase 1 canary stays in place; this becomes the
   dominant path for every other Task call.

**Trust marker.** The injection renderer suffixes every non-`mishkan`
entry with `(community)`. The skill-discovery skill's existing rule —
non-`mishkan` skills are never auto-loaded for stateful operations
(D-002 / y4nn-§5) — applies unchanged.

**Telemetry.** Every Task hook invocation emits a `hook_fire` event on
the observability bus (decision = `allow` with injection, `ok` without).
Every empty-bucket routing continues to land in
`~/.claude/mishkan/skill-discovery/misses.jsonl`. A new aggregator
script `scripts/skill-discovery-misses.py` (and `/mishkan-skills-misses`
slash command) clusters misses by sorted-keyword signature and surfaces
top-N patterns + by-reason breakdown.

**Threshold-tuning process.** The mid + high thresholds remain
`mid=1.5, high=4.0` from Phase 1. Tuning is now data-driven:

- After each sprint, run `/mishkan-skills-misses --top 10`.
- For any pattern with count ≥ 5 *and* a clearly-applicable skill that
  should have matched, **edit the skill's description** to include the
  pattern's keywords. Description tuning is free and bounded; it should
  exhaust before threshold tuning.
- If a recurring pattern still misses after description tuning, *and*
  the scores are clustering just under the `must_load` boundary, lower
  `--threshold-high` to 3.5; if `must_load` is over-firing on
  marginally-relevant skills, raise it to 4.5. Move in 0.5 steps and
  one sprint at a time. Same recipe applies to `--threshold-mid`.
- `router_exception:*` reasons are bugs — escalate to Bezalel; never
  tune around an exception.

The Phase 1 → Phase 2 promotion gate ("2 sprints of miss-log signal")
applied to broadening to Phase 2 hook mechanics; the same 2-sprint gate
now applies to threshold tuning before any default is moved in the
shipped router.

## D-009 — Amendment 2026-06-07: Phase 2 advisory injection shipped

**Original D-009 §6.2** scoped Phase 1 to telemetry-only, with the
advisory injection deferred until "the baseline rate is measured." The
phase-2 promotion has happened.

**Why Phase 2 now.** The skill-discovery PreToolUse router (D-011
Phase 2) injects skill suggestions based on the Task prompt — it
matches "implement payment" to implementation skills, not to
`graphify-query-craft` whose triggers describe structural questions.
The router will not surface graphify for the vast majority of agent
dispatches; only a runtime hook on the specific tool calls Graphify
can answer (Read on source / Grep on bare identifier) closes that
gap. Without Phase 2, the carrier-set expansion in the §6 amendment
below has no enforcement path.

**Mechanism.** `pre-tool-knowledge-route.sh` now emits an
`hookSpecificOutput.additionalContext` advisory in addition to the
telemetry event:

- **Read** on a source extension → "about to Read `<file>`. For
  structural questions, `graphify query` is cheaper."
- **Grep** on a bare identifier → "`graphify query \"who calls X\"`
  or `graphify affected X --depth 2` is the dispatch-aware
  alternative."

Suppressed when the project has no `graphify-out/` directory (no graph,
no recommendation). Never sets `permissionDecision` — purely advisory,
the tool call proceeds whether the agent acts on it or not.

**Invariants preserved.**
- Fail-open everywhere (missing jq, missing bus, malformed input → silent exit 0).
- ≤ 50 ms p95 — bash hot path, single jq subprocess, no Python.
- Telemetry event still fires (the Knowledge tab's Graphify activity counter is unchanged).
- Trigger surface unchanged from Phase 1 — same source extensions, same bare-identifier Grep pattern.

**What this changes.** A Hizkiah / Salma / Joah / Ira / etc. who Reads
source or Greps an identifier now gets, in the tool-call context, a
specific `graphify` command to consider. The advisory is structurally
precise (suggests the right Graphify subcommand for Read vs Grep) and
project-aware (suppressed where graphify-out/ doesn't exist), so it
doesn't add noise on projects that don't use Graphify.

## D-009 — Amendment 2026-06-07: scope expanded to all code-touching dev agents

**Original D-009** scoped the Graphify advisory nudge to **exactly five
agents** (Hizkiah, Salma, Oholiab, Nathan, Zadok) — the highest token
consumers writing code. Empirical use since the POC made the original
"five only" boundary read narrower than the actual benefit space.

**Amended scope** — **20 code-touching dev agents** carry
`graphify-query-craft` and are reached by the PreToolUse nudge when
they hit `Read`/`Grep` on source:

- **Yasad backend (5):** Hizkiah, Nathan, Zadok, Shallum, Uriah
- **Panim frontend (4):** Salma, Oholiab, Asaph, Jahaziel
- **Chosheb UI (1):** Hiram
- **Mishmar code-security (3):** Ira, Joab, Hushai
- **Migdal infra-code (4):** Palal, Meshullam, Meremoth, Hanun
- **Sefer code-documentation (3):** Joah, Shevna, Jehonathan

**Why the broadening.** Graphify answers "who calls X" / "what depends
on Y" / "where is the entry point" — structural questions useful to any
agent reading code, not just writing it. A security reviewer auditing a
payment flow benefits from the call graph as much as Hizkiah
implementing it; a documentation specialist (Joah / Shevna) writing
module docs benefits from knowing its surroundings. Restricting to
writers left readers' queries — typically grep + Read — on the expensive
path.

**What did not change.**
- The hook stays **advisory**, never blocks (D-009 invariant preserved).
- Fail-open on missing/stale graph preserved.
- `--context` discipline in the craft skill body preserved.
- The hook's trigger predicate (Read on source ext / Grep on bare
  identifier) is agent-independent — adding agents to the carrier set is
  what changes coverage, the hook itself stays the same.
- The two orchestrators, the research pipeline, the QA reporters who
  don't read source, and the team reporters remain out of scope —
  adding them would add noise without changing behaviour.

**Implication for D-010 (workflow portfolio).** The
`mishmar-security-gate` and `sefer-release-notes` workflows now invoke
agents carrying the skill — their structural-query phases will be
served by Graphify where before they would have grep+Read. Token
savings carry through to those workflows.

---

*Decisions locked May 2026. Revisit only with a dated amendment below.*
