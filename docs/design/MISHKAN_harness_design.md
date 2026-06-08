# MISHKAN — Advanced SWE R&D Harness
## Design Document

> *"See, I have called by name Bezalel the son of Uri... I have filled him with
> the Spirit of God, in wisdom, in understanding, in knowledge, and in all
> manner of workmanship."*
> — Exodus 31:2-3 (KJV)

**MISHKAN** (מִשְׁכָּן) — *dwelling place, the place where presence resides.*
Exodus 25:9. The Tabernacle Bezalel was called to build. The persistent place
where engineering work lives.

---

Personal engineering infrastructure for open source contribution, freelance
projects, side projects, and advanced research (Tsinghua — advanced computing).
Built on modern software engineering with security by design, performance,
quality, and ops as first-class concerns. Claude Code-first. Knowledge
graph-driven.

Agent aliases → see `MISHKAN_agent_aliases.md`

---

## 1. What MISHKAN Is

A persistent, always-warm agent harness that acts as a complete virtual software
engineering organisation working alongside one engineer (Y4NN).

Not a task-runner. Not a pipeline. A system that:

- Converses freely during exploration and ideation
- Shifts naturally into execution when intent is clear
- Enforces quality through deterministic constraints, not probabilistic prompting
- Learns continuously via a structured knowledge graph (Cognee)
- Grows more useful over time — encodes Y4NN's standards, patterns, decisions
- Runs natively on Claude Code

---

## 2. Core Principles

**Claude Code-first.**
Native primitives throughout: CLAUDE.md hierarchy, subagents, hooks, MCP
servers, slash commands, skills, rules. No abstraction layers fighting the
platform.

**Harness over prompting.**
Reliability comes from shaping the environment, not from better instructions.
Deterministic constraints (hooks, gates, schemas, rules) outperform
probabilistic ones (telling agents to follow standards).

**Full context on every agent call.**
No agent operates with partial context. Agents query Cognee for what they need
rather than loading everything into the context window. Static role definitions
are cached. Dynamic sprint state is lean and structured.

**Security by design, not by audit.**
Mishmar is a constraint shaping every team's output from the start — not a team
reviewing at the end. Mishmar also audits the harness itself — hooks, MCP
integrations, third-party skills, tool permissions.

**Generation separated from evaluation.**
No agent judges its own output. QA roles and Team Reporters are structurally
separate from the agents producing work.

**Sequential over parallel by default.**
Explicit parallelism only when needed and deliberately chosen.

**Lean by discipline.**
Tight role definitions. Compressed state artifacts. No bloated system prompts.
Context window is a finite resource — spent intentionally through caching,
JIT loading, and Cognee offloading.

**The harness learns.**
Research that resolves becomes knowledge. Decisions become graph nodes. Patterns
surface as improvements. The system gets better at working with this specific
engineer over time. Knowledge promotion is orchestrated — not automatic, not
manual — governed by blast radius.

---

## 3. Session Modes

### 3.1 Exploration (default on session start)
Free prompting. Y4NN thinks out loud, explores ideas, drafts briefs informally.
Nehemiah (PM) and Bezalel (CTO) lead the conversation. All other agents
available on demand — they do not interject unless called. The research pipeline
is available to any agent during this mode. No formal structure imposed.

### 3.2 Execution
Triggered when intent is clear — either Y4NN runs `/mishkan-init` for a new
project or the exploration conversation converges on a clear spec. Teams
activate. Work flows through the sprint structure. Team Reporters gate at
milestones. Sefer pulls at milestones and on trigger events.

### 3.3 Agent Availability
- **On demand (default):** Nehemiah and Bezalel route to agents as needed.
  Each agent call loads the full harness state on wake via CLAUDE.md hierarchy
  + Cognee query + cached role definition.
- **All-active (user-set):** All agents simultaneously present. Used for complex
  collaborative moments — architecture decisions, design reviews, cross-team
  problem solving. Higher cost, explicitly chosen by Y4NN.

---

## 4. Claude Code Primitives Map

| MISHKAN Concept            | Claude Code Primitive                              |
|---------------------------|----------------------------------------------------|
| Harness identity           | `~/.claude/CLAUDE.md` — user level               |
| Personal standards         | `~/.claude/rules/` — user level rules             |
| Project state artifact     | `./CLAUDE.md` — project level                     |
| Team standards             | `.claude/rules/<team>/` — path-scoped, JIT loaded |
| Orchestration agents       | Top-level subagents (Nehemiah, Bezalel)            |
| Team specialists           | `.claude/agents/` — one `.md` per agent           |
| Tool permissions           | Agent frontmatter `tools:` field                  |
| Constraint enforcement     | `.claude/rules/` — common + path-scoped           |
| Sprint enforcement         | Hooks — `PreToolUse`, `PostToolUse`, `Stop`       |
| Session bootstrap          | `SessionStart` hook *(pending validation)*        |
| Reusable workflows         | `.claude/skills/` — load on demand, not at start  |
| Slash commands             | `.claude/commands/`                               |
| Shared knowledge graph     | Cognee via MCP                                    |
| Agent personal learning    | Subagent auto memory — `MEMORY.md` per repo       |
| External integrations      | `.mcp.json` — per project                        |
| Observability              | `PostToolUse` hook — structured session logs      |

---

## 5. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATION                             │
│                                                                  │
│      NEHEMIAH (PM)                   BEZALEL (CTO)               │
│      scope · delivery                technical standards         │
│      sprint state · user UI          architecture · quality bar  │
│                                                                  │
│      ← primary conversational interface in exploration mode →    │
└───────────────────────────┬──────────────────────────────────────┘
                            │ routes · coordinates · converses
┌───────────────────────────▼──────────────────────────────────────┐
│                   SHARED RESEARCH PIPELINE                       │
│               invokable by any agent, at any time                │
│                                                                  │
│   Jakin → Ezra → Caleb → Shaphan → Shemaiah → Baruch            │
│   (clarify) (formulate) (research) (summarise) (evaluate) (report)│
│                                                                  │
│   Caleb → cloud model    Shaphan + Shemaiah → local models       │
└───────────────────────────┬──────────────────────────────────────┘
                            │ available to all teams
┌───────────────────────────▼──────────────────────────────────────┐
│                     SPECIALIZED TEAMS                            │
│                                                                  │
│  CHOSHEB    PANIM      YASAD     MISHMAR   MIGDAL    SEFER       │
│  Design     Frontend   Backend   Security  Infra     Docs        │
│                                                                  │
│  Each team: Lead → Specialists → QA/Advisor → Reporter           │
│                                                                  │
│  Collaboration model:                                            │
│  Chosheb  →  Panim       design handoff · unidirectional       │
│  Panim    ↔    Yasad       API contracts · bidirectional         │
│  Yasad    ↔    Mishmar     audit + remediation · bidirectional   │
│  Mishmar   →   Migdal      security gates infrastructure         │
│  Mishmar + Migdal          cross-cutting · review all teams      │
│  Sefer    ←    all teams   pulls at milestones + on trigger      │
└───────────────────────────┬──────────────────────────────────────┘
                            │ reads · writes · promotes
┌───────────────────────────▼──────────────────────────────────────┐
│               MEMORY & KNOWLEDGE ARCHITECTURE                    │
│                                                                  │
│  Auto memory (per agent)    subagent MEMORY.md · private         │
│       ↓ promoted by blast radius                                 │
│  Team knowledge             team rules + shared topic files      │
│       ↓ promoted at milestone                                    │
│  Project graph              Cognee · entities + relationships    │
│       ↓                                                          │
│  Domain ontology            schema · Y4NN's personal standards   │
│       ↓ queried by                                               │
│  Improvement layer          pattern detection → refinements      │
└──────────────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│                  TOKEN OPTIMISATION LAYER                        │
│                                                                  │
│  Prompt caching       static role prefix cached per agent        │
│  JIT tool loading     tools load on selection · not at start     │
│  Cognee offloading    full outputs in graph · summaries in ctx   │
│  Auto-compaction      Claude Code native · intra-session         │
│  Rules scoping        path-scoped rules · load when matched      │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. Naming System

All names drawn from the Hebrew Bible (KJV).
Personal names for agents. Hebrew words for teams and the harness.
Full registry → `MISHKAN_agent_aliases.md`

### Harness
| Name | Hebrew | Strong's | Source | Meaning |
|------|--------|----------|--------|---------|
| **MISHKAN** | מִשְׁכָּן | H4908 | Exodus 25:9 | Dwelling place — the Tabernacle Bezalel built |

### Orchestration
| Role | Alias | Source | Meaning |
|------|-------|--------|---------|
| PM | **Nehemiah** | Book of Nehemiah | Overseer of all builders · reported to the king |
| CTO | **Bezalel** | Exodus 31:2 | Master craftsman · wisdom in all manner of workmanship |

### Teams
| Team | Name | Hebrew | Strong's | Source | Meaning |
|------|------|--------|----------|--------|---------|
| Design | **Chosheb** | חֹשֵׁב | H2803 | Exodus 31:4 | Cunning work — deviser of artistic works |
| Frontend | **Panim** | פָּנִים | H6440 | Exodus 33:14 | Face · presence · what is turned toward |
| Backend | **Yasad** | יָסַד | H3245 | Psalm 24:2 | To lay the foundation · establish solidly |
| Security | **Mishmar** | מִשְׁמָר | H4929 | Nehemiah 4:9 | Guard · watch · the post set day and night |
| Infrastructure | **Migdal** | מִגְדָּל | H4026 | Nehemiah 3:1 | Tower · load-bearing structures of the wall |
| Documentation | **Sefer** | סֵפֶר | H5612 | Nehemiah 8, Ezra 6 | Book · scroll · official written record |

---

## 7. Agent Roster

Full aliases with sources → `MISHKAN_agent_aliases.md`

### Orchestration
| Alias | Functional Role |
|-------|----------------|
| Nehemiah | senior_software_project_manager |
| Bezalel | engineering_manager_cto |

### Research Pipeline (shared · invokable by all)
| Alias | Tool Role | Model |
|-------|-----------|-------|
| Jakin | intent_clarificator | Cloud |
| Ezra | research_details_formulator | Cloud |
| Caleb | contextual_web_researcher | Cloud |
| Shaphan | contextual_research_summarizer | Local |
| Shemaiah | contextual_research_results_evaluator | Local |
| Baruch | research_reporter | Local |

### Chosheb — Design
| Alias | Functional Role |
|-------|----------------|
| Aholiab | Team Lead |
| Hiram | senior_ui_design_and_prototype_implementation |
| Deborah | cognitive_and_emotional_ux_expert |
| Elasah | Team Reporter |

### Panim — Frontend
| Alias | Functional Role |
|-------|----------------|
| Huram | Team Lead |
| Oholiab | senior_frontend_engineer_frontend_design_system_expert |
| Salma | senior_frontend_developer |
| Obed | smart_frontend_assets_feeder |
| Asaph | seo_accessibility_expert |
| Jahaziel | frontend_qa_engineer |
| Ahikam | Team Reporter |

### Yasad — Backend
| Alias | Functional Role |
|-------|----------------|
| Zerubbabel | Team Lead |
| Zadok | senior_software_engineer_design_system_master |
| Nathan | senior_software_engineer_software_architecture_master |
| Hizkiah | senior_backend_engineer_pure_backend_implementation |
| Shallum | senior_backend_engineering_databases_expert |
| Uriah | backend_qa_engineer |
| Igal | Team Reporter |

### Mishmar — Security *(cross-cutting)*
| Alias | Functional Role |
|-------|----------------|
| Phinehas | Team Lead |
| Benaiah | software_and_infrastructure_security_expert_devsecops |
| Joab | web_mobile_desktop_security_expert |
| Ira | code_security_ops |
| Hushai | software_security_advisor |
| Maaseiah | Team Reporter |

### Migdal — Infrastructure
| Alias | Functional Role |
|-------|----------------|
| Eliashib | Team Lead |
| Palal | systems_engineer_os_virtualisation_networks |
| Meshullam | infrastructure_design_engineer |
| Hanun | devsecops_practitioner_support_ops |
| Meremoth | devops_engineer |
| Rehum | infrastructure_health_and_security_advisor |
| Zaccur | Team Reporter |

### Sefer — Documentation *(cross-cutting · pull-based)*
| Alias | Functional Role |
|-------|----------------|
| Jehoshaphat | Team Lead — documentation architecture · pulls coordination |
| Seraiah | organisation_layer_specialist — cross-project standards · Y4NN engineering identity |
| Joah | project_layer_specialist — architecture decisions · runbooks · changelogs · API docs |
| Shevna | team_layer_specialist — per-team docs · component libraries · security posture · infra topology |
| Jehonathan | knowledge_publication_specialist — queries Cognee · publishes human-readable documentation |
| Huldah | Team Reporter |

---

## 8. Curated Resources — Team Knowledge Libraries

Each team maintains a curated knowledge library in Cognee — pre-vetted,
professional reference material specific to that team's domain. This is
distinct from the research pipeline.

**Research pipeline** → finds new things when an agent faces an unknown problem.
**Curated library** → holds proven things agents load without searching.

### How it works

Each team's library lives as a structured subgraph in Cognee — not flat docs.
Nodes represent canonical references (standards, patterns, case studies).
Edges represent relationships (applies-to, supersedes, validated-by).

When an agent solves a problem using a curated resource, it writes a
**case node** to the graph:

```json
{
  "type": "case",
  "team": "Mishmar",
  "agent": "Ira",
  "problem_class": "SQL injection via ORM misconfiguration",
  "resource_applied": "OWASP-A03-2021",
  "resolution": "parameterised queries enforced at ORM level",
  "outcome": "resolved",
  "sprint": "S2",
  "task": "T-17"
}
```

Over time MISHKAN builds its own professional case library — specific to Y4NN's
work patterns, projects, and technology stack.

### Curated library scope per team

| Team | Library focus |
|------|--------------|
| Chosheb | Design systems · UX heuristics · accessibility standards · visual patterns |
| Panim | Component patterns · performance budgets · browser compatibility · WCAG |
| Yasad | Architecture patterns · API design · database patterns · clean code standards |
| Mishmar | OWASP · threat modelling frameworks · CVE patterns · secure coding standards |
| Migdal | Infrastructure patterns · IaC standards · observability · reliability engineering |
| Sefer | Documentation standards · ADR format · API doc standards · changelog conventions |

---

## 9. Knowledge Promotion Model

When an agent learns something, the blast radius of that knowledge determines
where it lives.

### Three scopes

| Scope | Storage | Who decides |
|-------|---------|-------------|
| Agent-private | Subagent auto memory (`MEMORY.md`) | The agent — autonomous |
| Team-level | Team rules + shared topic files | Team Lead — on trigger or milestone |
| Cross-harness | Cognee project graph node | Nehemiah + Bezalel — at sprint close |

### Two promotion triggers

**Immediate trigger** — an agent's learning affects another agent's current
work. The agent flags it to its Team Lead. Team Lead decides: team-level
(update shared topic file) or cross-harness (write to Cognee immediately,
don't wait for milestone). High signal, low volume.

**Milestone trigger** — Team Reporter collects all sprint learning at milestone.
Surfaced to Nehemiah. Resolved research + decisions promoted to Cognee.
Sefer pulls the milestone output and updates documentation. Systematic,
predictable, every sprint.

### Promotion is orchestrated

Not automatic — noise floods the graph.
Not manual — signal gets lost.
Governed by blast radius: does this learning affect only me, my team, or
everyone? That question determines the promotion path.

---

## 10. Five-Layer Harness Architecture

### Layer 1 — Memory (context management)

**Static layer — cached**
- `~/.claude/CLAUDE.md` — Y4NN's permanent standards · travels all projects
- `~/.claude/rules/` — personal non-negotiables
- Agent role definition (frontmatter) — cached prefix per agent call

**Dynamic layer — lean**
- `./CLAUDE.md` — project state artifact · seeded by init · updated at milestones
- Subagent `MEMORY.md` — first 200 lines loaded per agent · topic files JIT

**Graph layer — queried**
- Cognee — agents query what they need · summaries in context · full nodes on demand

### Layer 2 — Tooling (MCP)

Dynamic loading — tools load on selection, not at session start.
Each agent's frontmatter declares its MCP access explicitly.

| MCP Server | Agents | Purpose |
|-----------|--------|---------|
| Cognee | All | Shared knowledge graph · read + write |
| Filesystem | All except Reporters | Codebase read/write |
| Git | Leads + Mishmar + Migdal | History · diffs · commits |
| Browser | Caleb (researcher) | Web research |
| Security scanner | Mishmar team | Static analysis · dependency scanning |
| Infrastructure tools | Migdal team | Deployment · ops · monitoring |
| Documentation tools | Sefer team | Doc generation · publishing |

### Layer 3 — Permissions & Safety

Two settings files:
- `.claude/settings.json` — committed · team-wide rules
- `.claude/settings.local.json` — gitignored · Y4NN local overrides

Permission model: **default deny · explicit allow per agent.**
Defined in agent frontmatter `tools:` field. Not inherited from team.

### Layer 4 — Runtime Hooks & Agents

| Hook | Trigger | Owner | Action |
|------|---------|-------|--------|
| `PreToolUse` | Before any write | Ira (Mishmar) | Security scan · validate research log contract |
| `PostToolUse` | After any tool | Observability | Structured log — tokens · cost · tool · agent · outcome |
| `Stop` | Agent stops at milestone | Team Reporter | Assemble structured milestone report |
| `SessionStart` | New context window | Harness | Load sprint state · query Cognee *(pending validation)* |

Multi-agent: Nehemiah and Bezalel orchestrate. Team Leads coordinate within
teams. No agent operates without knowing the full harness state.

### Layer 5 — Observability & Logging

Every agent call generates a structured log entry:

```json
{
  "agent": "alias",
  "team": "team_name",
  "sprint": "S1",
  "session": "session_id",
  "tool_calls": ["list"],
  "tokens_input": 0,
  "tokens_cached": 0,
  "tokens_output": 0,
  "cost": 0.00,
  "outcome": "completed | blocked | escalated",
  "cognee_writes": 0,
  "timestamp": "ISO8601"
}
```

Logs feed the improvement layer. Improvement layer queries Cognee to detect:
- Which agents are most expensive → prompt optimisation targets
- Which tools get called most per team → MCP access refinement
- Where blockers cluster → workflow bottleneck detection
- Which components accumulate findings → structural risk surfacing

---

## 11. Token Optimisation Layer

Three mechanisms, each with a distinct job. Together they keep every agent
call affordable without sacrificing context quality.

> **Operational detail:** how each mechanism is formulated on top of the Claude
> model — the cost model, the anatomy of one agent call, the native-primitive ×
> input-shaping mapping, the auto-compaction interaction, and honest gaps — is
> documented in [`MISHKAN_token_optimisation.md`](MISHKAN_token_optimisation.md).

### Prompt caching
Static content — agent role definition, permanent standards, team context —
placed first in context as a cacheable prefix. Dynamic content — sprint state,
current task — placed last. Cache hit rate is the metric, not raw token count.
Target: 50-90% cost reduction on cached tokens per agent call.

### Cognee offloading
Full research outputs, decision records, case nodes live in Cognee.
Only compressed summaries enter the context window. Agents query Cognee
for full detail on demand. Nothing gets dumped raw into context.

### JIT tool loading
MCP tool schemas load on selection, not at session start. Agents with large
tool surfaces (Mishmar, Migdal) don't bloat context with schemas they may
not use this session. Hard limit: under 10 MCPs active, under 80 tools loaded
at any time.

### Rules scoping
Path-scoped rules in `.claude/rules/<team>/` load only when Claude works
with matching files. Frontend rules load on `.tsx/.css`. Backend rules load
on `.py/.ts/api/**`. Security rules load on all files (common). No team's
rules bloat another team's context.

### Auto-compaction
Claude Code native. Handles intra-session context limits automatically.
CLAUDE.md survives compaction and is re-injected. Subagent MEMORY.md
survives via auto memory. Cognee persists independently.

---

## 12. Project Initialisation — `/mishkan-init`

Triggered manually by Y4NN once per project. Runs the SWE-BASICS-BEFORE-CODE
framework sequentially through the right specialist agents. Each phase feeds
the next.

```
Y4NN + Nehemiah
   Intent conversation — free, exploratory
        ↓
Nehemiah
   PRD.md
        ↓
Yasad: Nathan
   SRS.md
        ↓
Yasad: Zadok
   CONTRACT.md — invariants + guarantees
        ↓
Bezalel + Nathan
   ARCHITECTURE.md
        ↓
Mishmar: Benaiah
   THREAT_MODEL.md
        ↓
Migdal: Meshullam
   C4 diagrams
        ↓
Sefer: Jehoshaphat
   Initial documentation structure — README · ADRs · runbook stubs
        ↓
automated
   Cognee graph seeded from all docs
        ↓
automated
   CLAUDE.md written — project state artifact ready · sprint S0
```

### Init outputs

**Repo `docs/`**
```
docs/
├── PRD.md
├── SRS.md
├── CONTRACT.md
├── ARCHITECTURE.md
├── THREAT_MODEL.md
├── README.md
├── adr/                    ← architecture decision records
├── runbooks/               ← stub runbooks per team
└── diagrams/C4/
```

**Harness state**
- `CLAUDE.md` seeded · sprint S0 established
- Cognee graph populated from all docs
- Sefer team documentation structure initialised

---

## 13. Sefer — Documentation Team

Cross-cutting. Pull-based. Two operating modes:

**Sequential pull** — fires at every sprint milestone after all Team Reporters
have surfaced. Sefer pulls from all reporters and from Cognee. Produces:
updated changelogs, architecture decision records, API doc updates, runbook
revisions, team-level documentation.

**Triggered pull** — specific events fire it without waiting for milestone.
Major architecture decision by Bezalel. Critical security finding closed by
Phinehas. Schema change by Shallum. Any high-blast-radius event triggers
Sefer to pull from that team and update relevant documentation immediately.

Sefer does not produce code. Does not write to the codebase. Reads from
Cognee and team reporters. Writes to `docs/`. Publishes human-readable
documentation from structured graph knowledge.

---

## 14. Research Log Contract

Every agent that invokes the research pipeline produces a structured log entry.
Not optional — it is the contract.

```json
{
  "agent": "alias",
  "team": "team_name",
  "sprint": "S1",
  "trigger": "faced_problem | requested",
  "query_intent": "what the agent was trying to find out",
  "tools_invoked": ["pipeline tools used"],
  "research_output_summary": "compressed result",
  "applied_to_task": "task_reference",
  "outcome": "resolved | partial | blocked",
  "knowledge_graph_write": true,
  "curated_library_match": true
}
```

`curated_library_match: true` — the problem was solved using the team's
curated library, not the web pipeline. This distinction feeds the improvement
layer to detect which curated resources are actually being used.

- Private during work — stays with the calling agent
- Surfaces at milestone — Team Reporter collects and includes
- Promoted on resolve — written to Cognee project graph at sprint close
- Sefer pulls resolved entries at milestone to update documentation

---

## 15. Sprint Cadence & Reporting

**During sprint:** Team Reporters collect research logs and task state silently.

**At milestone:**

1. Each Team Reporter surfaces structured summary to Nehemiah
2. Nehemiah aggregates all six team reports (five teams + Sefer)
3. Bezalel reviews architectural and security flags
4. Sefer pulls all reporter outputs + Cognee → updates documentation
5. Resolved research promoted to Cognee project graph
6. Improvement layer queries Cognee for patterns

Team Reporter milestone output:
```
team              : Yasad
sprint            : S1
milestone         : M2
tasks_completed   : [list]
tasks_in_progress : [list]
tasks_blocked     : [list]
research_calls    : { resolved, partial, blocked, library_hits }
decisions_made    : [list]
security_findings : [list]
cognee_writes     : N
flags             : [list]
```

---

## 16. Model Assignment Matrix

| Tier | Agents | Model |
|------|--------|-------|
| Top-tier cloud | Nehemiah · Bezalel · all Team Leads · Jehonathan | Claude Sonnet/Opus |
| Mid-tier cloud | Senior specialists — architecture · security · databases · Seraiah · Joah | Claude Haiku / mid-tier |
| Strong local | Other specialists · QA agents · Shevna | qwen2.5-coder · deepseek-coder |
| Fast local | All Team Reporters · Shaphan · Shemaiah · Baruch | Small local models |

Research pipeline:
- Caleb (web researcher) → cloud
- Shaphan + Shemaiah + Baruch → local

---

## 17. Tool Permission Matrix

| Tool / MCP | Orchestration | Team Leads | Specialists | QA | Reporters | Sefer |
|-----------|:------------:|:---------:|:-----------:|:--:|:---------:|:-----:|
| Research pipeline | ✓ | ✓ | ✓ | ✓ | read | ✓ |
| Curated library (read) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Curated library (write) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Codebase (read) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Codebase (write) | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Cognee (read) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Cognee (write) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Docs (write) | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ |
| Infrastructure tools | ✓ | Migdal | Migdal | ✗ | ✗ | ✗ |
| Security tools | ✓ | Mishmar | Mishmar | Mishmar QA | ✗ | ✗ |
| Documentation tools | ✓ | Sefer | Sefer | ✗ | ✗ | ✓ |
| External APIs | ✓ | case | case | ✗ | ✗ | ✗ |

---

## 18. ECC Integration

MISHKAN builds on ECC (affaan-m/ECC) patterns without reinventing what ECC
already solved well.

| ECC Pattern | How MISHKAN Uses It |
|-------------|-------------------|
| Skills as primary workflow surface | MISHKAN skills in `.claude/skills/` per workflow |
| Instinct-based continuous learning | Feeds MISHKAN improvement layer → Cognee |
| Hook runtime controls (`ECC_HOOK_PROFILE`) | Adopted directly |
| AgentShield security scanning | Ira (Mishmar) runs AgentShield via PreToolUse hook |
| Session memory hooks | Adapted for sprint-gated reporting |
| `CLAUDE.md` hierarchy | MISHKAN state artifact convention |
| Rules architecture (`common/` + language) | Adopted directly |

---

## 19. Project Filesystem Layout

```
~/.claude/                              ← Y4NN personal · never committed
├── CLAUDE.md                           ← permanent standards · all projects
├── settings.json                       ← personal defaults
├── rules/
│   └── y4nn-standards.md              ← personal non-negotiables
└── projects/<repo>/memory/
    ├── MEMORY.md                       ← cross-session index · 200 line limit
    └── <topic>.md                      ← topic files · JIT loaded

<project>/
├── CLAUDE.md                           ← project state artifact · lean
├── CLAUDE.local.md                     ← gitignored · local overrides
├── .mcp.json                           ← MCP server declarations
├── docs/                               ← init outputs · living docs
│   ├── PRD.md
│   ├── SRS.md
│   ├── CONTRACT.md
│   ├── ARCHITECTURE.md
│   ├── THREAT_MODEL.md
│   ├── README.md
│   ├── adr/
│   ├── runbooks/
│   └── diagrams/C4/
└── .claude/
    ├── settings.json                   ← committed · team-wide permissions
    ├── settings.local.json             ← gitignored · local overrides
    ├── agents/                         ← all 45 agents · one .md per agent
    │   ├── nehemiah.md
    │   ├── bezalel.md
    │   └── ...
    ├── rules/                          ← path-scoped · JIT loaded
    │   ├── common/
    │   │   └── security.md            ← loads for all files
    │   ├── frontend/
    │   │   └── panim.md               ← loads on .tsx .css .html
    │   ├── backend/
    │   │   └── yasad.md               ← loads on .py .ts api/**
    │   ├── infrastructure/
    │   │   └── migdal.md              ← loads on infra/** Dockerfile
    │   └── documentation/
    │       └── sefer.md               ← loads on docs/**
    ├── skills/                         ← reusable workflows · load on demand
    │   ├── mishkan-init/
    │   │   └── SKILL.md
    │   ├── research-pipeline/
    │   │   └── SKILL.md
    │   ├── sprint-report/
    │   │   └── SKILL.md
    │   ├── cognee-promote/
    │   │   └── SKILL.md
    │   ├── context-compress/
    │   │   └── SKILL.md
    │   └── sefer-pull/
    │       └── SKILL.md
    ├── hooks/
    │   ├── pre-tool-security.sh       ← Ira · Mishmar enforcement
    │   ├── post-tool-observe.sh       ← structured observability log
    │   ├── stop-reporter.sh           ← milestone trigger
    │   └── session-start.sh           ← sprint state load *(pending)*
    ├── commands/
    │   ├── mishkan-init.md            ← /mishkan-init
    │   ├── sprint-close.md            ← /sprint-close
    │   ├── promote.md                 ← /promote · manual knowledge promotion
    │   └── sefer-pull.md              ← /sefer-pull · trigger doc update
    └── templates/
        ├── research-log.json
        ├── team-report.json
        ├── sprint-state.json
        ├── case-node.json
        └── observability-log.json
```

---

*MISHKAN Design Document — May 2026*
*Living document. Claude Code-first. Cognee locked. Hebrew naming locked.*
*Six teams including Sefer. Init flow locked. Sequential execution locked.*
*ECC patterns integrated. Token optimisation layer designed.*
*Five-layer harness architecture mapped. Knowledge promotion model defined.*
*Agent aliases → MISHKAN_agent_aliases.md*
