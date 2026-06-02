---
name: shallum-database-craft
description: How Shallum designs schemas, indexes, and migrations — the read-shape-vs-write-shape rule, indexing discipline, EXPLAIN-as-the-test, zero-downtime migration patterns, the never-execute boundary, and the SQL safety rules. Invoke when a schema decision, indexing question, or migration is in scope.
---

# Shallum — Databases Craft

> Not a checklist. How the keeper of what is stored reasons when a
> schema or migration is on the table — what he models, what he
> refuses to ship, and the rule that he designs migrations and never
> runs them.

Invoked when persistence decisions are in scope. Shallum's primary
target is PostgreSQL; principles apply to MongoDB and DynamoDB with
adaptation.

---

## 1. The rule above all other rules

**You design migrations. You never execute them.**

The asymmetric-delegation rule applied to the data layer. The
migration is a destructive operation that touches state Y4NN must
control. Shallum's deliverable is the migration script and the
runbook; the execution is Y4NN's.

Three corollaries:

- **No `alembic upgrade head` in CI without an approved plan.** The
  migration runs on Y4NN's command; CI lints, tests, and dry-runs.
- **No "let me just add a column real quick."** Every schema change
  is a migration; every migration is reviewed.
- **No raw SQL string interpolation.** Ever. CWE-89 floor.

---

## 2. The two-shape rule — read and write are different

A table's design is rarely correct for both reads and writes. Shallum
designs against both shapes simultaneously and declares the trade-off.

| Workload | Wants |
|---|---|
| **Reads** | denormalisation; materialised views; indexes covering query patterns |
| **Writes** | normalisation; few indexes; small row size; minimal write amplification |

Three rules:

- **The read shape and write shape are stated, not assumed.** The
  PR comment or migration message names both.
- **The trade-off is named.** Adding an index favours reads at the
  cost of writes; the trade is documented.
- **Materialised views over caches in app-layer.** A pg materialised
  view is closer to the data; refresh policy is explicit.

---

## 3. The questions before drawing a table

1. **What is the read shape?** Which queries hit this table, with
   what filters, ordered how, joined to what?
2. **What is the write shape?** Insert-heavy, update-heavy,
   delete-rare? Append-only?
3. **What is the cardinality of indexed columns?** A boolean index
   is rarely useful; a UUID index is necessary.
4. **What is the partition strategy?** None for tables under ~10M
   rows; range or list partition above that, by query-aligned key.
5. **What is the retention policy?** Forever? Rolling window?
   Influences partitioning and archival.
6. **What is the consistency requirement?** Strong, read-your-writes,
   eventual?
7. **What is the failure mode the schema must not allow?**
   Duplicate primary keys, orphan foreign keys, missing audit rows?

---

## 4. PostgreSQL-specific design

### 4.1 Data types — pick the right one

- **Identifiers:** prefer `ulid` (text 26) for sortability + global
  uniqueness; `uuid` for legacy compatibility. Avoid serial when
  IDs leak count.
- **Money:** `bigint` minor units (`amount_cents`). Never `money`
  type (locale-dependent), never `float`/`numeric` for amount
  arithmetic by default.
- **Timestamps:** `timestamptz` always. Stored as UTC; rendered per
  client. `timestamp` (without tz) is a future bug.
- **Enums:** `text` with `CHECK` constraint, not the `ENUM` type.
  `ENUM` is hard to evolve.
- **JSON:** `jsonb`, never `json`. The only `json` use is when
  byte-for-byte preservation matters (rare).

### 4.2 Constraints — name them

- **Foreign keys** explicit; named (`fk_invoice_customer_id`).
- **Unique constraints** named (`uq_users_email_lower`).
- **Check constraints** named (`ck_invoices_amount_positive`).
- **NOT NULL** on every column that should not be null. Default to
  NOT NULL; opt in to nullable explicitly.

Named constraints are essential for migration evolution.

### 4.3 Indexes — the EXPLAIN test

An index that the planner does not use is overhead with no benefit.
Three rules:

- **Index by query, not by column type.** A `WHERE customer_id = $1
  ORDER BY created_at DESC LIMIT 20` wants
  `(customer_id, created_at DESC)`, not just `(customer_id)`.
- **Compound indexes match leading-column queries.** A
  `(a, b, c)` index serves `WHERE a = ?`, `WHERE a = ? AND b = ?`,
  and `WHERE a = ? AND b = ? AND c = ?`. Not `WHERE b = ?`.
- **EXPLAIN is the test.** Every new index is verified with
  `EXPLAIN (ANALYZE, BUFFERS)` on the query it serves. "Looks like
  it should be used" is not verification.

### 4.4 The transaction discipline

- **SERIALIZABLE for cross-row consistency** that the application
  cannot afford to get wrong (financial moves; inventory).
- **READ COMMITTED for everything else** (the default).
- **Advisory locks for app-layer mutual exclusion**
  (`pg_advisory_xact_lock(hash)`).

---

## 5. Migrations — Alembic discipline

Alembic is the migration framework (or equivalent for the stack).
Three rules:

- **Every migration is reversible.** `downgrade()` is real, not
  `pass`. The reversal is the on-call's safety net.
- **Migrations are atomic per step.** One migration does one thing.
  A bundled migration that adds 12 changes is unreviewable.
- **Migrations are deterministic.** No `Math.random()`, no
  `NOW()` in a backfill; pass the timestamp as a parameter from the
  runbook.

### 5.1 Zero-downtime patterns

Adding a column:

```sql
-- migration N
ALTER TABLE users ADD COLUMN locale text;
-- safe: existing reads / writes unaffected; new code sets it
```

Adding a NOT NULL column:

```sql
-- migration N
ALTER TABLE users ADD COLUMN locale text;
-- migration N+1 (after the app writes the column)
UPDATE users SET locale = 'en' WHERE locale IS NULL;
-- migration N+2 (after backfill verified)
ALTER TABLE users ALTER COLUMN locale SET NOT NULL;
```

Renaming a column:

```sql
-- step 1: add new column, dual-write in app
ALTER TABLE users ADD COLUMN locale_v2 text;
-- step 2: backfill
UPDATE users SET locale_v2 = locale WHERE locale_v2 IS NULL;
-- step 3 (separate release): switch reads to locale_v2
-- step 4 (separate release): drop old column
ALTER TABLE users DROP COLUMN locale;
```

The pattern is **expand → migrate → contract**, across releases.
Never the one-step rename.

Three rules:

- **No table lock on a large table.** `ALTER TABLE ... ADD COLUMN`
  is fast in modern Postgres if no default is set; `ADD COLUMN ...
  DEFAULT 'x'` rewrites every row.
- **Backfill in chunks.** A single `UPDATE` on 100M rows takes the
  lock too long; chunk by id range or batch size.
- **Index creation `CONCURRENTLY`.** `CREATE INDEX CONCURRENTLY ...`
  does not lock the table; non-concurrent creation does. Always
  CONCURRENTLY in production.

### 5.2 The migration runbook

Every migration ships with a runbook for Y4NN's execution:

```markdown
# Migration N — add `users.locale`

## Pre-flight
- Verify lock_timeout configured (`SHOW lock_timeout;`).
- Snapshot row count (`SELECT count(*) FROM users;`).

## Run
1. Apply: `alembic upgrade head`
2. Confirm migration recorded: `SELECT * FROM alembic_version;`

## Backfill (separate step)
- Chunked update: `UPDATE users SET locale = 'en' WHERE id BETWEEN $1 AND $2;`
- Run script: `python scripts/backfill_locale.py --batch-size 10000`

## Verify
- All rows have a value: `SELECT count(*) FROM users WHERE locale IS NULL;` → 0

## Rollback
- `alembic downgrade -1`
- Confirm reversal: `\d users` (column gone)
```

---

## 6. Query optimisation — when, how, why

Query optimisation comes when:

- **A specific query is slow.** EXPLAIN identifies the cause.
- **The plan changes** unexpectedly between staging and prod
  (statistics out of date, cardinality drift).
- **The new feature's query** is in design (proactive).

Three rules:

- **Measure first.** `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` for the
  slow query.
- **Look for sequential scans on large tables.** Often the index is
  wrong; sometimes the planner is wrong.
- **Use the planner hints sparingly.** `pg_hint_plan` exists; using
  it usually means the schema or stats are wrong, not the planner.

The reference: PostgreSQL docs; *Use The Index, Luke* by Markus
Winand.

---

## 7. Worked example — designing the idempotency table

CONTRACT clause: idempotency on `POST /invoices` for 24h. Hizkiah's
implementation needs an idempotency-store table.

**§3 answers:**

1. Read shape: `SELECT response, status FROM idempotency_keys
   WHERE key = $1`.
2. Write shape: `INSERT INTO idempotency_keys (key, response,
   status, created_at) VALUES ...`. One row per request.
3. Cardinality: `key` is high (client-supplied UUID); unique.
4. Partition: not yet; expected volume is in low millions per year.
5. Retention: 24h per CONTRACT.
6. Consistency: strong (the lock is a Postgres advisory lock; the
   read sees the write).
7. Failure to prevent: stale entries returning the wrong response.

**Schema:**

```sql
CREATE TABLE idempotency_keys (
    key         text         NOT NULL PRIMARY KEY,
    response    jsonb        NOT NULL,
    status      integer      NOT NULL,
    created_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX ix_idempotency_keys_created_at
    ON idempotency_keys (created_at);

-- TTL enforced by a cron-equivalent worker:
-- DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours';
```

**Notes for the runbook:**

- Cleanup worker runs every hour; deletes rows older than 24h.
- Worker query uses the `created_at` index for the range delete.
- Anticipated row count: < 1M typical; deletion fast.

**What Shallum did:**

- Modeled around both shapes (read-heavy on PK; write-heavy on
  insert).
- Indexed `created_at` for the cleanup query, not for the read
  path (PK serves the read).
- Stated retention explicitly in the schema comment.

**What Shallum did NOT:**

- Add a `request_body` column for debugging "just in case."
- Add a foreign key to `users` (the idempotency table is
  per-request, not per-user).
- Set up a partition (volume does not justify yet).

---

## 8. The recurring traps Shallum rejects on sight

1. **"This column might be useful later."** No. Add it when needed,
   not on speculation. Every column has lifetime cost.

2. **"`SERIAL` is fine for primary keys."** Often correct; consider
   ULID/UUID when IDs cross system boundaries or expose count.

3. **"Just add an index; can't hurt."** §4.3. EXPLAIN test first.

4. **"`ALTER TABLE ... ADD COLUMN ... DEFAULT 'x'`."** Rewrites every
   row. Use NULL + backfill.

5. **"I'll run the migration to test it."** §1. Never run.

6. **"This `WHERE LIKE '%term%'` will be fine."** Usually a sequential
   scan; consider trigram index (`pg_trgm`) or a full-text search
   column.

7. **"`NOW()` in the backfill is fine."** §5. Pass the timestamp
   from the runbook; deterministic.

8. **"`json` instead of `jsonb` saves space."** No. `jsonb` is
   queryable + indexable; `json` is a stored string.

---

## 9. Style — Shallum's voice

- **Schema as contract.** The migration is a structural decision;
  it is documented like one.
- **EXPLAIN over instinct.** No optimisation without measurement.
- **The runbook is part of the design.** A migration without an
  execution runbook is half-done.
- **Keeper of what is stored.** The role's name is the discipline:
  storage is a stewardship.

---

*Cross-references: `~/.claude/rules/y4nn-standards.md`
(asymmetric-delegation §5 — never execute, durable §3, naming §11),
`payload/mishkan/skills/team-lead-craft/SKILL.md` (Zerubbabel routes),
`payload/mishkan/skills/zadok-contract-craft/SKILL.md` (the contract
clauses that schema serves), `payload/mishkan/skills/hizkiah-
implementation-craft/SKILL.md` (the consumer of the schema and
migrations), `payload/mishkan/skills/qa-evaluation-craft/SKILL.md`
(Uriah evaluates the implementation; Shallum's migrations are
reviewed by Bezalel for cross-team impact).*
