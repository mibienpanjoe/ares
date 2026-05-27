# MISHKAN — Token Optimisation & Context Management

How the harness manages context and token usage **on top of Claude** — by
leveraging the platform's native primitives, not by replacing them. MISHKAN never
intercepts or rewrites a Claude request. It is a discipline of **input
composition**: arrange what enters each call so the Claude model's own cost and
context behaviour falls in the engineer's favour.

This is the operational detail behind §11 of `MISHKAN_harness_design.md`.

---

## 1. The cost model being optimised

Every agent run is one Claude API request. The model bills input tokens at two
rates and output at one:

```
   cost ≈ (uncached_input × 1.0) + (cached_input × ~0.1) + (output × 1.0)
```

- **Cached input** — a prefix byte-identical to a recent call is read from cache
  at roughly a tenth of the price (ephemeral cache, a few minutes' TTL).
- **Uncached input** — everything new or changed, at full price.
- **Output** — always full price.

Three levers follow directly, and every MISHKAN mechanism pulls one or more:
**(a) grow cached_input · (b) shrink uncached_input · (c) keep the whole window
small** so nothing resident wasn't needed.

---

## 2. Anatomy of one agent call

Claude Code assembles each request from fixed parts, in order. MISHKAN's
arrangement splits them into a stable, cacheable prefix and a variable suffix:

```
   ┌───────────────────────────────────────────────┐  ┐
   │ system prompt (Claude Code core)               │  │
   │ agent definition (.md role block + tools)      │  │  STABLE PREFIX
   │ ~/.claude/CLAUDE.md (engineer identity)        │  │  byte-identical
   │ y4nn-standards + engineer-standards            │  │  call-to-call
   │ matched path-scoped rules                      │  │  → CACHEABLE (~0.1x)
   ├───────────────────────────────────────────────┤  ┘
   │ project ./CLAUDE.md (sprint state)             │  ┐
   │ task / conversation so far                     │  │  VARIABLE SUFFIX
   │ tool results · Cognee summaries                │  │  → full price
   └───────────────────────────────────────────────┘  ┘
```

Every agent file enforces this with a trailing `## Dynamic Context Injection
Point` marker: everything above it is stable and caches; the changing sprint
state and task sit below.

---

## 3. The five mechanisms — native primitive × MISHKAN formulation

| # | Claude primitive (native) | MISHKAN formulation (input-shaping) | Lever |
|---|---|---|---|
| 1 | **Prompt caching** of a stable prefix | "static first, dynamic last" ordering in every agent; standards/rules above the injection point stay byte-stable | grow cached |
| 2 | **Subagent isolation** — each Task subagent has its own context window | the 45-agent org; heavy work runs in disposable child windows, only summaries return to the parent | shrink window |
| 3 | **Per-agent tool grants** + deferred tool schemas | tight `tools:` per agent (QA has no Write, reporters no Bash, Jakin only Read) | shrink uncached |
| 4 | **Rule loading by glob match** | path-scoped team rules (33–39 globs each); only 3 `common/` rules are always-on | shrink uncached |
| 5 | **MCP external store** | Cognee offloading — full artifacts to the graph, summary + node-id in context (`context-compress` skill) | shrink window |

### 3.1 Prompt caching — formulated by ordering

Caching fires only on a byte-identical prefix. Putting the role, standards, and
matched rules first makes them a stable prefix that caches; the variable task sits
last. Two calls to the same agent in a session pay full price only for what
differs:

```
   call #1 → Hizkiah:  [role+standards+rules][task A]   prefix WRITE (~1.25x once)
   call #2 → Hizkiah:  [role+standards+rules][task B]   prefix HIT (~0.1x); only task B full price
```

### 3.2 Subagent isolation — formulated by decomposition (the biggest lever)

When an orchestrator routes via the Task tool, the specialist runs in its **own**
window. Its file reads, research, and scans never enter the parent's context; only
the final message returns. The main conversation stays lean regardless of how much
work happens beneath it.

```
   MAIN THREAD (lean)                  SUBAGENT WINDOWS (isolated, discarded)
   Nehemiah ─Task─► Hizkiah  ───────►  [reads/edits ≈30k tokens of work]
                    returns ◄────────  "done: 3 files, contract held" (~200 tok)
            ─Task─► Caleb    ───────►  [web research ≈25k tokens]
                    returns ◄────────  "PKCE S256; sources […]"        (~300 tok)
```

This is **why disabling auto-compaction is low-risk in MISHKAN**: the token-heavy
history is never on the main thread to compact — it was spent and dropped in child
windows. (See §5.)

### 3.3 Tool grants — formulated by frontmatter

Each tool's JSON schema costs input tokens. Tight per-agent `tools:` lists mean an
agent never carries schemas for tools it cannot use.

### 3.4 Rule scoping — formulated by globs

A rule's body is tokens. `backend/yasad.md` contributes **zero** while editing a
`.css`; it loads only when a matching path is touched. The rule budget tracks the
file in hand.

### 3.5 Cognee offloading — formulated by externalising state

Context is not history. Instead of carrying a 3,000-token result forward, write it
to the graph and keep a ~150-token summary + node id; query for detail on demand.
This is the **deliberate, into-a-store** counterpart to letting the model
auto-summarise the conversation.

---

## 4. What "on top of Claude" means

```
                 Claude model  (caching · context window · tool-use)   ← unchanged
                       ▲
                       │  MISHKAN shapes INPUTS only:
   ┌───────────────────┴─────────────────────────────────────────┐
   │ file ORDER       → what caches      (static-first)            │
   │ agent BOUNDARIES → what's resident  (subagent fan-out)        │
   │ tool GRANTS      → schema weight    (tight tools:)            │
   │ glob SCOPES      → rule weight      (path-matched)            │
   │ store CHOICE     → context vs graph (Cognee offload)          │
   └───────────────────────────────────────────────────────────────┘
```

No request interception, no rewriting. The platform's native behaviour does the
work; MISHKAN composes the inputs so it works in the engineer's favour.

---

## 5. Interaction with auto-compaction

Auto-compaction (Claude Code native) summarises older context when the window
fills, so long sessions don't hit a wall. The engineer runs with
`autoCompactEnabled: false` — preferring exact, un-rewritten context (consistent
with verify-before-fix and no-fabrication).

MISHKAN makes that safe in the common path because:

- **Subagent isolation** keeps the heavy history off the main thread.
- **Cognee offloading** is the manual, reviewed substitute for auto-summarisation.
- **CLAUDE.md re-injection** reloads sprint state from file, not from a summary.

**Where compaction-off still bites:** a long exploration chat with
Nehemiah/Bezalel that never spawns a subagent accumulates on the main thread with
no auto-rescue. Mitigation is manual: `/context-compress`, or capture intent into
`/mishkan-init` and start a fresh session.

---

## 6. Model tiering (cost, complementary to tokens)

Tokens and model choice are separate cost axes. `config/model-routing.yaml` sets a
Claude tier per agent role: **Opus** for orchestration/leads, **Sonnet** for any
agent that writes code/config, **Haiku** for evaluate/collect/advise roles. Tiering
cuts cost without touching the token mechanics above.

---

## 7. Targets and honest gaps

- **Budget target:** under ~10 active MCPs and ~80 loaded tools at any time.
  Currently discipline + per-agent `tools:` lists — **not an enforced gate**.
- **Cache-hit measurement** is aspirational: the PostToolUse hook captures
  tool/outcome but not token/cache fields (the hook payload doesn't expose them),
  so cache-hit-rate must be derived Cognee-side once enriched.
- **Auto-compaction is off** by setting; §5 covers the implications.

---

*Operational detail for `MISHKAN_harness_design.md` §11. Mechanisms are native to
the Claude model and Claude Code; MISHKAN's contribution is the input composition
that makes them pay off.*
