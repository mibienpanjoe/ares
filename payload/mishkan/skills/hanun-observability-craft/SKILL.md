---
name: hanun-observability-craft
description: How Hanun wires hardening overlays, secrets ops, and observability (Prometheus / Grafana / Loki / Sentry / GlitchTip / OpenTelemetry) — the always-reapply-on-recreate rule, the metric / log / trace separation, the alerting discipline, and the no-prod-execution boundary. Invoke when observability wiring or hardening setup is in scope.
---

# Hanun — Observability & DevSecOps Support Craft

> Not a checklist. How the one who repaired the Valley Gate, covering
> a long section of the wall in support mode, reasons when handed
> operational glue — what he wires, what he refuses to leave one-off,
> and the rule that the hardening overlay returns every time the
> container does.

Invoked when observability, hardening, secrets operations, or
operational support work is in scope.

---

## 1. The rule above all other rules

**The hardening overlay is re-applied on every container recreate.**

Three corollaries:

- **No one-time hardening.** A container that loses its overlay
  because the recreate skipped the step is unhardened in production.
  The overlay is part of the create.
- **No prod execution.** Hanun prepares; the engineer runs.
- **Observability instrumentation is in the application's image,
  not appended at runtime.** A side-loaded agent is a future
  divergence.

---

## 2. The three observability signals

| Signal | Question | Tool |
|---|---|---|
| **Metric** | What is the rate / count / latency of X? | Prometheus + Grafana |
| **Log** | What happened in this single event? | Loki / Elasticsearch + log shipper |
| **Trace** | Where in the request path was time spent? | Tempo / Jaeger + OpenTelemetry |

Three rules:

- **Each signal has its own pipeline.** Metrics are sampled and
  aggregated; logs are full-text and high-volume; traces are
  sampled and structured.
- **Correlation across signals via trace_id.** Every log line in
  a request carries the trace_id; clicking from a metric spike
  to a trace, then from the trace to the logs, is the workflow.
- **Sampling is deliberate.** 100% traces is a budget problem;
  random 1% misses the long tail. Tail-based sampling for slow
  requests; head-based for the steady state.

---

## 3. Prometheus — the metric layer

Three rules:

- **Metric names follow `domain_subsystem_unit`**:
  `http_requests_total`, `db_query_duration_seconds`.
- **Labels are bounded cardinality.** A label that takes one
  value per user-id is a fast path to OOM.
- **Histograms over summaries** for latency. Histograms allow
  cross-instance aggregation; summaries do not.

The four golden signals (Google SRE Book):

- **Latency** — p50 / p95 / p99 per route.
- **Traffic** — requests per second per route.
- **Errors** — error rate per route.
- **Saturation** — resource utilisation (CPU, memory, pool
  saturation).

---

## 4. Grafana — the dashboard layer

Three rules:

- **Dashboards are versioned in code.** Grafana provisioning
  loads them from JSON in version control.
- **The dashboard answers a question.** Random-panel dashboards
  are noise; "is the API healthy?" "is the queue backlogged?"
  are dashboards.
- **The dashboard links to the runbook.** When a dashboard
  shows an unhealthy state, the operator should be one click
  from the runbook.

---

## 5. Loki — the log layer

Three rules:

- **Structured logs only.** JSON; key-value; not unstructured
  printf.
- **`trace_id` in every log line** during request handling.
- **Labels minimal in Loki.** Loki uses labels for partitioning;
  high-cardinality labels (request_id as label) break the index.

Sample log shape:

```json
{
  "ts": "2026-06-02T14:00:00Z",
  "level": "info",
  "trace_id": "01HX...",
  "request_id": "req_01HX...",
  "service": "api",
  "route": "POST /invoices",
  "status": 201,
  "duration_ms": 142
}
```

---

## 6. OpenTelemetry — the tracing layer

Three rules:

- **Auto-instrument what is auto-instrumentable.** FastAPI, asyncpg,
  TanStack Query, common HTTP clients have OTel auto-instrumentation.
- **Manual spans at the seams.** Service-layer methods get manual
  spans named for the operation; not every function.
- **Propagate context.** W3C Trace Context (`traceparent`) on every
  outbound call.

---

## 7. Sentry / GlitchTip — error tracking

For application-level errors (uncaught exceptions, error rates
above threshold):

Three rules:

- **Errors carry the request context.** trace_id, user (id only,
  not PII), request path, version.
- **No PII in error payloads.** Strip emails, names, tokens
  before sending.
- **Sampling for noise, not for signal.** Common errors sampled;
  novel errors always captured.

---

## 8. Alerting discipline

Three rules:

- **Page only on user-visible impact.** "Disk 70% full" wakes
  someone needlessly; "API error rate > 1% for 5 minutes" is the
  page.
- **Every page has a runbook.** A page with no runbook gets a
  runbook before the next deploy.
- **Burn-rate alerts on SLOs**, not threshold alerts on raw
  metrics. The SRE-workbook patterns.

---

## 9. Hardening overlay — re-applied on every recreate

The overlay covers:

- **Container security options** (`no-new-privileges`, capability
  drop, read-only filesystem, tmpfs for `/tmp`).
- **Network policy** (default deny; allows only what is named).
- **Resource limits** (CPU + memory).
- **Healthcheck** active.
- **Non-root user** (uid 10001 or similar).

The pattern: the overlay is part of the compose / Helm / K8s
manifest, not a post-create script. Recreating the container
re-applies because the overlay *is* the create.

---

## 10. Secrets ops — the working pattern

(Coordinated with Benaiah on architecture; Hanun handles the
operational layer.)

- **SOPS + age** is the encoding.
- **Decryption at deploy time.** On the host or in the platform's
  secret manager.
- **Rotation procedure documented and rehearsed.** A rotation that
  has never been run will fail at the worst moment.

---

## 11. Worked example — wiring observability for a new service

The new `notifications` service from `meshullam-infra-design-craft`
§8. Hanun wires observability.

**Metrics** (`/metrics` endpoint, Prometheus scrape):

```python
from prometheus_client import Counter, Histogram, generate_latest

notifications_sent = Counter(
    "notifications_sent_total",
    "Notifications sent",
    ["channel", "status"],
)
notifications_duration = Histogram(
    "notifications_duration_seconds",
    "Time to send a notification",
    ["channel"],
)
```

**Logs** (structured, with trace_id):

```python
log.info("notification_sent",
    extra={"trace_id": trace_id, "channel": "email",
           "recipient_id": user_id, "duration_ms": 142})
```

**Traces** (OTel auto-instrumentation + manual span at the seam):

```python
@tracer.start_as_current_span("notifications.send")
async def send(self, request: NotificationRequest) -> NotificationResult:
    # ... auto-instrumented httpx + redis calls inside
```

**Grafana dashboard** (`notifications.json` in repo):

- Latency p95 panel (linked to runbook for high-latency).
- Send rate by channel.
- Error rate by channel.
- Queue backlog (from Redis metric).

**Alerts:**

- SLO: 99% of notifications sent in < 5s; burn-rate alert at 2h
  budget.
- Critical: `notifications` service down for > 1 minute.

**Runbook:**

```markdown
# Runbook — notifications service down

## Trigger
notifications service unreachable for >1 minute.

## Diagnose
1. Check container status: `docker compose ps notifications`
2. Check container logs: `docker compose logs --tail=200 notifications`
3. Check email-provider status page (link).
4. Check Redis and NATS health.

## Mitigate
1. If container down: `docker compose up -d notifications`
2. If email-provider issue: switch fallback channel (see runbook for switch).
3. If Redis/NATS issue: route to Migdal runbook for the affected dependency.

## Resolve
- See ADR-XXXX for the durable fix once root cause is identified.
```

What Hanun did:

- Wired all three signal layers (metrics, logs, traces).
- Set up SLO + burn-rate alert, not threshold alert.
- Wrote the runbook.
- Did NOT execute the wiring on prod.

---

## 12. The recurring traps Hanun rejects on sight

1. **"Hardening overlay later."** §1. No.

2. **"Side-load the observability agent."** §1. In the image.

3. **"Per-user labels for cardinality detail."** §3. No. Labels
   are bounded cardinality.

4. **"Disk 70% full warrants a page."** §8. No. User-impact pages.

5. **"This alert has no runbook; we'll write one later."** §8.
   Runbook before the alert is enabled.

6. **"Log every variable; storage is cheap."** §5. Structured,
   bounded, scrubbed.

---

## 13. Style — Hanun's voice

- **Operational glue.** The unglamorous work that makes everything
  stay up.
- **Three signals, distinct.** Metrics for rates, logs for events,
  traces for path.
- **Runbooks for every page.** No alerts without remediation.

---

*Cross-references: `~/.claude/rules/y4nn-standards.md` (durable §3,
asymmetric-delegation §5, hardening overlay in §10),
`payload/mishkan/skills/team-lead-craft/SKILL.md` (Eliashib routes),
`payload/mishkan/skills/meshullam-infra-design-craft/SKILL.md` (the
topology this observability covers), `payload/mishkan/skills/palal-
systems-craft/SKILL.md` (the OS layer Hanun's signals observe),
`payload/mishkan/skills/rehum-sre-advisor-craft/SKILL.md` (the SRE
advisor for SLO definition).*
