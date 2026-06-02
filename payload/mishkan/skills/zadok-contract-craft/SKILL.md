---
name: zadok-contract-craft
description: How Zadok reasons about backend contracts and invariants — what CONTRACT.md actually fixes, the error model, naming and pagination rules, and the discipline around contract evolution. Invoke when authoring or modifying a CONTRACT.md, debating an invariant, or deciding whether a proposed change is a backward-compatible evolution or a breaking change.
---

# Zadok — Contract Craft

> Not a checklist. How the high priest who keeps standards across generations
> reasons when a contract is on the table — what he fixes, what he refuses to
> fix, and why he treats invariants as load-bearing.

Invoked only when a contract decision is in scope. Routine endpoint
implementation against an already-fixed contract is Hizkiah's work and does
not need this skill.

---

## 1. What a contract actually is

A contract is the **set of promises the system makes to its consumers that
must hold across all future versions until explicitly retired**.

Three properties distinguish a contract clause from a coding choice:

- **Observable.** Consumers can detect violation from outside the service.
- **Persistent.** It survives implementation changes. The function may be
  rewritten; the contract clause stays.
- **Versioned.** Changing it requires a deliberate version step or
  deprecation window — not a normal release.

If a proposed clause does not have all three, it does not belong in
`CONTRACT.md`. It is a coding convention. Document it elsewhere.

---

## 2. The two halves of a contract

Zadok always splits CONTRACT.md into two sections, each with different
durability:

### 2.1 Invariants — what is always true

Statements about the system that hold for every request, every state, every
caller. Violation is a defect, never a deliberate change.

Examples:
- "Resource IDs are immutable for the life of the resource."
- "Every error response has an `error.code`, an `error.message`, and an
  `error.request_id`."
- "Pagination is cursor-based; offset pagination is not offered."
- "Money fields are integer minor units (`amount_cents`), never floats."
- "Timestamps are RFC 3339 UTC strings ending in `Z`."

### 2.2 Guarantees — what the system promises to its consumers

Statements about behaviour the system commits to deliver, often with bounds.

Examples:
- "POST /resources is idempotent over the `Idempotency-Key` header for 24h."
- "List endpoints return ≤ 100 items per page."
- "Webhooks are retried with exponential backoff for ≤ 72h, then dropped."
- "Read-after-write consistency for the same client within 5s."

The split matters. Invariants govern *shape*; guarantees govern *behaviour*.
A consumer building against guarantees can plan retry / fallback / cache
strategy. A consumer relying on invariants can plan their schema.

---

## 3. The questions Zadok asks before fixing any clause

1. **Who consumes this** — internal services, external customers, both?
   External consumers turn a guarantee into a *commitment* with deprecation
   cost. Be cautious about what you offer them.
2. **What changes if I tighten this** — does tightening (e.g. dropping
   support for a format) break existing callers? If yes, this is a
   contract-evolution decision, not a coding decision.
3. **What changes if I loosen this** — loosening (e.g. allowing nulls
   where they were forbidden) is almost always backward-compatible for
   the server but rarely for the client. Pause.
4. **Is this an invariant or a guarantee** — confusing the two is a
   common source of leakage. Invariants are stricter; do not promise
   them lightly.
5. **What is the natural test** — every clause must be testable by a
   black-box consumer. If you cannot write the test that fires when the
   clause is violated, the clause is not contract-grade.
6. **What is the cost of changing this in two years** — if the answer is
   "trivial," it is probably not a contract clause. If the answer is
   "every consumer rebuilds," that is exactly what a contract clause is
   for and *exactly* why you write it down now.

If any answer is genuinely unknown, invoke the research pipeline — do not
guess. Guessing on §3.1 (consumers) creates contractual debt that surfaces
years later.

---

## 4. The error model — the single most copied-and-pasted contract clause

Most backend systems get error models wrong because they think of errors
as the unhappy path. They are not — they are *the consumer's API surface
under bad conditions*, and consumers depend on the shape exactly as much
as they depend on the success shape.

The error model Zadok fixes:

```json
{
  "error": {
    "code": "resource_not_found",
    "message": "Human-readable, safe for end-user display.",
    "request_id": "req_01HX...",
    "details": { "resource_type": "invoice", "resource_id": "in_..." }
  }
}
```

Rules:

- **`code` is stable.** It is the machine-readable identifier consumers
  branch on. Once published, it never changes meaning. New codes are
  additive; old codes survive forever.
- **`code` is `lowercase_snake_case`** and namespaced by domain
  (`payment_failed`, not `failed`).
- **`message` is human-readable, safe to display, and may change.** It
  is not contract — consumers must not match on it.
- **`request_id` is always present** on every error response, every
  status, no exceptions. It is how support and the consumer correlate.
- **`details` is optional and free-form** but documented per `code`. If
  you publish a `details` shape for a code, that shape becomes part of
  the contract.
- **HTTP status maps to `code` consistently** but `code` carries more
  information. 404 with `resource_not_found` is different from 404 with
  `route_not_found`; the consumer needs the distinction.

The single most expensive mistake: shipping an API where errors are
free-text strings without codes. By the time consumers grep their logs
for `"not found"`, you cannot change the wording without breaking them.

---

## 5. Pagination — cursor or nothing

Offset pagination (`?page=3&page_size=20`) is conceptually simple and
broken in practice. Two failure modes are catastrophic:

- **Live data drift.** Items inserted/deleted between page reads cause
  duplicates or skips. There is no fix at the server layer.
- **Deep paging cost.** `OFFSET 1000000` is a full scan in most databases.
  Performance collapses past a few thousand pages.

The shape Zadok fixes:

```json
{
  "data": [...],
  "next_cursor": "cur_01HX..." | null,
  "has_more": true
}
```

Cursor pagination is opaque-to-the-client by design. The cursor encodes
"where to resume" without leaking internals (it can be base64-encoded
`{last_id, last_sort_key}`, signed if you care about replay). It is
drift-safe and constant-cost.

If a consumer demands `total_count`, treat it as a separate, optional,
slow endpoint or a separate field with explicit caveats ("approximate,
recomputed periodically"). Do not couple it to the page response.

---

## 6. Naming — every name in the contract is load-bearing

Names in a contract are read in two contexts: by the consumer's IDE
autocomplete, and by the support engineer at 3am during an incident.
Both contexts favour names that are precise, consistent, and unambiguous.

Rules Zadok enforces:

- **One shape per concept across the API.** `customer_id` everywhere or
  `customerId` everywhere; never mix. Pick one and apply it.
- **Verb-noun for actions, noun for resources.** `POST /invoices`
  creates an invoice. `POST /invoices/{id}/void` is the action; the verb
  is `void`, and it is on the action endpoint, not the resource endpoint.
- **Prefix identifiers by resource type.** `cus_01HX...`, `in_01HX...`.
  Untyped identifiers (`01HX...`) make support and debugging twice as
  hard. Stripe-style prefixes are not aesthetic — they are operational.
- **Booleans state what is true when set.** `is_active: true`, not
  `inactive: false`. Double negatives in field names are a documented
  source of consumer bugs.
- **Plural for collections, singular for resources.** `/invoices` lists,
  `/invoices/{id}` is one. Never mix.
- **No abbreviations in names** unless they are universally understood
  in the domain (`url`, `id`, `vat`). `addr`, `req`, `cust` are not
  acceptable. The contract is read more often than it is typed.

---

## 7. Evolution — what counts as a breaking change

This is the rule that prevents the most damage in practice. Zadok's
working definition:

A change is **breaking** if any of the following would make a
correctly-coded existing consumer stop working:

1. **Removing or renaming a field, endpoint, or error `code`.**
2. **Tightening a constraint** — making a field required that was
   optional; narrowing the allowed values of an enum; reducing a length
   limit.
3. **Changing the type of a field** (string → integer, integer → string)
   or the shape of a nested object.
4. **Changing the meaning of an existing field** while keeping its
   name. The worst kind because it is silent.
5. **Removing or tightening a guarantee** — webhook retry budget cut,
   idempotency window reduced.
6. **Changing the error `code` returned for a known scenario.**

A change is **non-breaking** if it is purely additive *and* default-safe:

- New endpoint.
- New optional field on a request (with a documented default).
- New field in a response (consumers must be told they may receive
  unknown fields — a clause in the contract).
- New optional query parameter.
- New error `code` for a new scenario (existing scenarios keep their
  existing code).
- Loosened constraint (longer maximum length, broader enum) — *for
  responses;* tightening for requests is breaking, loosening is
  non-breaking.

Two rules of thumb:

- **"It's just a small change" is the warning sign.** Every breaking
  change someone justified with that phrase cost real money.
- **When in doubt, version.** A new version is a known cost. A silent
  break is an unknown one.

---

## 8. Versioning — picking the shape that fits the consumer relationship

Three live patterns. Zadok picks the one that matches who consumes the API.

| Pattern | What it is | When to pick |
|---|---|---|
| **URL-versioned** (`/v1/`, `/v2/`) | major versions live side-by-side at different paths | external customers; long deprecation windows; multiple versions in production simultaneously |
| **Header-versioned** (`API-Version: 2026-05-01`) | versions selected by header; default version controlled centrally | external customers; you want one canonical path; willing to manage a default |
| **Single-version evolving API** | no version; only additive changes; breaking changes coordinated cross-team | internal-only; mono-repo; deploys coordinated |

Three rules:

- **Never mix.** Pick one and apply across the API.
- **Document the deprecation policy** as part of the contract. "Any
  major version is supported for 18 months from the day a successor
  ships." Without a policy, consumers assume forever and you are stuck.
- **Version on the contract level, not the implementation.** A v1
  consumer can be served by a v2 implementation through translation;
  the contract version is what the consumer sees.

---

## 9. Idempotency — when you promise it, fix the shape

Idempotency is a guarantee with a contract shape. If you offer it:

- **`Idempotency-Key` header.** Required for the endpoints that offer
  the guarantee; ignored elsewhere. Client-supplied UUIDs (or any
  unique string up to a documented length).
- **Window length is contractual.** "Idempotent over `Idempotency-Key`
  for 24 hours." After the window, the key is forgotten and a re-issue
  is a new operation.
- **Semantics on replay are contractual.** "On replay within the
  window, return the original response with the original status." Not
  "we will probably do the right thing."
- **Concurrent in-flight requests with the same key.** Either serialise
  (later request waits) or reject with a specific code
  (`idempotency_key_in_use`). Pick one and write it down.

The idempotency clause is the place where unstated guarantees most
often cause consumer bugs. The clause is short; the consequences of
omission are long.

---

## 10. Worked example A — "Should `customer.email` be required or optional?"

Situation: the customer model has an `email` field. PM wants it optional
to allow walk-in customers without email. Frontend lead wants it required
because the welcome flow assumes it.

Zadok's path:

**§3 answers extracted:**

1. Consumers: web app, mobile app, partner integrations (external).
2. Tightening (making it required later) breaks every existing
   `POST /customers` that omitted it.
3. Loosening (making it optional now) doesn't break the *server*, but
   the welcome flow on the client breaks if email is missing.
4. Invariant or guarantee: this is an invariant of the model.
5. Testable: yes — POST without email succeeds (or fails) deterministically.
6. Cost in two years: if optional → required later, every external
   partner has to ship a fix. Major version step.

**Force tension named:** *consumer flexibility vs. server-side correctness*.

**Decision Zadok proposes:** `email` is **optional in the customer
resource** (the invariant), and the welcome-flow endpoint (the
*guarantee*) returns `error.code: missing_required_field` with
`details.field: email` if invoked on a customer whose email is unset.

The split: the resource model is permissive; the per-endpoint guarantee
is strict. This way the data model survives partner reality and the
welcome flow keeps its precondition explicit.

**ADR Out of Scope:** validating email format; deduplication on email;
GDPR retention. Each is its own decision.

**Trap rejected:** "We'll make it required for now and relax it later
if needed." Tightening later is a breaking change. Default to permissive
on data models, strict on action endpoints.

---

## 11. Worked example B — "The response shape needs `total_count`"

Situation: dashboard team needs `total_count` on the list-invoices
endpoint to show "3 of 47 results."

Zadok's path:

**§3 answers extracted:**

1. Consumers: internal dashboard (single team); external Stripe-style
   partners also use the endpoint.
2. Adding `total_count` to the response: non-breaking (purely additive).
3. The cost is server-side: `SELECT COUNT(*)` on a partitioned table at
   100k+ rows is not cheap; on 10M rows it is unacceptable.
4. Invariant or guarantee: this is a guarantee on the list shape.
5. Testable: yes.
6. Cost in two years: if we ship `total_count` and the table grows, we
   either accept slow lists or break the guarantee. Breaking it later is
   contract-grade damage.

**Force tension named:** *consumer ergonomics vs. server cost at scale*.

**Decision Zadok proposes:** **Do not add `total_count` to the list
response.** Ship a separate `GET /invoices/count` endpoint that returns
an *approximate* count (`{ "approximate_count": 47, "as_of": "..." }`),
backed by a materialised view refreshed every minute. The contract
clause says "approximate," which means the consumer cannot rely on it
being exact — and the system cannot be forced into the slow path.

**The trap rejected:** the framing that "the dashboard team needs this
small field, so add it." A response field is a contract clause. Adding
one whose cost grows with data is a slow-motion incident waiting to
fire.

**Cross-team coordination:** Zadok flags this to Zerubbabel
(Yasad lead) before the contract decision lands — adding a new endpoint
is also Nathan's territory if it implies a new bounded context.

---

## 12. Writing CONTRACT.md — the shape

```markdown
# CONTRACT — <Service Name>

> The promises this service makes to its consumers. Invariants are
> always true. Guarantees describe committed behaviour, often with bounds.

## Versioning Policy

<URL-versioned / header-versioned / single-version evolving — pick one,
state deprecation window, state major-version policy>

## Invariants

### Identifiers
- All resource IDs are immutable for the life of the resource.
- IDs are prefixed by resource type: `<prefix>_<ulid>`.

### Money
- Money fields are integer minor units (`amount_cents`).
- Currency is ISO 4217 alphabetic (`USD`, `EUR`), separate field.

### Time
- Timestamps are RFC 3339 UTC, ending in `Z`.

### Error Model
<the full error envelope shape; the rule that `code` is stable; the
rule that `message` is not contract>

### Pagination
- List endpoints return ≤ 100 items per page.
- Pagination is cursor-based. `next_cursor` and `has_more` are returned.
- Offset pagination is not offered.

### Naming
<the conventions from §6>

## Guarantees

### Idempotency
<which endpoints offer it, the window, the replay semantics, the
in-flight semantics>

### Webhook Delivery
<retry budget, backoff schedule, drop policy, signature verification
contract>

### Read-after-write
<which paths, which window, which consumer scope>

## Evolution

- A change is breaking if any of: <§7 list>.
- Breaking changes require a new major version per the versioning policy above.
- New fields, endpoints, error codes, and optional parameters are
  non-breaking and may ship in minor releases.

## Conformance Tests

<reference to the test suite that exercises every clause from a black-
box consumer position>

## Change Log of the Contract Itself

<dated entries for every contract change, including the kind:
clarification | addition | breaking change>
```

The Change Log of the contract itself matters more than people expect.
It is how a consumer trying to debug a six-month-old integration knows
whether the API changed under them.

---

## 13. The interface with Hizkiah, Nathan, Zerubbabel

- **Zadok → Hizkiah.** Zadok fixes the contract; Hizkiah implements
  against it. If Hizkiah finds the contract under-specified mid-
  implementation, Hizkiah stops and surfaces — does not "fill in the
  gap." Gap-filling unilaterally is how contracts diverge from
  implementations.
- **Nathan → Zadok.** Nathan's architecture decisions shape the
  contract surface (which bounded contexts exist, where the seams
  are). Zadok writes the consumer-facing rules within those seams.
- **Zerubbabel → Zadok.** Zerubbabel routes contract decisions and
  signs off on shape questions. Zadok proposes; Zerubbabel ratifies.
- **Mishmar → Zadok.** Mishmar reviews the contract for security-
  sensitive clauses (auth scopes, rate limits, secret-handling, audit-
  log shape). Zadok holds the pen; Mishmar holds the veto on the
  security-relevant clauses.

---

## 14. The recurring traps Zadok rejects on sight

1. **"This field is internal so it doesn't need to be documented."**
   Anything that crosses the service boundary is contract. Internal
   shapes that leak into a public response become contract by accident
   on the first consumer that depends on them. Either redact at the
   boundary or document.

2. **"We'll just add a feature flag."** Feature flags are not contract
   versions. A flag-gated behaviour change is still a behaviour change;
   consumers without the flag get one contract, consumers with it get
   another. If consumers can observe the flag, it is contract surface.

3. **"It's optional, so we can change it later."** Optional fields are
   contract. Removing an optional field is breaking. The "optional"
   suffix is about request shape, not contract durability.

4. **"Errors don't need codes; the message is enough."** §4 in full.
   This is the single trap with the largest historical cost.

5. **"`total_count` is trivial to add."** §11 worked example.

6. **"We don't need an idempotency window — clients will be careful."**
   No, they will not. Either offer idempotency with a stated window or
   do not offer it at all. "Probably idempotent" is worse than "not
   idempotent."

7. **"Just expose the database column."** ORM-shaped responses leak
   schema, force naming changes to ripple through the contract, and
   couple consumers to internal storage. Always project to a contract
   shape; never publish the raw row.

---

## 15. Style — Zadok's working voice

- **Present tense, declarative.** "The system promises X."
  Not "the system will promise X."
- **Numeric where possible.** "≤ 100 items per page." Not "a reasonable
  number." A reasonable-number-of-items is everyone's least favourite
  bug.
- **No weasel words.** "Probably," "usually," "in most cases" do not
  belong in a contract. If a clause is conditional, the condition is
  part of the clause.
- **Plain refusal where needed.** "We do not offer this." Better than
  "we don't currently plan to support this," which is consumed as "we
  will support this later."
- **Same care a high priest gives the standards across generations.**
  Names are righteousness — sloppy names are how injustice sneaks in.
  This is not metaphor; it is operational.

---

*Cross-references: `~/.claude/rules/y4nn-standards.md`
(sequence rule §1, durable rule §3, no-fabrication rule §6,
explanation-before-action rule §7, naming rule §11),
`payload/mishkan/agents/zadok.md` (the agent that invokes this skill),
`payload/mishkan/skills/nathan-architecture-craft/SKILL.md` (when the
contract decision is also an architecture decision; both skills are
invoked in tandem).*
