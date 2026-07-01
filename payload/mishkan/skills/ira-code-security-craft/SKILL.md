---
name: ira-code-security-craft
description: How Ira reviews code for security at the moment of write — the pre-block rubric, the false-positive guard list that prevents noise, severity calibration anchored to OWASP/CWE, and the durable remediation patterns. Invoke when a write is being reviewed for security implications, when a finding is about to be raised, or when blocking a write is on the table.
---

# Ira — Code Security Craft

> Not a checklist. How the watchful priest reasons at the moment a write
> arrives — what he flags, what he refuses to flag, and the rule that no
> finding ships without an anchor.

Invoked when code-level security review is in scope: a Write/Edit
intercepted by the PreToolUse hook, a SAST run, a dependency surfacing,
or a hand-raised review request.

---

## 1. The rule above all other rules

**Every finding has an anchor. Anchorless findings are not raised.**

An anchor is one of:

- A specific **OWASP** entry (`OWASP-A03:2021 — Injection`).
- A specific **CWE** id (`CWE-89`, `CWE-79`).
- A specific scanner finding (`semgrep <rule-id>`, `gitleaks <rule>`,
  `bandit B608`).
- A specific MISHKAN rule (`rules/common/dependencies.md` §3).
- A specific cited research-pipeline source (from a previous Baruch
  log entry).

If you cannot name the anchor, you cannot name the severity, you cannot
write the remediation, and the finding is not real *yet*. Either find
the anchor or do not flag.

The reason the rule exists: ungrounded findings are noise, noise erodes
trust in the reviewer, eroded trust means the next *real* finding gets
ignored. The first defence is not flagging things you cannot defend.

---

## 2. The pre-block rubric — every question must answer yes

Before blocking a write, Ira answers all five questions, in writing,
inside the `/plan` surface. Any "no" — do not block; raise as a
non-blocking advisory or drop.

1. **Can I cite the exact line(s) the finding affects?** File:line, or
   the diff hunk. "Somewhere in this file" is not a finding.
2. **Can I describe the concrete failure mode?** The attacker action,
   the input, the impact. "Could be exploited" is not a description.
3. **Is the severity defensible?** Anchor + impact, not vibes. §5.
4. **Is there a durable remediation I can propose right now?** Not
   "consider adding validation" — the *fix*. §7.
5. **Is the rule layer the right place to block, or is this a one-off
   coding decision the engineer should know about but not be blocked
   by?** §3.

If yes to all five: block, plan the explanation, name the rule, propose
the fix.

---

## 3. Block vs. advise — the calibration

Not every security observation justifies a block. Blocking too often is
how the security layer becomes "the thing engineers learn to suppress."

| Situation | Action |
|---|---|
| Hardcoded credential / secret | **Block** |
| SQL injection via string concatenation | **Block** |
| Unsafe dynamic execution (`eval`, `exec`, `os.system` with user input) | **Block** |
| Missing input validation on a public endpoint | **Block** |
| Missing output encoding (XSS path) | **Block** |
| Dependency with critical CVE pinned with no exception note | **Block** |
| Missing rate limit on an unauthenticated endpoint | **Block** if endpoint is sensitive; advise otherwise |
| Logging that may leak PII | **Advise** (with severity), block only if the leak is direct |
| Cryptographic primitive that is dated but not broken | **Advise** with deprecation path |
| Missing defence-in-depth control (e.g. CSP header) | **Advise**, raise to Hushai for prioritisation |
| Code-quality issue dressed as security | **Drop** (route to Uriah / QA) |

The line is: **does this code, if shipped today, create a directly-
exploitable bug under realistic conditions?** Yes → block. Maybe →
advise. No → drop.

---

## 4. The false-positive guard list — what Ira does NOT flag

These are the patterns LLM-driven security review tends to flag as
findings. They are not findings. Stop before raising them.

1. **Missing error handling on caller-managed errors.** If the caller's
   contract is "raises on failure" and the caller handles it, missing
   a try/except in the callee is correct, not a defect.
2. **Missing JSDoc / docstring on self-describing functions.** Not a
   security concern.
3. **"Magic numbers" that are protocol constants.** HTTP status codes,
   port numbers (`443`, `80`), well-known sizes (`64` for SHA-256
   output bytes), ULID length (`26`). Not findings.
4. **`TODO` comments.** Project hygiene, not security.
5. **String concatenation outside of SQL / shell / HTML / JS contexts.**
   Building a log message with `+` is not injection. Injection requires
   a *target language*; concatenating into a Python format string does
   not create one.
6. **`int` overflow in Python.** Python integers are arbitrary precision.
   This is not C.
7. **Use of `pickle` against data the program itself wrote** in the
   same trust boundary. Pickle is dangerous against untrusted input,
   not against round-tripping your own state.
8. **Logging of `request_id`, `user_id`, or other non-PII identifiers.**
   Operational requirement, not a leak.
9. **Wide exception catches in top-level handlers** — `except Exception`
   in the main loop is correct; `except Exception` swallowed silently
   inside a function is a defect, but a *correctness* defect, not a
   security one (route to Uriah).
10. **Use of `random` for non-cryptographic purposes** — IDs, jitter,
    sampling. `secrets` is for cryptographic randomness; `random` is
    fine for everything else.

Raising one of these wastes the engineer's attention and burns the
reviewer's credibility on the *next* finding.

---

## 5. Severity calibration — anchored, not invented

Severity is a numeric, defensible claim. The shape:

| Severity | Definition | Anchor pattern |
|---|---|---|
| **critical** | Direct, remote, unauthenticated exploit producing data loss / RCE / auth bypass | OWASP A01–A03 in the wild; CVE with public exploit; live secret leak |
| **high** | Direct exploit producing data loss / privilege escalation; requires authentication or specific conditions | OWASP A04–A07; CVE without public PoC but with high CVSS; auth-bypass-with-precondition |
| **medium** | Defence-in-depth gap; misconfiguration; weak primitive not in the exploit path today | Missing security header on sensitive page; dated TLS suite enabled; verbose error in prod |
| **low** | Hardening recommendation; not exploitable in itself | Verbose logging on success path; cookie missing `SameSite=Lax` on non-session cookie |

Three rules:

- **Anchor → severity, never the other way.** "It feels high so I'll
  call it OWASP A03" is the inversion that produces noise.
- **Authenticated-only does not mean low.** Auth-bypass-once equals
  remote-once. Calibrate by what the bypass *yields*.
- **A finding with no exploit path is at most medium.** "Could be
  combined with something else for impact" is medium until the
  combination is shown.

---

## 6. The OWASP / CWE mapping table Ira uses on autopilot

| Pattern in code | OWASP 2021 | CWE | Default severity |
|---|---|---|---|
| String-concat SQL | A03 Injection | CWE-89 | critical |
| `eval` / `exec` of input | A03 Injection | CWE-95 | critical |
| `os.system` / `subprocess(shell=True)` w/ input | A03 Injection | CWE-78 | critical |
| Missing input validation on public endpoint | A03 / A04 | CWE-20 | high |
| Reflected unsanitised input in HTML | A03 | CWE-79 | high |
| Hardcoded secret in source | A07 ID & Auth Failures | CWE-798 | critical |
| Missing auth check on protected endpoint | A01 Broken Access Control | CWE-862 | critical |
| Missing authz check (auth ok, ownership not checked) | A01 | CWE-639 | critical (IDOR) |
| Weak crypto primitive (MD5/SHA1 for hashing secrets) | A02 Crypto Failures | CWE-327 | high |
| Predictable / non-crypto RNG for tokens | A02 | CWE-338 | high |
| Verbose error messages in prod | A05 Misconfig | CWE-209 | medium |
| Outdated dependency w/ known CVE | A06 Vuln & Outdated | (per CVE) | per CVE |
| Insecure deserialization of untrusted input | A08 Software & Data Integrity | CWE-502 | high |
| Missing logging on auth events | A09 Logging Failures | CWE-778 | medium |
| SSRF — outbound HTTP from server to user-controlled URL | A10 SSRF | CWE-918 | high |

Memorising the table is not the goal. Memorising the *shape* of the
table is — anchor first, severity derived.

---

## 7. Durable remediations — the patterns Ira proposes by reflex

Every block must propose the fix. The fix must be durable, not a
workaround.

### 7.1 SQL injection → parameterised queries (every stack)

**Python (asyncpg):**

```python
# WRONG
await pool.fetch(f"SELECT * FROM users WHERE email = '{email}'")
# RIGHT
await pool.fetch("SELECT * FROM users WHERE email = $1", email)
```

**TypeScript (Knex):**

```typescript
// WRONG
await knex.raw(`SELECT * FROM users WHERE email = '${email}'`);
// RIGHT
await knex.raw("SELECT * FROM users WHERE email = ?", [email]);
// or the query builder, which parameterises automatically:
await knex("users").where({ email }).first();
```

**TypeScript (Prisma):**

```typescript
// WRONG — $queryRawUnsafe takes a string and runs it as-is
await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE email = '${email}'`);
// RIGHT — tagged template literal is parameterised at the driver
await prisma.$queryRaw`SELECT * FROM users WHERE email = ${email}`;
// or the type-safe API:
await prisma.user.findUnique({ where: { email } });
```

**PHP (Laravel):**

```php
// WRONG
DB::select("SELECT * FROM users WHERE email = '$email'");
// RIGHT — DB facade with bindings
DB::select("SELECT * FROM users WHERE email = ?", [$email]);
// or query builder / Eloquent (parameterised by default):
DB::table('users')->where('email', $email)->first();
User::query()->where('email', $email)->first();
```

Not "validate the input first" — that is a workaround that fails on the
next code path. Parameterise everywhere, in every stack.

### 7.2 Hardcoded secret → env + secret manager + .gitignore + revoke

Four steps, in order. Anything short is a workaround:

1. Read the secret from env / SOPS / secret manager.
2. Add the env var to `.env.example` *without* the real value.
3. Confirm `.env` is in `.gitignore`.
4. **Revoke the leaked secret.** It is in git history; rotation is
   mandatory, not optional. Hand the revoke command to the engineer.

(Examples in §9 use the placeholder string `<PLACEHOLDER_FAKE_KEY>` for
the leaked-secret string. Real keys never appear in this skill.)

### 7.3 XSS → output encoding at the template layer, not before

```jsx
// WRONG — manual encoding before storage
storeUserBio(escapeHtml(input))

// RIGHT — store raw, encode on render
storeUserBio(input)
<div>{userBio}</div>   // React encodes on render
```

The framework's render-time encoding is the durable answer. Pre-encoding
on store creates double-encoding bugs and breaks search.

### 7.4 Missing input validation → Pydantic at the boundary

```python
# WRONG — manual checks scattered through service code
if len(email) > 254: raise BadRequest(...)
if "@" not in email: raise BadRequest(...)

# RIGHT — validate at the contract boundary
class CreateUser(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr = Field(max_length=254)
```

The Pydantic model is the validation layer. Inputs that survive the
model are valid by construction; the service does not re-check.

### 7.5 Auth/authz — middleware + ownership check at service

```python
# Auth (middleware) — is the caller authenticated?
# Authz (service) — does this caller own this resource?
async def get_invoice(id: str, principal: Principal) -> Invoice:
    inv = await self._repo.get(id)
    if inv is None:
        raise NotFoundError(...)
    if inv.customer_id != principal.customer_id:
        raise NotFoundError(...)   # 404 not 403 — do not leak existence
    return inv
```

The 404-on-authz-fail pattern is deliberate: a 403 confirms the
resource exists.

### 7.6 SSRF → allowlist of resolved IPs / domains, not deny-list

```python
# WRONG — try to block private IPs by string match
if url.startswith("http://10.") or "localhost" in url: ...

# RIGHT — resolve, then check against a positive allowlist
host = urlparse(url).hostname
ip = await resolver.resolve(host)
if not in_allowlist(ip):
    raise ForbiddenURL(...)
```

Deny-lists are bypassable by encoding tricks, DNS rebinding, IPv6
aliases. Allowlists fail closed.

### 7.7 Weak crypto → name the right primitive

| For | Use |
|---|---|
| Password hashing | `argon2id` (preferred) / `bcrypt` |
| Symmetric encryption | `AES-256-GCM` / `XChaCha20-Poly1305` |
| Asymmetric signing | `Ed25519` |
| MAC | `HMAC-SHA-256` |
| Token generation | `secrets.token_urlsafe(32)` |
| File hashing (non-secret) | `SHA-256` |

Not "use a stronger algorithm." Name the primitive.

### 7.8 Insecure deserialization → JSON + Pydantic, not pickle

If the data crosses a trust boundary, it must arrive as JSON and be
validated by a Pydantic model. Pickle is an internal-trust-boundary
tool only.

---

## 8. The dependency layer — where Ira gates before Benaiah vets

Code-level dependency hygiene Ira enforces (Benaiah owns the deeper
supply-chain analysis):

- **Every dependency pinned.** No `^`, no `~`, no `*`. Hash-pinned in
  the lockfile.
- **Lockfile present and committed.** `pnpm-lock.yaml`, `poetry.lock`,
  `uv.lock` — committed. Generated reproducibly.
- **New dependency = block until Benaiah vets via `dependency-vetting`
  skill.** Cannot land without the vet log.
- **Critical CVE in a dependency = block until pinned-around or
  exception noted.** If the vulnerable version is pinned, an inline
  comment with the CVE id explains the pin choice.
- **CI gate runs OSV-Scanner and `trivy fs` on every PR.** Findings
  block the merge.

The standards rule named: `payload/mishkan/rules/common/dependencies.md`
(if present in the project). When a new dep arrives, Ira routes to
Benaiah; until Benaiah signs off, the dep does not land.

---

## 9. Worked example A — "Hardcoded API key in a config file"

The write that arrived (key shown as a placeholder; never put a real
key in code):

```python
# config.py
GEMINI_API_KEY = "<PLACEHOLDER_FAKE_KEY>"
```

Ira's path:

**§2 rubric:**

1. Line cited: `config.py:1`.
2. Failure mode: secret is in git history forever; any read of the
   public repo (intentional or via a fork / leak) exposes the live key
   to the world; the key authenticates billing to the project's
   account.
3. Severity: **critical**. Anchor: OWASP A07, CWE-798.
4. Durable remediation: §7.2 — move to env, document in `.env.example`,
   confirm `.gitignore`, **revoke the key.**
5. Right place to block: yes — this is a write that ships the secret;
   blocking before commit is the layer.

**Action:** block, fix the file:

```python
import os
GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]
```

Update `.env.example`:

```
GEMINI_API_KEY=
```

**Hand to the engineer** (asymmetric delegation):

```bash
# Revoke the leaked key — required, the key is in git history.
# 1. Open the provider console → API keys → revoke the leaked key.
# 2. Issue a new key, place it in .env (not source).
# 3. Audit provider billing for unauthorised use in the leak window.
```

The remediation is not done until the key is revoked. The code edit is
necessary; the rotation is the actual fix.

---

## 10. Worked example B — "Raw f-string SQL with user-controlled input"

The write:

```python
async def find_by_email(self, email: str):
    return await self._pool.fetch(
        f"SELECT * FROM users WHERE email = '{email}'"
    )
```

Ira's path:

**§2 rubric:**

1. Line: `users.py:12`.
2. Failure mode: `email = "x' OR '1'='1"` returns the whole table.
   Worse: `email = "x'; UPDATE users SET admin = true WHERE email = 'x"`
   on a connection that supports multi-statements is privilege
   escalation. The injection is direct and remote.
3. Severity: **critical**. Anchor: OWASP A03, CWE-89.
4. Remediation: §7.1 — parameterise.
5. Block: yes.

**Action:** block, fix the file:

```python
async def find_by_email(self, email: str):
    return await self._pool.fetch(
        "SELECT * FROM users WHERE email = $1", email
    )
```

**What Ira does NOT also do:** rewrite the surrounding code,
add input validation as a workaround instead of parameterising,
add a `try/except` to "handle the case," refactor the repository layer.
Scope is the security finding. The fix is the fix.

---

## 11. Worked example C — the false-positive guard in action

The write that arrived:

```python
log.info(f"completed order {order_id} for user {user_id}")
```

LLM-review instinct: "This logs a user_id; could be PII."

Ira's path:

**§4 guard list:** entry 8 — operational identifiers (`user_id`,
`request_id`) are not PII. They are how support correlates and how
incidents are traced. Logging them is required by the observability
rule, not a leak.

**Action:** do not flag. Move on.

The discipline of *not* flagging this is what keeps the next real
finding credible.

---

## 12. The SAST configuration Ira reaches for

Three layers, in order:

| Layer | Tool | What it catches |
|---|---|---|
| **Pre-commit** | `gitleaks` | secrets in working tree |
| **Pre-merge CI** | `semgrep` (with the curated rule pack) | high-confidence patterns: hardcoded secrets, SQL string-concat, eval-on-input, unsafe deserialise |
| **Pre-merge CI** | `bandit` (Python) / `eslint-plugin-security` (JS) | language-specific lint of known anti-patterns |
| **Per-merge** | `osv-scanner` + `trivy fs` | dependency CVEs and container CVEs |

Three rules:

- **Rules over scanners.** A small, curated rule set with low false-
  positives beats a large default ruleset that engineers learn to
  ignore.
- **CI gates merges, hooks gate writes.** The PreToolUse hook stops
  obvious things before a write lands; the CI catches what survives.
- **No silenced scanners.** A `nosec` / `# noqa` annotation requires an
  inline comment naming the reason and an anchor (CVE, rule id) — same
  discipline as a finding.

---

## 13. The interface with Benaiah, Hushai, Joab, Phinehas

- **Ira → Benaiah.** Anything supply-chain or infrastructure-level
  (new dependency, container image, deploy config) routes to Benaiah.
  Ira flags; Benaiah decides.
- **Ira → Hushai.** When a control prioritisation question surfaces
  ("we have 14 medium findings, where do we invest?"), route to Hushai
  for strategic counsel. Ira does not prioritise at the program level.
- **Ira → Joab.** Application-surface findings (auth flow shape,
  session, CSRF, mobile/desktop client) are Joab's. Ira flags the
  code; Joab owns the surface analysis.
- **Phinehas → Ira.** Cross-cutting constraints flow down from
  Phinehas. Ira enforces them at the code layer.

---

## 14. The recurring traps Ira rejects on sight

1. **"Add validation to be safe."** Not a finding. A finding names the
   exploit path. Defensive validation as a general hedge is noise.

2. **"This `try/except: pass` is suppressing security."** Maybe, but
   the anchor is correctness (CWE-755 improper error handling), not
   security. Route to Uriah.

3. **"This dependency has a CVE."** A finding *names the CVE*, the
   affected version range, the version currently used, and whether
   the project is in the exploit path. "Has a CVE" without that is
   noise. Use OSV-Scanner output verbatim.

4. **"This crypto is weak."** §7.7. Name the primitive, the
   replacement, the migration path. "Use stronger crypto" is not a
   remediation.

5. **"This could be exploited under certain conditions."** What
   conditions, explicitly? If you cannot state them, you do not have
   a finding yet — you have a hypothesis. Park it; come back when you
   can.

6. **Suppressing a finding without an anchor.** A `# semgrep: ignore`
   without a reason note is a defect. Suppression has the same
   anchoring discipline as a finding.

---

## 15. Style — Ira's working voice

- **Direct, brief, anchored.** "OWASP A03, CWE-89, line 12. Fix:
  parameterise." Not five paragraphs of context.
- **No "could," "might," "may."** A finding states what the code does
  and what the exploit yields. Conditional language is suppression in
  disguise.
- **Cite the rule, every time.** The engineer reading the finding
  should be able to look up the anchor and verify the call.
- **Watchful without paranoia.** The role title is the discipline. A
  watcher who flags everything is the same as a watcher who flags
  nothing — the signal is gone either way.

---

*Cross-references: `~/.claude/rules/y4nn-standards.md`
(verify-before-fix §2, durable rule §3, no-fabrication §6,
asymmetric-delegation §5 — Ira never executes a rotation, hands the
command to the engineer), `payload/mishkan/agents/ira.md` (the agent that
invokes this skill), `payload/mishkan/hooks/pre-tool-security.sh`
(the runtime side; Ira is its live intelligence).*
