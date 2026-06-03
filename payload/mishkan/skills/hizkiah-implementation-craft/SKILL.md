---
name: hizkiah-implementation-craft
description: How Hizkiah implements backend features against an existing contract — the layered shape (controller → service → repository), transaction boundaries, idempotency, error mapping, the no-redesign rule. Stack-neutral principles with concrete examples in Python (FastAPI), TypeScript (Hono / NestJS), and PHP (Laravel). Invoke when implementing a backend feature against a fixed contract, or when a routine implementation is starting to drift toward redesign.
---

# Hizkiah — Implementation Craft

> Not a checklist. How the overseer of dedicated, pure administrative work
> reasons when handed a contract and told "build this" — what he builds
> straight, what he refuses to bend, and where he stops and hands work back.
>
> The discipline is stack-neutral. The shapes are the same in Python,
> TypeScript, and PHP — only the syntax changes.

Invoked when the contract is fixed and the implementation begins. If the
contract is *not* fixed, Hizkiah does not start — he routes to Zadok /
Zerubbabel and waits.

---

## 1. The single most important rule

**You build; you do not redesign.**

The contract is the scope contract. The architecture is the seam map.
Hizkiah's role is to land code that fulfils the contract within the
architecture, not to "improve" either while passing through.

Three corollaries:

- If the contract is wrong, you do not silently fix it in the
  implementation. You stop, surface the defect to Zadok / Zerubbabel,
  and wait for a contract amendment.
- If the architecture is wrong, you do not refactor while in the file.
  You stop, surface the issue to Nathan, and wait.
- If the test exposes a contract ambiguity, you do not pick a behaviour
  and code it. You stop, write down the ambiguity, and ask.

"While I'm in there" is the phrase that signals the trap. The standards
rule is named: *no scope expansion* (`y4nn-standards.md` §4). The
implementation has a scope contract; the contract is the scope.

---

## 2. The questions Hizkiah asks before writing a line

1. **What contract clause am I implementing?** Quote it. If you cannot
   quote it, the contract is missing the clause and you are about to
   silently invent one. Stop.
2. **What is the read/write shape?** Reads and writes have different
   shapes (cardinality, consistency, indexing). Treat them separately
   from line one.
3. **What is the failure mode that is unacceptable?** Crash with a
   500? Acceptable in a beta context, unacceptable in payments. The
   answer dictates the error-handling discipline.
4. **What is idempotent here?** Re-issuing the request must produce
   the same observable outcome, *or* the contract must say it does not.
   Decide before coding, not after.
5. **What is the transaction boundary?** What is committed atomically?
   The boundary is the unit of failure; if you cannot draw it, you
   will have partial writes in production.
6. **What is the test that proves this works?** Black-box, from the
   contract's perspective. If you cannot describe that test, you are
   about to write code that the contract does not actually require.
7. **What is the rollback story?** If this code ships and the next
   release reverts it, does state survive cleanly? If not, there is a
   migration or feature-flag concern the implementation cannot ignore.

Skipping these questions is the cause of most rewrites Hizkiah is asked
to do in subsequent sprints.

---

## 3. The layered shape — same across stacks, different syntax

The seam map every backend follows. Names vary by framework; the
responsibilities do not.

```
HTTP boundary           (router / controller / route handler)
        │   responsibility: translate HTTP ↔ domain; no I/O, no business rules
        ▼
schema / request DTO    (Pydantic / Zod / FormRequest)
        │   responsibility: validate at the boundary; reject malformed input
        ▼
service / use-case      (service / application service / action class)
        │   responsibility: orchestrate business logic; no HTTP, no SQL
        ▼
repository / model      (repository / DAO / Eloquent model behind interface)
        │   responsibility: persistence; the only layer that touches the DB
        ▼
database
```

Two rules this layout enforces, **in every stack**:

- **The controller never touches the database directly.** A controller
  that runs a query or constructs an ORM object is a routing-layer leak.
- **The repository returns domain objects, not raw rows / ORM models.**
  Translate at the boundary; never above it. Otherwise the framework
  leaks across every seam.

### 3.1 The shape, three stacks side-by-side

**Python — FastAPI / Pydantic / asyncpg**

```
routers/        — FastAPI routers (HTTP only)
schemas/        — Pydantic v2 models (request/response contract surface)
services/       — business logic (no I/O directly)
repositories/   — asyncpg / SQLAlchemy (the only layer touching the DB)
domain/         — dataclasses (internal model; no Pydantic)
deps.py         — FastAPI dependency providers
```

**TypeScript — Hono / NestJS / Fastify**

```
routes/         — Hono handlers / NestJS controllers (HTTP only)
schemas/        — Zod schemas (request/response contract surface)
services/       — business logic (no I/O directly)
repositories/   — Prisma / Drizzle / Knex / pg (the only layer touching the DB)
domain/         — plain TypeScript types/classes (internal model)
container.ts    — DI container (tsyringe / NestJS providers / manual)
```

**PHP — Laravel 11**

```
app/Http/Controllers/   — controllers (HTTP only)
app/Http/Requests/      — FormRequest classes (validation at the boundary)
app/Http/Resources/     — API Resource classes (response shape contract)
app/Services/           — service / action classes (business logic)
app/Repositories/       — repository interfaces + Eloquent-backed implementations
app/Domain/             — value objects + plain PHP DTOs (internal model)
                          (Eloquent models live behind repositories; they
                           do NOT escape into controllers or services directly)
app/Providers/          — service-container bindings (DI)
```

The pattern is identical. Where Laravel reads `FormRequest`, Hono reads
Zod, FastAPI reads Pydantic — same job, three syntaxes.

### 3.2 Where developers most often leak the boundary, per stack

| Stack | Common leak | Discipline |
|---|---|---|
| FastAPI | inline `await pool.fetch(...)` in the router | move to repository immediately |
| FastAPI | returning the ORM / dataclass directly without a `response_model` | declare the Pydantic response model on every endpoint |
| Hono / NestJS | `prisma.user.findMany()` directly in the route handler | route through a repository interface |
| Hono / NestJS | passing Prisma types into the service layer | translate to a domain type at the repository boundary |
| Laravel | calling `User::where(...)->get()` in a controller | route through a repository or service; the controller does not query |
| Laravel | passing Eloquent models into Service classes | wrap in a DTO or use a repository that returns domain types |
| All stacks | controller doing its own validation by hand | delegate to FormRequest / Pydantic / Zod — validation is at the schema layer, not the controller |

---

## 4. Input validation — at the contract boundary, never below

The schema layer is the validator. Inputs that survive the schema are
valid by construction; the service does not re-check.

**Python (FastAPI / Pydantic v2):**

```python
from pydantic import BaseModel, ConfigDict, Field

class InvoiceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    customer_id: str = Field(pattern=r"^cus_[0-9A-HJKMNP-TV-Z]{26}$")
    amount_cents: int = Field(ge=1)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
```

**TypeScript (Hono / Zod):**

```typescript
import { z } from "zod";

export const InvoiceCreate = z.object({
  customer_id: z.string().regex(/^cus_[0-9A-HJKMNP-TV-Z]{26}$/),
  amount_cents: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();
```

**PHP (Laravel FormRequest):**

```php
class StoreInvoiceRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'customer_id'   => ['required', 'string', 'regex:/^cus_[0-9A-HJKMNP-TV-Z]{26}$/'],
            'amount_cents'  => ['required', 'integer', 'min:1'],
            'currency'      => ['required', 'string', 'regex:/^[A-Z]{3}$/'],
        ];
    }
}
```

Three rules, all stacks:

- **`extra: forbid` / `.strict()` / no extra Laravel input through.**
  A typo from the client surfaces as a 422, not silent acceptance. In
  Laravel this is achieved by `$request->validated()` (returns only
  the declared keys) — never `$request->all()`.
- **The validated payload is the only input the service ever sees.**
  The controller never passes the raw request body downward.
- **Validation lives at the schema, not in the service.** If the
  service is re-checking that `amount_cents > 0`, the schema is missing
  the rule.

---

## 5. Error mapping — the contract envelope in code

Zadok's contract fixes the error envelope. Hizkiah translates exceptions
into it, **regardless of stack**.

The envelope (from CONTRACT.md):

```json
{
  "error": {
    "code": "resource_not_found",
    "message": "...",
    "request_id": "req_...",
    "details": { }
  }
}
```

**Python (FastAPI):**

```python
class DomainError(Exception):
    code: str
    http_status: int

class NotFoundError(DomainError):
    code = "resource_not_found"
    http_status = 404

@app.exception_handler(DomainError)
async def handler(req: Request, exc: DomainError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.http_status,
        content={"error": {
            "code": exc.code,
            "message": str(exc),
            "request_id": req.state.request_id,
            "details": getattr(exc, "details", {}),
        }},
    )
```

**TypeScript (Hono):**

```typescript
export class DomainError extends Error {
  constructor(public code: string, public httpStatus: number,
              public details: object = {}) { super(code); }
}
export class NotFoundError extends DomainError {
  constructor(details = {}) { super("resource_not_found", 404, details); }
}

app.onError((err, c) => {
  if (err instanceof DomainError) {
    return c.json({ error: {
      code: err.code, message: err.message,
      request_id: c.get("requestId"), details: err.details,
    }}, err.httpStatus);
  }
  // … log + generic 500
});
```

**PHP (Laravel):**

```php
abstract class DomainException extends Exception
{
    abstract public function code(): string;
    abstract public function httpStatus(): int;
    public function details(): array { return []; }
}

class ResourceNotFoundException extends DomainException
{
    public function code(): string      { return 'resource_not_found'; }
    public function httpStatus(): int   { return 404; }
}

// bootstrap/app.php
->withExceptions(function (Exceptions $exceptions) {
    $exceptions->render(function (DomainException $e, Request $r) {
        return response()->json(['error' => [
            'code'       => $e->code(),
            'message'    => $e->getMessage(),
            'request_id' => $r->header('X-Request-Id'),
            'details'    => $e->details(),
        ]], $e->httpStatus());
    });
})
```

Three rules, all stacks:

- **The service raises domain exceptions; the framework's error handler
  maps to HTTP.** Services do not return `(result, error)` tuples; they
  raise / throw.
- **`request_id` is always present.** Middleware sets it; the handler
  reads it. Never blank. Laravel: assign in a middleware before
  routing; Hono: `c.set("requestId", ...)` early; FastAPI: middleware
  populates `request.state`.
- **Never leak the raw exception.** No stack trace in the response,
  ever. Log it server-side with the same `request_id` so support can
  correlate.

---

## 6. Idempotency — same shape, three stacks

If the contract offers idempotency, the shape is fixed: store the
*response*, key by the `Idempotency-Key` header, serialise concurrent
re-issues, TTL matches the contract window.

The shape (language-neutral pseudocode):

```
on POST /invoices with header Idempotency-Key=K:
    if cached_response = idempotency_store.get(K) → return cached_response  # replay
    acquire_lock(K):                                                         # serialise concurrent re-issues
        if cached_response = idempotency_store.get(K) → return cached_response  # double-check inside lock
        response = perform_create(body)
        idempotency_store.put(K, response, ttl=contract_window)
        return response
```

The double-check inside the lock is the textbook shape for the
read-then-write race that idempotency keys exist to prevent.

Per-stack patterns:

- **FastAPI:** the lock is a Postgres advisory lock keyed on
  `hash(Idempotency-Key)`; the store is a small `idempotency` table
  `(key, response_json, status, created_at)` with TTL enforced by a
  cron worker.
- **Hono / NestJS:** the lock can be Postgres advisory lock OR
  Redis-with-Redlock. The store is a Redis hash with TTL = contract
  window.
- **Laravel:** wrap the action in `Cache::lock("idem:{$key}", 10)->block(...)`,
  store the response in `Cache::put("idem:{$key}", $response, $contractTtl)`.
  For DB-backed: a dedicated `idempotency_keys` table queried before
  the action.

Three rules, all stacks:

- **Store the response, not the request.** Replays must return the
  *original* outcome, not recompute and risk divergence.
- **TTL matches the contract window.** If the contract says 24h, the
  store TTL is 24h. Not "a few days."
- **Failed first attempts cache too.** If the first call returns a 4xx,
  the replay returns the same 4xx. Idempotency is about *observable
  outcome*, not "succeed on retry."

---

## 7. Transaction boundaries — the unit of failure

A transaction is the unit of atomicity. Anywhere a sequence of writes
must be all-or-nothing, you must hold a transaction.

**Python (asyncpg):**

```python
async with self._pool.acquire() as conn:
    async with conn.transaction():
        await self._invoices.insert_with(conn, inv)
        await self._line_items.insert_all_with(conn, lines)
        await self._outbox.enqueue_with(conn, "invoice.created", inv.id)
```

**TypeScript (Prisma):**

```typescript
await this.prisma.$transaction(async (tx) => {
  await this.invoices.insertWith(tx, invoice);
  await this.lineItems.insertAllWith(tx, lines);
  await this.outbox.enqueueWith(tx, "invoice.created", invoice.id);
});
```

**PHP (Laravel):**

```php
DB::transaction(function () use ($invoice, $lines) {
    $this->invoices->insert($invoice);
    $this->lineItems->insertAll($lines);
    $this->outbox->enqueue('invoice.created', $invoice->id);
});
```

Three rules, all stacks:

- **Pass the transaction handle / connection.** Two connections cannot
  share a transaction. A repository method that internally acquires a
  new connection breaks atomicity. In Laravel, all calls inside the
  closure share the same connection on the default DB connection;
  re-acquiring `DB::connection('other')` opts out.
- **The outbox is inside the transaction.** Domain event publication is
  atomic with the state change. A worker reads the outbox and
  publishes; the publish is at-least-once, the state change is
  exactly-once.
- **Do not call external services from inside a transaction.** Holding
  a DB transaction open while a third-party API responds is how
  cascading deadlocks happen. The outbox pattern exists precisely to
  keep external calls outside the transaction.

---

## 8. Background jobs — same discipline across queue systems

| Stack | Default queue | Job class |
|---|---|---|
| Python | Arq, Celery, RQ | `@task` / `@job` decorated functions |
| TypeScript | BullMQ, pg-boss | `Worker` / `Queue` classes |
| Laravel | Horizon / database / Redis | `class SendInvoiceEmail implements ShouldQueue` |

Pseudocode for an idempotent job with retry split:

```
job send_invoice_email(invoice_id):
    try:
        svc.send(invoice_id)
    except RetryableError:        # transient — queue retries with backoff
        raise
    except NonRetryableError as e:  # permanent — log to DLQ, do NOT retry
        log_to_dead_letter(invoice_id, e)
        return                    # successful "no-op" from the queue's view
```

Three rules, all stacks:

- **Jobs are idempotent by default.** Anything sent more than once must
  be safe to send more than once. Add a job-dedup key if not.
- **`RetryableError` vs. `NonRetryableError` is an explicit split.**
  Network blip → retryable. Customer email rejected as malformed →
  not retryable. Letting a non-retryable error retry exhausts retries
  and pollutes monitoring.
- **Job arguments are IDs, not objects.** Serializing a domain object
  into the queue couples the queue contract to the domain shape and
  breaks on any model change.

---

## 9. Repositories — parameterised queries are non-negotiable

Repositories are the only layer that touches the database. They are
also the layer where SQL injection lives or dies.

**Python (asyncpg):**

```python
await pool.fetchrow("SELECT * FROM invoices WHERE id = $1", invoice_id)
```

**TypeScript (Knex):**

```typescript
await knex.raw("SELECT * FROM invoices WHERE id = ?", [invoice_id]);
// or: await knex("invoices").where({ id: invoice_id }).first();
```

**TypeScript (Prisma):**

```typescript
await prisma.invoice.findUnique({ where: { id: invoice_id } });
// raw: await prisma.$queryRaw`SELECT * FROM invoices WHERE id = ${invoice_id}`;
//      (the template literal is parameterised; do NOT use $queryRawUnsafe)
```

**PHP (Laravel):**

```php
DB::select('SELECT * FROM invoices WHERE id = ?', [$invoiceId]);
// or: Invoice::query()->where('id', $invoiceId)->first();
//      (Eloquent / query builder parameterises automatically)
// Never: DB::select("SELECT * FROM invoices WHERE id = '$invoiceId'");
```

Three rules, all stacks:

- **Always parameterised.** Never string-interpolate input into SQL.
  CWE-89 cost is not worth saving a placeholder.
- **One repository per aggregate.** `InvoiceRepository`, not
  `DataAccessLayerImpl`. The class is the seam name.
- **Repositories return domain types, not framework types.** Pydantic
  models, Prisma rows, Eloquent models are the framework's
  representation. Translate at the seam. The service should not
  `import { Invoice } from "@prisma/client"`; it imports the domain
  `Invoice`.

---

## 10. Testing — the contract is the test, not the code

The test pyramid Hizkiah applies, language-agnostic:

| Layer | What it tests | How (Python / TS / PHP) |
|---|---|---|
| **Contract tests** | The contract clauses, black-box | pytest + httpx ; supertest / vitest ; Pest / PHPUnit (`TestCase` with `RefreshDatabase`) — all hitting a real DB via testcontainers / `--env=testing` |
| **Service tests** | Business logic, fake repositories | pytest + fakes ; vitest + in-memory fakes ; Pest with mock repository implementing the interface |
| **Repository tests** | The SQL, against real DB | pytest + testcontainers ; vitest + pg / Prisma against test container ; Pest with `DatabaseTransactions` against the real `pgsql` connection |
| **Domain tests** | Pure logic on value objects | pytest ; vitest ; Pest unit tests |

Three rules, all stacks:

- **Contract tests are the primary test surface.** They cover the
  contract clauses end-to-end. If the contract has 30 clauses, you
  have ≥ 30 contract tests.
- **Do not mock the database in contract tests.** The standards rule
  is the historical reason: mocks pass while migrations break in prod.
  Testcontainers (or Laravel's `--env=testing` with a real Postgres
  service in CI) is cheap insurance.
- **Service tests do not touch HTTP or SQL.** If a service test needs
  an HTTP client or a real DB, the service has leaked.

---

## 11. Logging and observability — by the rule, not by mood

Three rules, all stacks:

- **One log line per inbound request.** Method, path, status,
  duration_ms, request_id, principal_id. That's it. More is noise.
  Laravel: middleware. Hono: middleware. FastAPI: middleware.
- **Errors log structured data, not stringified exceptions.**
  Use the framework's structured logger — `logger.error("op_failed",
  extra={...})` in Python, `logger.error({ op, requestId, code })` in
  Pino / Winston, `Log::error('op_failed', [...])` in Laravel.
- **Tracing is on the seams.** Wrap repository calls and service calls
  in spans named for the operation. Wrapping every function adds noise
  without information. OpenTelemetry SDKs exist in all three.

---

## 12. Worked example — implementing a contract clause cleanly

Contract clause (from CONTRACT.md):
> `POST /invoices` is idempotent over `Idempotency-Key` for 24h. On
> replay within the window, return the original response with the
> original status. Concurrent in-flight requests with the same key
> wait for the first to complete.

Hizkiah's path:

**§2 answers extracted:**

1. Clause to implement: quoted above.
2. Shape: write-heavy; idempotency store is read-then-write under
   contention.
3. Unacceptable: charging twice. The whole point of the clause.
4. Idempotent: yes, by contract.
5. Transaction boundary: idempotency-store write + invoice insert + outbox.
6. Test: contract test issuing the same `Idempotency-Key` twice within
   1s and asserting identical response + 1 row in `invoices`.
7. Rollback story: idempotency entries expire after 24h regardless.

**Implementation shape:** §6 (idempotency) + §7 (transaction boundary)
applied verbatim. The lock and store choices vary by stack — Postgres
advisory locks on FastAPI/asyncpg or Laravel, Redis Redlock on
Node.js — but the *shape* is identical.

**What Hizkiah does NOT do, in any stack:**

- Invents HTTP-status-aware retry behaviour the contract did not
  specify.
- Adds a `?force=true` query parameter "for testing."
- Writes `// TODO: clean this up later` and moves on.
- Picks the lock store unilaterally — that is an architecture
  decision Nathan owns; Hizkiah surfaces the question.

---

## 13. The interface with Zadok, Nathan, Shallum, Uriah

- **Zadok → Hizkiah.** Contract first. If Hizkiah finds it under-
  specified mid-implementation, he stops and surfaces.
- **Nathan → Hizkiah.** Architecture decided first. Hizkiah lives
  within Nathan's bounded contexts; he does not move the seams.
- **Shallum → Hizkiah.** Schema and migrations are Shallum's. Hizkiah
  does not author migrations under any circumstances. The schema
  change is requested; Shallum designs the migration; Y4NN executes.
- **Uriah → Hizkiah.** Uriah evaluates the implementation against the
  contract. Findings come back as structured QA output; Hizkiah
  remediates against them, does not argue them.

---

## 14. When a migration is in scope

For refactors touching many files (contract rename, framework swap,
API deprecation), the main session invokes `mishkan-migration-wave` â
the workflow that runs the transformation per file in worktree
isolation with a 2-reviewer accept gate and optional per-file verify.

Hizkiah may be the `transformer_agent` for backend file
transformations; Uriah is a sensible reviewer. The workflow handles
per-file isolation; Hizkiah's job is to make the transformation
correct on one file at a time â the same discipline as Â§1 of this
skill, just applied per-file across the wave.

The Lead routes; the main session invokes:

```
Workflow({
  name: "mishkan-migration-wave",
  args: {
    project_root, target_glob, transformation,
    transformer_agent: "hizkiah",
    reviewers: ["uriah"], verify_command: "..."
  }
})
```
## 15. The recurring traps Hizkiah rejects on sight

1. **"I'll add a small refactor while I'm in this file."**
   §1. Scope is the contract. Refactor is a separate scoped decision.

2. **"This SQL is fine inlined in the controller for now."**
   §3 / §9. Inlined SQL becomes load-bearing in the second PR. Move
   it to the repository the first time. Laravel: that means
   `User::query()->where(...)` in a controller is still a leak — it
   belongs in a repository or query class.

3. **"Eloquent / Prisma is the domain model."**
   §3. ORM models are persistence types. They survive at the
   repository boundary and not above. A service that accepts an
   Eloquent `Invoice` is coupled to the schema forever.

4. **"I'll use `Optional<T>` / `T | null` / nullable everywhere."**
   Nullable only when the contract or the domain says null is a
   valid state. Defensive nullability is how `if (x !== null)`
   cargo-cult spreads.

5. **"I'll skip the test for the unhappy path; we can add it later."**
   Contract tests cover error responses. A clause without a test is a
   clause that drifts.

6. **"I'll commit a `// TODO` and fix it next sprint."**
   `y4nn-standards.md` §3 — durable solutions only. If it cannot ship
   working, it does not ship.

7. **"I'll mock the database; it's faster."**
   §10. The mock passes; the migration breaks. Use a real DB
   (testcontainers / Laravel `--env=testing` with a service in CI).

8. **"I'll catch the exception and continue."**
   Silent exception swallowing is the single highest-frequency cause
   of wrong-output-in-production bugs. Catch only what you intend to
   handle; re-raise / re-throw the rest.

9. **"I'll log the failure and return a 200; the client can retry."**
   No, they cannot, because you returned 200. Map the exception
   correctly via §5.

10. **"This is Laravel, the framework does it differently."**
    The framework's syntax differs. The *discipline* does not. If a
    Laravel implementation skips validated FormRequests, escapes
    Eloquent into controllers, or uses `DB::statement($sql)` with
    string interpolation, those are leaks — the framework not
    "doing it differently" but the implementer not applying the
    discipline.

---

## 16. Style — Hizkiah's working voice

- **No magic.** Every line readable by the next engineer cold.
  Implicit framework behaviour is documented or refused.
- **Names that read in tests.** `await svc.create(...)` reads cleanly;
  `await svc.createInvoiceWithIdempotencyHandlingAndOutbox(...)` reads
  as compensation for unclear seams.
- **Small functions.** A function that does not fit on one screen
  is two functions in a trench coat.
- **The implementation is boring.** Boring is the goal. Clever in a
  service layer is a future incident.
- **Sturdy, not flashy.** The overseer of dedicated, pure
  administrative work — the title is the style.

---

*Cross-references: `~/.claude/rules/y4nn-standards.md`
(durable rule §3, no-scope-expansion rule §4, asymmetric-delegation §5,
naming rule §11), `payload/mishkan/agents/hizkiah.md` (the agent that
invokes this skill), `payload/mishkan/skills/zadok-contract-craft/SKILL.md`
(the contract this implementation fulfils — read it before starting).*
