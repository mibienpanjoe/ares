# MISHKAN — Observability Stack

> Status: **proposed** — written 2026-06-05. Pending Y4NN approval before any
> code lands. Once approved this doc becomes the implementation contract for
> the daemon, the TUI client, and the hook enrichments.

> Scope: how Y4NN watches a MISHKAN session in real time across all his projects
> and Claude Code sessions, without reading raw JSONL files. Three artefacts:
> a structured event bus, a state-aggregating daemon, and a Textual TUI client.

---

## 1. What this is

A cross-session, cross-project observability layer for MISHKAN. The harness
already emits per-tool-call NDJSON via the `post-tool-observe.sh` PostToolUse
hook (Phase 8 of the harness design, deferred). This document extends that
foundation with:

1. **An enriched event schema** — agent, team, workflow, worktree context
   captured at emit time, not reconstructed later.
2. **A daemon (`mishkan-watchd`)** — tails every session's NDJSON, polls a few
   synchronous sources (git worktrees, Cognee stats), keeps a live snapshot of
   harness state, and exposes a UNIX-socket NDJSON protocol.
3. **A TUI client (`mishkan-watch`)** — Textual app. 8 tabs, key-driven, no
   overload. Reads the daemon snapshot+delta stream, renders the view, never
   touches files directly. Tabs 1-5 are live; tabs 6-8 (Org-Ref · Usage ·
   Skills) are reference/analytical views added at v0.2.3.

The TUI runs in any terminal (tmux pane, standalone window, attached over SSH).
It is a passive observer — it never writes to harness state, never alters
agents' behaviour, never sees secrets.

## 2. What it is NOT

- Not a metrics platform (no Prometheus export, no Grafana).
- Not a logging system (raw JSONL stays on disk; the daemon doesn't persist).
- Not an attribution/billing tool (token spend is best-effort, not authoritative).
- Not a debugger — it shows state and recent events, not stepping/breakpoints.
- Not a remote console — it observes; the engineer still drives Claude Code.

## 3. Principles

### 3.1 Fail-open

Observability must never break a tool call, never block a hook, never wedge a
session. Every emitter does `2>/dev/null || true`; the daemon being down is a
silent UX degradation, not an outage. This mirrors `post-tool-observe.sh`'s
existing fail-open posture.

### 3.2 Append-only file bus, no broker dependency

Events are NDJSON, one event per line, append-only, rotated daily. No Redis, no
Kafka, no message queue. The filesystem is the bus. This is consistent with the
harness's "local Docker first, no cloud rent without proven need" stance.

### 3.3 Discoverable, not registered

The daemon discovers active sessions by globbing `~/.claude/projects/*/*.jsonl`
modified in the last N seconds. Projects are discovered by reading the parent
directory paths. Nothing has to be registered in a config file.

### 3.4 No overload in the UI

The TUI defaults to ONE view that answers "what is happening right now?". All
historical depth lives behind explicit key presses. v0.2.0 shipped with a
5-tab layout (Live · Agents · Workflows · Knowledge · Activity); v0.2.3
added three reference/analytical tabs (Org-Ref · Usage · Skills) for
recall and analysis without disturbing the live view. The 8-tab layout
is the new upper bound; if a ninth dimension matters we replace, not add.

## 4. Event schema

One JSON object per line in `~/.claude/mishkan/logs/<session-id>.jsonl`.

```json
{
  "ts": "2026-06-05T12:01:23.456Z",
  "session": "47a05817-3122-4337-9d96-b52b157457bd",
  "project": "/home/ogu/theY4NN/harness",
  "agent": "bezalel",
  "subagent_id": "aa303b5754da30d1a",
  "type": "tool_call",
  "tool": "Write",
  "outcome": "completed",
  "tokens_in": 12450,
  "tokens_out": 380,
  "duration_ms": 1240,
  "payload": { "...type-specific keys..." }
}
```

### 4.1 Fields

| Field | Required | Source |
|---|---|---|
| `ts` | yes | UTC ISO-8601 with ms |
| `session` | yes | Claude Code session id (hook payload) |
| `project` | yes | `pwd` at emit time |
| `agent` | when known | `null` for main session; subagent name when in a Task call |
| `subagent_id` | when applicable | Task tool result `agentId` |
| `type` | yes | enum (§4.2) |
| `tool` | when type=tool_call | hook payload `tool_name` |
| `outcome` | when applicable | `completed | blocked | errored` |
| `tokens_in/out` | best-effort | from hook payload when present, else 0 |
| `duration_ms` | best-effort | PreToolUse stamp + PostToolUse delta |
| `payload` | optional | type-specific extras |

### 4.2 Event types

**Activity stream — what the harness is doing:**

- `tool_call` — every Bash/Read/Edit/Write/Task/Grep/MCP call (today, partial)
- `hook_fire` — model-route, ira-security, observe (new)
- `agent_spawn` — subagent launched, from Task tool payload (new)
- `agent_complete` — subagent finished, from Task notification (new)
- `inter_agent` — subagent return-to-parent message summary (new)
- `skill_invoke` — Skill tool fires; skill_name + args (new)
- `plan` — `EnterPlanMode` / `ExitPlanMode`; agent, approved (new)
- `permission` — Claude Code permission prompt; tool, decision (new)
- `compaction` — context window compacted; trigger, tokens_before, tokens_after (new)
- `reporter_milestone` — already exists (`stop-reporter.sh`)

**Code-effect stream — what changed:**

- `file_change` — Write/Edit completed; path, op, lines_added, lines_removed (new)
- `error` — first-class; type, message, agent, severity — separated from
  `tool_call.outcome=errored` so failures aggregate (new)
- `worktree_change` — added/removed, daemon-detected via poll (new)

**External-call stream — what reached out:**

- `web_query` — WebFetch/WebSearch; query, url, success (new)
- `mcp_server` — MCP server up/down/error; server_name, status (new — covers
  Cognee + Canva + Gmail + every other MCP, not just Cognee)
- `cron_event` — CronCreate/CronList/scheduled fire; cron_id, action (new)

**Knowledge stream — what landed in the graph:**

- `cognee_op` — search/add/cognify/memify on either store (new, MCP log tail)
- `graphify_scan` — Graphify scan completed on a project; nodes, duration (new)
- `graphify_query` — `graphify search` invocation; query, hits (new)

**Cost stream — what it cost:**

- `token_usage` — parsed from session JSONL `usage` blocks; tokens_in,
  tokens_out, cache_read, cache_write, model, $-estimate (new — needs the
  session JSONL parser, not from the hook bus)

**Workflow stream — what the dynamic-workflow runtime did:**

See §4.3 below for the workflow-specific event types — they are rich enough
to warrant their own subsection.

### 4.3 Dynamic workflow events

The `Workflow` tool persists a journal per run under
`~/.claude/projects/<proj>/<sid>/workflows/<run-id>/`. The daemon tails the
journal and re-emits structured events. A workflow is not a single event —
it is a tree of agent calls with phase/parallel/pipeline structure.

- `workflow_start` — script name, meta.name, meta.phases, model overrides
- `workflow_phase` — phase title entered (matches `phase()` call in script)
- `workflow_agent_call` — every `agent()` invocation inside the workflow;
  fields: workflow_id, phase, label, schema_name (if any), model
- `workflow_agent_result` — that agent's return; success, schema_valid,
  duration_ms, tokens_in, tokens_out
- `workflow_stage` — `pipeline()` or `parallel()` stage event; stage_index,
  items_count, items_in_flight
- `workflow_barrier_wait` — barrier hit (parallel() awaiting siblings);
  agents_pending
- `workflow_error` — caught exception, schema validation failure, or thrown
  agent — agent stays attributable
- `workflow_complete` — total duration, total agents, total tokens, final
  return value summary (truncated to 500 chars)

These let the **Workflows** tab show a live phase tree with per-agent
status, parallel fan-out, and "this workflow has spent $1.20 so far"
without polling — purely from journal-tail.

### 4.4 What does not change

- File location stays `~/.claude/mishkan/logs/<session>.jsonl`.
- Append-only NDJSON, one event per line.
- Existing `post-tool-observe.sh` event shape is **extended, not replaced** —
  new fields are added, none removed. Downstream consumers that read only the
  old fields keep working.

## 5. Sources (where the daemon reads from)

| Source | Mechanism | Cadence |
|---|---|---|
| Event bus | inotify on `~/.claude/mishkan/logs/*.jsonl` | streaming |
| Git worktrees | `git worktree list --porcelain` per known project | 5 s |
| Cognee work | MCP HTTP `/health` + cypher node count | 30 s |
| Cognee curated | MCP HTTP `/health` + cypher node count | 30 s |
| Active sessions | glob `~/.claude/projects/*/*.jsonl` mtime < 60 s | 10 s |
| Workflows | local journal under `~/.claude/projects/<proj>/<sid>/workflows/` | streaming |

All polls are bounded by deadline; if a source is slow it degrades to "stale"
in the UI rather than blocking the daemon loop.

## 6. Daemon — `mishkan-watchd`

### 6.1 Stack

- **Python 3.11+**, `asyncio` for the event loop.
- `watchdog` for inotify on the NDJSON bus.
- `httpx` for Cognee MCP health/cypher.
- Standard `socket` for the UNIX socket server.
- Distributed as `uv tool install mishkan-watchd` from the harness payload.

### 6.2 State model

The daemon holds a single in-memory dataclass tree:

```
HarnessState
├── sessions: dict[session_id, SessionState]
│     ├── project: str
│     ├── started: datetime
│     ├── agents_active: list[AgentState]
│     ├── workflows_active: list[WorkflowState]
│     └── recent_events: ring buffer (last 200)
├── worktrees: dict[path, WorktreeState]
├── cognee:
│     ├── work: { up: bool, nodes: int, last_ingest: datetime }
│     └── curated: { up: bool, nodes: int }
└── hooks:
      └── recent_fires: ring buffer (last 50)
```

Nothing persisted. Daemon restart = empty state, refilled from current
filesystem within ~10 seconds.

### 6.3 Protocol

UNIX socket `~/.claude/mishkan/run/watch.sock`. Line-delimited JSON.

On connect: client receives one `snapshot` frame with the full `HarnessState`,
then a stream of `delta` frames for every change. Heartbeat every 5 s.

```
> {"op": "subscribe", "filter": null}
< {"type": "snapshot", "state": {...}}
< {"type": "delta", "path": "sessions.47a05.../agents_active", "op": "add", "value": {...}}
< {"type": "heartbeat", "ts": "..."}
```

This protocol is intentionally simple — no schema versioning yet, no
authentication beyond the socket file's POSIX permissions (0600, owner-only).

### 6.4 Lifecycle

- `mishkan-watchd start` — foreground; `systemd --user` or a tmux pane.
- `mishkan-watchd stop` — SIGTERM, drains in ≤2 s.
- No auto-restart, no PID file dance. If the daemon dies, the engineer notices
  in the TUI (heartbeat stops) and runs `start` again.

## 7. TUI client — `mishkan-watch`

### 7.1 Stack

- **Textual ≥ 0.80** (Python).
- `uv tool install mishkan-watch` from the harness payload.
- Same Python, same dependency footprint as the daemon — they can be installed
  together via a single `uv tool install mishkan-observability` meta-package.

### 7.2 Global layout + design grammar

Reference lineage: **k9s** (DataTable + colored-status-column),
**btop** (sparkline-density-in-fixed-height), **lazygit** (pane navigation
with sliding focus ring), **gh dash** (card-row metaphor). Synthesis:
ops-grade terminal dashboard, maximum information density with strong
visual grammar so the eye never has to search.

The grid IS the design. No decorative whitespace anywhere. Vertical rhythm
is enforced by box-drawing dividers with semantic weight: `═══` separates
logical zones, `───` separates rows within a panel, `║` marks an active
workflow's left edge, `┃` marks the focused list item.

Global frame (120 cols × 40 lines target):

```
Line  1     ┌── top bar (tab bar + global indicators) ── 1 line, anchored ──┐
Lines 2–37  │  main content area (tab-specific layout)                       │
Line 38     ├── detail pane (0 lines closed, 0–8 lines open, slides on enter)│
Line 39     ├── status bar (1 line, SACRED — always visible)                 │
Line 40     └── keybind footer (1 line, dim, hidden below 30 lines)          │
```

No permanent sidebar — each tab owns its internal split, avoiding wasted
columns on tabs that don't need navigation chrome. Detail pane is modal
(opens on `enter`, closes on `esc`). Status bar is non-negotiable.

Degradation:

- **80 cols** — 3-col and 2-col tabs collapse to single-column stacked via a
  `layout--compact` CSS class toggled on `on_resize`.
- **24 lines** — keybind footer hidden first, then detail pane max drops
  from 8 → 4. Primary panels never disappear.

### 7.3 Tab decomposition

**Tab 1 — Live (default).** First-eye target: the currently-running agent
name + the tool it is calling right now. Top-left quadrant, bold + bright
status dot.

4-panel grid: ACTIVE roster (32% left, top) + FEED rolling event stream
(68% right, top) + WORKTREES (left bottom, ~8 lines) + KNOWLEDGE compact
(right bottom, ~8 lines). Widgets: custom `Static`+Rich for the roster
(avoids DataTable chrome), `RichLog` with `auto_scroll=True` + pause on
cursor-in-region for the FEED, `Static` blocks for worktrees and knowledge.
Hierarchy: bright agent name (primary) → workflow phase progress bar
(secondary) → feed (tertiary peripheral reading) → knowledge + worktrees
(quaternary confirmatory glance).

**Tab 2 — Agents.** First-eye target: agents in error right now. Red rows
visually heavier than anything else on screen.

3-column: SESSIONS tree (`Tree`, 19% left) + AGENT HISTORY (`DataTable`
with `time│type│tool│outcome│ms│tokens`, row-colored on `errored`/`blocked`,
52% center) + ERRORS panel (`ListView` of 3-line cards per error, 29%
right). Sessions tree drives the center DataTable. Empty errors panel shows
dim `no errors` centered.

**Tab 3 — Workflows.** First-eye target: currently-executing phase name +
how many agents are in-flight in parallel. Fan-out count is the key number.

2-panel: WORKFLOW LIST cards (`ListView`, 25% left, each card = 4 lines
with inline `ProgressBar` for phase progress + token/$ spend) + PHASE TREE
detail (`Tree`, 75% right, root=workflow, level-1=phases, level-2=`agent()`
calls). When a phase has multiple agents in-flight (`workflow_stage`
items_in_flight > 1), inject a `ProgressBar`-row between the phase node and
its children — e.g. `▓▓▓▓▓▓▒▒▒▒▒▒▒▒░░░░  3/7 complete`. `workflow_barrier_wait`
adds a `⏸ barrier` badge with dim pulsing on the phase node. Schema
validation: `Static` strip below the tree with pass-rate fraction + mini
sparkline of last 10 outcomes (green/red ticks).

**Tab 4 — Knowledge.** First-eye target: are the two Cognee stores up. A
DOWN store is immediately a red block.

3-row stacked: COGNEE STORES (two side-by-side `Static` cards 50/50 — store
name, UP/DOWN badge, node count in `[bold]` large, last-ingest timestamp,
sparkline `▁▂▃▄▅▆▇█` from node-count delta over 12 polls) + RECENT OPS
(`DataTable` with `time│store│op│query/path│duration_ms│nodes_delta`,
cognify ops dim vs search ops bright) + MCP SERVERS (`DataTable` with
`server│status│since│last_event` — covers Cognee + Canva + Gmail + every
other MCP, not Cognee-only).

**Tab 5 — Activity.** First-eye target: most recent significant event.
`error` and `permission_blocked` break the visual rhythm of the stream.

Single-panel + filter bar: FILTER (`Input` regex + two `Select` dropdowns
type/agent + clear `Button`, 1 line) + STREAM (`RichLog` with per-line
type-coloring via Rich markup). `error` events get a `[bold red]` prefix
plus a `━━━` separator line above to break the rhythm. `permission` events
get `[yellow]` plus a `!` prefix. `compaction` events get a dim `[italic]`
style — informational, not urgent. Auto-scroll on by default, pauses when
the user scrolls up (indicator in top-right: `↓ auto` green → `⏸ paused`
dim; `End` key resumes).

### 7.4 Color, typography, iconography

Color palette as Textual CSS tokens (`$token`), designed for dark
background (default) with a light-background inversion set.

| Token | Hex (dark) | ANSI 256 | Function |
|---|---|---|---|
| `$color-running` | `#00D4AA` | 38 | agent/workflow actively executing |
| `$color-idle` | `#4A5568` | 240 | agent present but not in a call |
| `$color-done` | `#68D391` | 70 | completed successfully |
| `$color-error` | `#FC8181` | 196 | any errored outcome, schema fail, DOWN |
| `$color-warn` | `#F6AD55` | 214 | blocked permission, barrier wait, stale |
| `$color-info` | `#63B3ED` | 33 | informational events (web_query, etc.) |
| `$color-dim` | `#4A5568` | 238 | secondary text, timestamps |
| `$color-muted` | `#2D3748` | 235 | background fills for inactive panels |
| `$color-accent-1` | `#B794F4` | 135 | workflow-domain events (reserved) |
| `$color-accent-2` | `#F687B3` | 204 | knowledge-domain events (reserved) |
| `$color-surface` | `#1A202C` | 234 | panel backgrounds (near-black) |
| `$color-border-heavy` | `#718096` | 243 | `═══` zone separators |
| `$color-border-light` | `#2D3748` | 235 | `───` row separators |
| `$color-focus-ring` | `#4299E1` | 27 | active pane border highlight |
| `$color-bg` | `#0F1117` | 232 | root background (true dark) |

Usage rules (enforced in CSS):

- `running` is ONLY for agents/workflows currently executing. Not for
  "recent" or "healthy".
- `error` is ONLY for confirmed failures (outcome=errored, schema_valid=false,
  mcp_server=DOWN). Never for warnings.
- `warn` covers ambiguous states: stale data, pending barriers, blocked
  (not failed) permissions.
- `accent-1` (purple) is reserved for workflow-domain events, never used on
  a state word.
- `accent-2` (pink) is reserved for knowledge-domain events.
- Domain accents are applied consistently across ALL tabs.

Typography hierarchy (Rich markup only; no font-size control in terminals):

- `[bold]` — agent name when running, phase name when active, node counts.
- normal weight — standard rows, timestamps, tool names.
- `[dim]` — secondary metadata (duration_ms, idle agents, old timestamps).
- `[italic dim]` — compaction events, stale indicators — informational.
- `[blink]` — **never**, no exceptions. Textual supports it; we do not use it.

Box-drawing discipline:

- `═══` / `╔╗╚╝` — zone borders (heavy, only at layout boundaries).
- `───` / `┌┐└┘` — panel internal dividers (light).
- `│` — column separator within DataTable cells (avoids Textual's built-in
  column border which adds too much chrome).
- `║` — reserved for the "active workflow" left-edge indicator
  (thick, colored `$color-accent-1`).
- `┃` — reserved for the "focus ring" left-edge indicator on focused list
  items.

Unicode status vocabulary, consistent across ALL tabs:

```
●        agent/service running               (color: $color-running)
○        agent/service idle                  (dim)
◉        agent running AND selected/focused
✓        completed successfully              ($color-done)
✗        errored                             ($color-error)
⏸        barrier wait / paused / permission pending  ($color-warn)
▸        collapsible node closed (tree)
▾        collapsible node open (tree)
▲        metric going up
▼        metric going down
█▆▅▃▁    sparkline chars (node count delta, token rate)
⟳        stale / polling                     ($color-warn dim)
⚡        skill invoke (brief flash only, clears after 2 s)
?        unknown / data not available — NEVER fabricated
```

### 7.5 Micro-interactions

Every micro-interaction has a single purpose: confirm a state change
visibly without persisting motion. No animation library required — Textual
CSS classes + `set_timer` cover every effect below.

- **Pane focus.** Border switches from `$color-border-light` to
  `$color-focus-ring` (blue). One CSS transition. No other visual change.
- **Agent spawn.** New row inserted at top of ACTIVE with
  `$color-running` background for 800 ms, then settles to normal weight.
  In the FEED, the `agent_spawn` line gets a leading `●` in
  `$color-running`. The agent does not just appear — it materializes with
  color and fades.
- **Agent complete.** Dot flips from `●` (running) to `✓` (done) with a
  400 ms window where the row background is `$color-done` at 15% opacity.
  Then the agent moves to the idle section.
- **Tab switch.** Instantaneous — no slide animation. Active tab label
  goes `[bold]` + underline in `$color-focus-ring`. Motion is reserved for
  state change, not navigation.
- **Filter activation (Tab 5).** Pressing `/` focuses the `Input`. As
  soon as input is non-empty, the stream panel title changes from
  `ACTIVITY` to `ACTIVITY [filtered]` in `$color-warn` — confirms the
  filter is active even when the user looks away from the input box.
- **Error arrival.** Off-focus tab gets a `!` suffix on its label in
  `$color-error`, cleared when the user visits the tab. In the Tab 1 FEED,
  the error line gets a `━━━━` separator above it that breaks the rhythm.
  No sound, no notification, no external alert — observer-only.
- **Workflow phase transition.** New phase node in the Tab 3 tree
  auto-expands and gets `$color-accent-1` background for 600 ms. The
  previous phase node gets a `✓` prefix and dims. Visual hand-off
  between phases.
- **Sparkline tick.** The only continuous animation. One column advance
  per data tick, aligned to the daemon poll (every 5 s). No interpolation.
- **Detail pane open.** `enter` on a focused row: pane slides up from
  the bottom consuming 8 lines (or 4 below 26-line terminals). Main
  content shrinks. Inside: a `Markdown` widget with the event JSON
  pretty-printed. `esc` closes.

### 7.6 Reference mockups

**Mockup A — Tab 1: Live (120 × 40)**

```
╔═ mishkan-watch ════════╤══════════════════════════════════════════════════════════════╗
║ ●1 Live  ○2 Agents  ○3 Workflows  ○4 Knowledge  ○5 Activity!        2 sessions  12:03 ║
╠══ ACTIVE ══════════════╪══ FEED ════════════════════════════════════════════════════════╣
║ ● bezalel  02:14  ADR  ║ 12:01:55  tool_call    bezalel  Read        └ harness.md  ok  ║
║   └─ Write  skill-ref  ║ 12:01:58  hook_fire    ira      pre-sec     ok                ║
║ ● caleb    00:42  web  ║ 12:02:04  mcp_server   cognee   search "graphify" 312ms       ║
║   └─ WebFetch          ║ 12:02:09  agent_spawn  ───────────────────────────────────    ║
║ ○ nehemiah  idle       ║           ● caleb      launched  wf-D008  phase-2             ║
║ ○ baruch    idle       ║ 12:02:24  permission   ───────────────────────────────────    ║
║ (6 more idle)          ║ ⏸         bezalel  Bash "rm -rf /tmp/x"  pending              ║
║                        ║ 12:02:33  file_change  bezalel  Write  +47/-3  schema.json    ║
║ ─── WORKFLOWS ─────────║ 12:02:38  token_usage  bezalel  12.4k in  380 out  $0.18      ║
║ ║ D-008  phase 2/4     ║ 12:02:56  inter_agent  caleb→bezalel  "analysis complete"     ║
║   Research pipeline    ║ 12:03:04  compaction   bezalel  88k→14k  context reset       ║
║   ▓▓▓▓▓▒▒▒░░░  50%     ║ 12:03:17  mcp_server   canva    DOWN  ─ since 11:50           ║
║   $1.20  14k tokens    ║ 12:03:22  file_change  bezalel  Edit  +12/-0  agents.md      ║
╠══ WORKTREES ════════════╝                                                              ║
║ wf-001  caleb                                                                          ║
║ ad-008  bezalel                                                                        ║
╠══ KNOWLEDGE ═══════════════════════════════════════════════════════════════════════════╣
║ cognee-work  ● UP  1,247 nodes ▁▁▂▃▃▅▆█    cognee-cur  ● UP  96 nodes  ▁▁▁▁▂▂▃▃       ║
║ mcp:  ● cognee   ✗ canva   ● gmail                                                     ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║ ⏵ 02h14m · 142.4k in · 18.2k out · 89.1k cached · est. $2.40 · 2 active · 1 wf        ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║ 1-8 tabs · / filter · enter detail · q quit · ? help · t time-order · r refresh       ║
╚════════════════════════════════════════════════════════════════════════════════════════╝
```

**Mockup B — Tab 3: Workflows (120 × 40)**

```
╔═ mishkan-watch ════════╤══════════════════════════════════════════════════════════════╗
║ ○1 Live  ○2 Agents  ●3 Workflows  ○4 Knowledge  ○5 Activity        2 sessions  12:03 ║
╠══ WORKFLOWS ═══════════╪══ PHASE TREE ══════════════════════════════════════════════════╣
║ ║ D-008 research-pipe  ║  ▾ research-pipeline                          run 00:14       ║
║   Research pipeline    ║    script: research-pipeline.py                                ║
║   phase 2/4  ▓▓▓▒░ 50% ║    model:  sonnet4 (agents) / haiku (checks)                  ║
║   $1.20 · 14.2k tok    ║                                                                ║
║                        ║  ✓ phase 1 — context-gather         done    00:04  $0.31      ║
║ ○ D-007 sprint-close   ║    ✓ bezalel  gather-context  haiku  ✓  1240ms  2.1k tok     ║
║   phase 4/4  done ✓    ║    ✓ nehemiah gather-backlog  haiku  ✓   980ms  1.8k tok     ║
║   $0.87 · 9.4k tok     ║                                                                ║
║                        ║  ▾ phase 2 — parallel-analysis      active  00:10  $0.89      ║
║ ○ E-004 doc-audit      ║    ┌── fan-out: 3 of 5 complete ──────────────────────────┐   ║
║   phase 1/3  ▓▒░ 33%   ║    │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒▒░░░░░░░░░░  3/5              │   ║
║   $0.34 · 3.8k tok     ║    └────────────────────────────────────────────────────────┘   ║
║                        ║    ✓ caleb    source-a       sonnet ✓  2100ms  3.4k tok      ║
║                        ║    ✓ miriam   source-b       sonnet ✓  1890ms  2.9k tok      ║
║                        ║    ✓ levi     source-c       sonnet ✓  3200ms  4.1k tok      ║
║                        ║    ● ezra     source-d       sonnet ●  running  1.2k tok ↗   ║
║                        ║    ● yoav     source-e       sonnet ●  running  0.8k tok ↗   ║
║                        ║                                                                ║
║                        ║  ○ phase 3 — synthesis              pending                    ║
║                        ║  ○ phase 4 — validation             pending                    ║
║                        ║                                                                ║
║                        ║  ────────────────────────────────────────────────────────────  ║
║                        ║  schema validation  ✓✓✓✓✓✓✓✓✓✗✓  10/11 pass  ▁▁▁▁▁▁▁▁▆▁▁    ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║ ⏵ 02h14m · 142.4k in · 18.2k out · 89.1k cached · est. $2.40 · 2 active · 3 wf        ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║ 1-8 tabs · enter detail · ←/→ select wf · ▸/▾ expand · / filter · q quit · ? help     ║
╚════════════════════════════════════════════════════════════════════════════════════════╝
```

**Mockup C — Tab 2: Agents (120 × 40)**

```
╔═ mishkan-watch ════════╤══════════════════════════════════════════════════════════════╗
║ ○1 Live  ●2 Agents  ○3 Workflows  ○4 Knowledge  ○5 Activity!       2 sessions  12:03 ║
╠══ SESSIONS ════════╤══ AGENT HISTORY ══════════════════════════╤══ ERRORS ═══════════╣
║ ▾ harness          │ time      type        tool/skill   ok ms  tok│ ● bezalel  12:02 ║
║   ▾ 47a05817…      │ 12:03:22  file_change Edit  +12/-0  ✓   8ms 0│   schema fail   ║
║     ◉ bezalel  ●   │ 12:03:14  tool_call   Write       … pending  │   field "agent" ║
║     ● caleb    ●   │ 12:02:33  file_change Write +47/-3 ✓ 280ms 0 │   missing       ║
║     ○ baruch       │ 12:02:24  hook_fire   ira pre-sec  ✗   3ms 0 │   ─────────     ║
║     ○ nehemiah     │ 12:02:09  agent_spawn caleb       ✓   0ms 0  │ ● caleb    11:58 ║
║   ○ ad-008…        │ 12:01:58  hook_fire   ira pre-sec  ✓   2ms 0 │   WebFetch 5xx  ║
║                    │ 12:01:55  tool_call   Read harness.md ✓ 0  0│   timeout       ║
║ ▸ aiobi-mail       │ 12:01:42  skill_invoke deep-research ✓ 0   0 │   retry queued  ║
║   ○ 3f12a8…        │ 12:01:31  plan        Enter   approved 0  0 │   ─────────     ║
║   (idle)           │ 12:01:18  tool_call   Edit   +3/-1   ✓ 8ms 0│ (no errors      ║
║                    │ 12:00:55  permission  Bash    allow  ✓ 0  0 │  for the         ║
║ ▸ aiobi-docs       │ 12:00:42  tool_call   Read   foo.py  ✓ 0  0│  other agents)  ║
║   (no live agent)  │ 11:59:33  inter_agent caleb→  summary 0  0  │                  ║
║                    │ ────── older history (scroll) ──────────    │                  ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║ ⏵ 02h14m · 142.4k in · 18.2k out · 89.1k cached · est. $2.40 · 2 active · 1 wf       ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║ 1-8 tabs · enter detail · j/k row · tab pane · / filter · q quit · ? help            ║
╚════════════════════════════════════════════════════════════════════════════════════════╝
```

Color: `◉` selected agent (`$color-focus-ring`), `●` running (`$color-running`),
`○` idle (`$color-dim`). History rows with `outcome=errored` rendered with
`$color-error` background at 15%; `outcome=blocked` with `$color-warn`. Errors
panel right: top-anchored per-agent cards, separator `─────` between cards,
empty state dim-centered.

**Mockup D — Tab 4: Knowledge (120 × 40)**

```
╔═ mishkan-watch ════════╤══════════════════════════════════════════════════════════════╗
║ ○1 Live  ○2 Agents  ○3 Workflows  ●4 Knowledge  ○5 Activity       2 sessions  12:03 ║
╠══ COGNEE STORES ═══════════════════════════════════════════════════════════════════════╣
║                                                                                        ║
║   ╭─ cognee-memory :7777 ──────────╮   ╭─ curated :7730 ──────────────╮                ║
║   │ ● UP  · 02h14m                │   │ ● UP  · 43h12m               │                ║
║   │ session memory only           │   │                              │                ║
║   │ 1,247 nodes                   │   │   96 nodes                   │                ║
║   │ ▁▁▂▃▃▅▆█  +12 last 5min       │   │ ▁▁▁▁▂▂▃▃  +0  last 30min     │                ║
║   │ last ingest  12:02:14         │   │ last seed   2026-05-29       │                ║
║   │ embeddings: gemini  3072d     │   │ embeddings: ollama  768d     │                ║
║   ╰───────────────────────────────╯   ╰──────────────────────────────╯                ║
║                                                                                        ║
╠══ RECENT OPS ═════════════════════════════════════════════════════════════════════════╣
║ time      store    op      query / path                       ms      Δnodes          ║
║ 12:03:14  work     search  "graphify token saving"            312     ─               ║
║ 12:02:38  work     add     ADR D-008 (research-pipe…)         1840    +12             ║
║ 12:02:04  work     search  "graphify"                         298     ─               ║
║ 12:01:42  curated  search  "textual TUI patterns"             201     ─               ║
║ 12:00:55  work     cognify docs/design/MISHKAN_…md             12450  +8              ║
║ ─── graphify scans/queries ──────────────────────────────────────────────             ║
║ 11:58:22  harness  scan    full repo                          14200   3892 nodes      ║
║ 11:55:01  harness  query   "process_payment callers"          45      6 hits          ║
║                                                                                        ║
╠══ MCP SERVERS (5) ════════════════════════════════════════════════════════════════════╣
║ server          status   since      last event                                         ║
║ cognee-work     ● UP     43h12m     12:03:14 search                                   ║
║ cognee-curated  ● UP     43h12m     12:01:42 search                                   ║
║ canva           ✗ DOWN   11:50:22   ─ no event since                                  ║
║ gmail           ● UP     02h14m     11:32:08 list-comments                            ║
║ google-drive    ⟳ STALE  ─          12:02:55 last probe ok                           ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║ ⏵ 02h14m · 142.4k in · 18.2k out · 89.1k cached · est. $2.40 · 2 active · 1 wf       ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║ 1-8 tabs · enter detail · j/k row · tab pane · / filter · q quit · ? help            ║
╚════════════════════════════════════════════════════════════════════════════════════════╝
```

Color: store cards bordered in `$color-border-light` when UP, `$color-error`
when DOWN. Node count in `[bold]` large. Sparkline coloured `$color-accent-2`
(knowledge domain). Recent ops: `cognify` rows dim, `search` rows normal,
`add` rows `[bold]` for the writes. MCP table row color from `status`:
green / red / yellow / dim. `⟳` for STALE (poll deadline missed, not down).

**Mockup E — Tab 5: Activity (120 × 40)**

```
╔═ mishkan-watch ════════╤══════════════════════════════════════════════════════════════╗
║ ○1 Live  ○2 Agents  ○3 Workflows  ○4 Knowledge  ●5 Activity!      2 sessions  12:03 ║
╠══ FILTER ══════════════════════════════════════════════════════════════════════════════╣
║ / [_____________________]  type: all ▾   agent: all ▾   [clear]            ↓ auto    ║
╠══ STREAM (unified, all 6 event streams) ══════════════════════════════════════════════╣
║ 12:03:22  file_change   bezalel  Edit  +12/-0  agents.md                              ║
║ 12:03:19  hook_fire     ira      pre-sec  ok                                          ║
║ 12:03:17  mcp_server    canva    DOWN  ─ since 11:50                                  ║
║ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ║
║ 12:03:14  error         caleb    schema_fail  field "outcome" missing                 ║
║ 12:03:11  cron_event    sprint-close   scheduled  next: 14:00                         ║
║ 12:03:08  web_query     caleb    WebSearch  "MCP protocol spec"                       ║
║ 12:03:04  compaction    bezalel  88k → 14k  context reset                             ║
║ 12:03:01  tool_call     bezalel  Write   pending                                      ║
║ 12:02:56  inter_agent   caleb→bezalel  "analysis complete"                            ║
║ 12:02:51  agent_spawn   ● levi   launched  wf-D008  phase-2                          ║
║ 12:02:46  skill_invoke  caleb    deep-research  "graphify"                            ║
║ 12:02:41  tool_call     caleb    WebFetch  ✓ 1240ms                                   ║
║ 12:02:38  token_usage   bezalel  12.4k in  380 out  $0.18                             ║
║ 12:02:33  file_change   bezalel  Write  +47/-3  schema.json                           ║
║ 12:02:28  plan          bezalel  ExitPlan  approved                                   ║
║ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ║
║ ⏸ 12:02:24  permission  bezalel  Bash "rm -rf /tmp/x"  pending                        ║
║ 12:02:19  worktree+     wf-001   caleb  new                                           ║
║ 12:02:14  tool_call     caleb    WebFetch  pending                                    ║
║ ─── older (scroll up) ─────────────────────────────────────────────────              ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║ ⏵ 02h14m · 142.4k in · 18.2k out · 89.1k cached · est. $2.40 · 2 active · 1 wf       ║
╠════════════════════════════════════════════════════════════════════════════════════════╣
║ 1-8 tabs · / filter focus · t order · End auto · j/k scroll · enter detail · q quit  ║
╚════════════════════════════════════════════════════════════════════════════════════════╝
```

Color: `error` rows `[bold red]` preceded by `━━━━` separator that breaks
rhythm. `permission` pending rows prefixed `⏸` in `$color-warn`. `compaction`
in `[italic dim]` (informational). Auto-scroll indicator top-right: `↓ auto`
in `$color-running` when active, `⏸ paused` in `$color-dim` when user
scrolled up. `End` resumes auto.

### 7.7 Widget mapping

| Pattern | Textual widget | Notes |
|---|---|---|
| Agent roster (live status dots + uptime) | `Static` + Rich markup | Custom render avoids DataTable chrome |
| Event feed (rolling, auto-scroll, pause) | `RichLog` | `auto_scroll=True`, pauses via `on_focus` |
| Phase tree (workflow hierarchy, collapsible) | `Tree` | Built-in expand/collapse; Rich-markup labels |
| Session tree (Tab 2 left) | `Tree` | Same widget, different data |
| Per-agent event history | `DataTable` | `cursor_type="row"`, row-colored on outcome |
| Error list cards | `ListView` + custom `ListItem` | 3-line `Static` block per item |
| Workflow card list (Tab 3 left) | `ListView` + custom `ListItem` | Inline `ProgressBar` inside each card |
| Fan-out progress (parallel agents) | `ProgressBar` | `total=N, progress=K` |
| Sparklines (nodes, tokens, schema trend) | `Sparkline` | 12 data points max, daemon-delta-driven |
| Cognee store cards | `Static` × 2 side-by-side | Large bold number + dim unit + sparkline |
| MCP server status table | `DataTable` | Row color driven by status field |
| Activity stream (filterable) | `RichLog` | Client-side filter: clear + replay from ring buffer |
| Filter bar | `Input` + `Select` × 2 + `Button` | 1-line `Horizontal` container |
| Detail pane | `Markdown` in `VerticalScroll` | Mount/unmount on enter/esc |
| Status bar (permanent) | `Static` in `Footer`-position | Outside `TabbedContent`, always rendered |
| Tab bar | `Tabs` | Label updated with `!` badge on error arrival |
| Agent-spawning flash | CSS class + `set_timer` | `.agent-spawning` background, timer removes |

### 7.8 UX invariants (non-negotiable)

These are perceptual contraints the implementation must respect — derived
from cognitive load, scanability, and long-session ergonomics analysis.
Violating one of these is a design defect, not a stylistic choice.

1. **Maximum 5 primary panels per tab.** Miller's limit; beyond that the
   eye saturates. If a 6th dimension matters, it replaces one — never
   adds.
2. **Execution state is ALWAYS the dominant color.** Pre-attentive
   perception (< 250 ms) latches on color first. State colors
   (running/done/error/warn) own that channel; type/severity/freshness
   use symbol, border, position, saturation instead.
3. **Maximum 10 lines per primary panel on Tab 1.** Scannable in
   < 1.5 s. The ACTIVE roster shows 6 active + "N more idle"; the FEED
   shows 28 rolling events; the rest stays tight.
4. **No blink, no pulse > 1.5 Hz.** Long sessions become physiologically
   stressful otherwise. Pulses for hard-error attention max at
   1.5 Hz (666 ms cycle). Sparklines tick at the daemon poll rate (5 s).
   Nothing else moves.
5. **Strict monospace alignment.** Status symbol at x=constant per panel.
   Column-aligned DataTables. No ragged indentation. Gestalt continuity
   carries the scan.
6. **Whitespace ≥ 1 line between primary panels.** Enforced by the
   `═══` heavy zone separators. Gestalt enclosure makes the categories
   perceptually distinct without depending on color.
7. **Status bar is sacred.** Cost, session age, active fan-out — always
   visible across every tab. No tab gets to hide it, no key dismisses it.
8. **No auto-scroll surprise.** FEED and Activity stream pause as soon
   as cursor enters the panel (or `End` is released). The engineer drives
   the read pace; the TUI doesn't whisk text away.
9. **Symbols encode state · text encodes identity.** Never both. A
   running agent is `●` + name + activity — never `●` + "running" + name.
   The dot already says it. Redundancy is cognitive cost.
10. **Position encodes entity type.** Agents always top-left, workflows
    always center-left, knowledge always right, MCP/external always
    bottom. The layout is learned once, then scanned without lookup.
11. **Unknown is `?`, never a fabricated value.** If the model didn't
    report `usage`, the tokens field shows `?`. If a poll is stale, the
    sparkline shows `⟳`. The TUI never invents a number to fill a slot.
12. **The Live tab answers ONE question: "what is happening right now?"**
    History is somewhere else. Anything that doesn't answer that question
    in 2 seconds doesn't belong on Tab 1 — it belongs on Activity or its
    domain tab.

### 7.9 Interaction summary

- **1-5** — switch tab (instantaneous)
- **j/k** or **↑/↓** — move focus within current panel
- **tab/shift-tab** — move focus between panels of current tab
- **/** — open filter (Tab 5)
- **enter** — open detail pane on focused row
- **esc** — close detail pane / clear filter
- **t** — toggle time order in FEED (newest-first ↔ oldest-first)
- **r** — force daemon resync (rarely needed)
- **?** — show keybind help modal
- **q** — quit

## 8. Hook enrichments needed

Current `post-tool-observe.sh` records `agent: null`, `team: null`,
`sprint: null`. To populate them at emit time:

- **`post-tool-observe.sh`** — when `tool_name == "Task"`, read the subagent
  type and id from the hook payload and emit a `agent_spawn` event alongside
  the `tool_call`.
- **New `pre-tool-trace.sh`** — PreToolUse hook that records `start_ms` per
  `(session, tool, call_id)` into a small in-memory dict file under
  `/tmp/mishkan-trace-<session>.tmp`; the PostToolUse hook diffs against it for
  `duration_ms`.
- **`model-route.py`** — adds one line: `bus.emit("hook_fire", payload={...})`.
- **`pre-tool-security.sh`** (Ira) — same one-liner.

All emitters share a tiny helper `payload/mishkan/observability/bus.sh` that
encapsulates `jq` + the append. Fail-open on absence of `jq`, same as today.

## 9. Repo layout

```
payload/mishkan/observability/
├── README.md
├── bus.sh                   # shell emitter helper
├── bus.py                   # Python emitter (for hook scripts in Python)
├── schema.json              # JSON Schema for event types
├── watchd/                  # daemon source
│   ├── pyproject.toml
│   ├── src/mishkan_watchd/
│   │   ├── __main__.py
│   │   ├── state.py
│   │   ├── sources/         # bus_tail, worktree_poll, cognee_poll, session_discover
│   │   ├── server.py        # UNIX socket NDJSON
│   │   └── lifecycle.py
│   └── tests/
└── watch/                   # TUI client source
    ├── pyproject.toml
    ├── src/mishkan_watch/
    │   ├── __main__.py
    │   ├── app.py           # Textual App
    │   ├── tabs/            # live.py, agents.py, workflows.py, knowledge.py, hooks.py
    │   └── client.py        # daemon socket client
    └── tests/
```

Runtime data:
- `~/.claude/mishkan/logs/*.jsonl` — already exists.
- `~/.claude/mishkan/run/watch.sock` — daemon UNIX socket.
- `/tmp/mishkan-trace-<session>.tmp` — ephemeral PreToolUse trace.

All runtime paths already gitignored under `**/logs/`, `**/*.jsonl`.

## 10. Installation contract

What the existing `npx mishkan-harness install` ships automatically vs.
what is opt-in via a separate runtime install. The contract is split by
**runtime dependency**, not by phase number — anything in pure shell or
that runs as a one-shot hook is in the Node installer's reach; anything
that requires Python or a long-running process is opt-in.

### 10.1 Auto-installed (npx mishkan-harness install)

Everything below ships when the engineer runs `npx mishkan-harness install`.
No additional runtime required.

- **Hook scripts** — `bus.sh`, `pre-tool-trace.sh`, the enriched
  `post-tool-observe.sh`, the one-line emitter additions in
  `model-route.py` and `pre-tool-security.sh`. All shell, all already
  reach `~/.claude/mishkan/hooks/` via the existing payload sync.
- **Hook fragment merge** into `settings.json` — already handled by the
  installer's hook-merge step; no new logic needed beyond declaring the
  new hooks in the fragment.
- **Token usage parser** (`payload/mishkan/observability/usage_parser.py`)
  — Python, but invoked one-shot from the PostToolUse hook (not a
  daemon). Requires Python 3 available; degrades gracefully to a no-op
  when Python is missing.
- **Event schema** (`payload/mishkan/observability/schema.json`) — pure
  reference, no runtime.

Effect: immediately after install, all 25+ event types start landing in
`~/.claude/mishkan/logs/<session>.jsonl`. The engineer can `tail -f` or
pipe to `jq` for primitive observability without the daemon or TUI.

### 10.2 Opt-in (uv tool install)

The daemon and TUI require Python 3.11+ with `uv` available. The Node
installer does NOT bring them up automatically. Two reasons:

1. Node→Python orchestration would force `uv` (or `pip`) as a hard
   prerequisite on every harness install, even for engineers who don't
   want the TUI.
2. The daemon is long-running. Auto-starting it on install would force a
   lifecycle decision (systemd-user vs. tmux vs. shell autostart) that
   belongs to the engineer.

The installer ends with a detection + offer flow:

```
[uv detected] Install observability stack (daemon + TUI)? [Y/n]
  → uv tool install --from ~/.claude/mishkan/observability/watchd mishkan-watchd
  → uv tool install --from ~/.claude/mishkan/observability/watch  mishkan-watch

[uv missing] Observability TUI requires uv.
  Install it: curl -LsSf https://astral.sh/uv/install.sh | sh
  Then run:   npx mishkan-harness install --observability
```

The `--observability` flag re-runs only the opt-in step.

### 10.3 Daemon lifecycle

Daemon start is always manual; the installer never starts a long-running
process. After opt-in install completes:

```
✓ mishkan-watch installed
  Start the daemon: mishkan-watchd start
  Open the TUI:     mishkan-watch
```

For engineers who want auto-start, a follow-up command:

```
mishkan-watchd install-service     # generates ~/.config/systemd/user/mishkan-watchd.service
```

This stays explicit — the engineer chooses whether a daemon lives across
reboots.

### 10.4 Uninstall

`npx mishkan-harness uninstall` removes the harness payload but does NOT
touch the `uv tool` installs. Symmetric to install: opt-in remains
engineer-managed. The uninstaller prints:

```
Observability stack installed via uv tool — remove manually if desired:
  uv tool uninstall mishkan-watch mishkan-watchd
```

### 10.5 Backward compatibility

The Phase 1 hook enrichments are **additive** to the existing
`post-tool-observe.sh` event shape (§4.4). Any current consumer that
reads only the original fields continues to work. Older harness installs
that have not been refreshed still emit valid (sparser) events; the
daemon handles missing fields by falling back to `null` / `unknown`.

## 11. Phasing

### Phase 1 — Bus enrichment, cheap event types (target: 1 working session)

- Add `bus.sh` helper.
- Extend `post-tool-observe.sh` for agent context + subagent spawn event.
- Add `pre-tool-trace.sh` (timing baseline for `duration_ms`).
- Add one-line emitters to `model-route.py` and `pre-tool-security.sh`.
- Emit `skill_invoke`, `plan`, `permission`, `file_change`, `error` from
  PostToolUse hook (all derivable from the existing payload).
- Emit `web_query`, `cron_event` similarly.
- Bus event schema written to `payload/mishkan/observability/schema.json`
  covering all activity-stream + code-effect-stream + external-call-stream
  event types.
- Update hook fragment in `payload/install/` so fresh installs pick them up.
- Existing consumers unaffected (backward-compatible extension — only new
  fields added).

### Phase 1.5 — Token usage parser (target: half a session)

- Separate from the hook bus because token data lives in the session JSONL
  `usage` blocks per assistant turn, not in tool payloads.
- Small parser `payload/mishkan/observability/usage_parser.py` that tails
  `~/.claude/projects/<proj>/<sid>.jsonl` and emits `token_usage` events
  into the bus.
- Model price table baked into the parser (one map, easy to update).
- Cost = sum of (input + output) × per-model rate; cache reads at the cache
  rate.

### Phase 2 — Daemon `mishkan-watchd` (target: 1 working session)

- Skeleton with asyncio loop.
- Source: bus tail via watchdog (covers all Phase 1 + 1.5 events).
- Source: worktree poll.
- Source: session discover.
- Source: MCP server health probe (one connect attempt per known MCP, every
  60 s — surfaces `mcp_server` status changes).
- Source: `inter_agent` extraction from Task notifications.
- Source: `compaction` events from session JSONL parser hook.
- UNIX socket server with snapshot+delta protocol.
- `uv tool install`-ready.

### Phase 3 — TUI `mishkan-watch` core (target: 2 working sessions)

- Textual app skeleton + daemon client.
- Tab 1 (Live) — 4 panels, default view.
- Status bar — permanent, all tabs (token + cost + session age + fan-out).
- Tab 5 (Activity) — unified stream with filter (most universally useful
  tab after Live; ships before Agents/Workflows because the stream is
  already complete from Phase 1+1.5).
- Tabs 2 (Agents), 3 (Workflows), 4 (Knowledge) — incrementally landed in
  subsequent sessions as their sources go live.
- Distributable via `uv tool install`.

### Phase 4 — Knowledge + workflow sources (target: 1 working session)

- Cognee work + curated node-count poll wired into daemon state.
- Workflow journal tail wired into daemon state — emits all §4.3 workflow
  event types (`workflow_start`, `workflow_phase`, `workflow_agent_call`,
  `workflow_agent_result`, `workflow_stage`, `workflow_barrier_wait`,
  `workflow_error`, `workflow_complete`).
- Graphify scan + query events — emitted by the Graphify integration when
  D-008/D-009 ship; consumed here.
- Tab 3 (Workflows) and tab 4 (Knowledge) populated.

Each phase is independently shippable. Phase 1 alone improves the existing
bus for any future consumer; Phase 1.5 adds cost visibility regardless of
the TUI; Phase 2 alone lets `journalctl`-style viewing via a small CLI
client; Phase 3 ships the live TUI experience; Phase 4 lights up the two
deeper tabs.

## 12. Honest gaps

- **Token attribution is parsed from session JSONL `usage` blocks** (Phase 1.5)
  — accurate when the model reports usage, `?` when it doesn't. Cache hit
  pricing is approximated against published rates per model id; rates can
  drift if Anthropic updates pricing without us refreshing the table.
- **Subagent attribution depends on `Task` hook payload shape.** If Claude
  Code changes the payload schema, the bus emitter needs an update.
- **Workflow phase progress** depends on the `Workflow` tool journal format
  on disk being stable (assumed yes from the tool description; verified
  before phase 4 ships).
- **Cognee node-count via cypher** requires a small query budget; if either
  store is busy under heavy cognify load the poll degrades to "stale".
- **MCP server health probe is shallow** — TCP connect + transport handshake,
  not "actually serves a real query". A server can appear up while broken
  internally; out of scope to deep-probe.
- **No authentication on the UNIX socket beyond filesystem perms.** Acceptable
  for single-user host; revisit if MISHKAN ever runs multi-user.
- **TUI depends on terminal capability** (256-color, Unicode); textual handles
  graceful degradation but very old terminals will look bad.
- **Inter-agent message capture is summary, not verbatim.** Subagent return
  values can be megabytes; the bus carries a 500-char summary plus the
  subagent's transcript path for the engineer to drill into manually if
  needed.
- **Compaction event detection** relies on session JSONL tagging compactions
  visibly; if Claude Code changes how compactions are logged, the
  `compaction` event type may go silent until the parser is updated.

## 13. Out of scope (explicit)

- Prometheus / OpenTelemetry exporters.
- Persistent metrics store (the bus IS the historical record; rotation is
  filesystem-driven, not by the daemon).
- Remote dashboards (web UI, mobile).
- Notifications / alerting (`mishkan-watch` is observed, not push).
- Multi-user authentication / RBAC on the daemon socket.
- Replay of historical sessions in the TUI (out of scope until phase ≥5).
- **Resource monitoring** — CPU / RAM / disk / network bytes. Not actionable
  at the harness layer; if a cognify pegs a core, the engineer sees it via
  the OS, not via `mishkan-watch`.
- **Verbatim prompt / response capture.** Full content lives in the session
  JSONL already; replicating it in the bus would multiply storage with no
  added insight. Activity stream carries summaries + JSONL paths.
- **GC / Python internals / framework telemetry.** Not our layer.

## 14. References

- `payload/mishkan/hooks/post-tool-observe.sh` — the existing seed.
- `payload/mishkan/hooks/model-route.py` — first hook to gain the emitter.
- `payload/mishkan/hooks/pre-tool-security.sh` — Ira, second hook to emit.
- `docs/design/MISHKAN_harness_design.md` §20 — Phase 8 observability, deferred.
- `docs/design/MISHKAN_decisions.md` D-008 — three-store knowledge surface
  (Knowledge tab content).
- Textual project — https://textual.textualize.io/.
- watchdog (Python file system events) — https://python-watchdog.readthedocs.io/.

---

*Once approved, this doc moves from "proposed" to "active" and Phase 1
implementation begins. Changes after activation go through an addendum
section, not rewrite.*
