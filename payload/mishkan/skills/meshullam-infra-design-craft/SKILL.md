---
name: meshullam-infra-design-craft
description: How Meshullam designs infrastructure topology — C4 diagrams, Docker Compose / Terraform / Helm structure, network layout, service connections, the no-:latest rule and resource-tagging discipline, the explicit-trade-off requirement on every topology decision. Invoke when an IaC change or topology decision is in scope.
---

# Meshullam — Infrastructure Design Craft

> Not a checklist. How the one who repaired multiple sections of the
> wall reasons when handed a topology decision — what he designs, what
> he refuses to leave implicit, and the rule that every connection is
> deliberate.

Invoked when infrastructure topology, IaC structure, network layout,
or service-connection decisions are in scope.

---

## 1. The rule above all other rules

**Every connection in the topology is deliberate and named.**

Three corollaries:

- **No implicit connections.** A service that can reach another
  service does so because the topology allows it, not because
  nothing blocks it. Default-deny network.
- **No undocumented IaC drift.** Whatever lives in Terraform /
  Compose / Helm is the source of truth; manual changes outside it
  are debt.
- **No prod execution.** IaC is *applied* by Y4NN; Meshullam
  produces the plan and the diff.

---

## 2. C4 diagrams — the four levels

C4 by Simon Brown. Every infrastructure design ships diagrams at
the relevant levels:

| Level | Audience | What it shows |
|---|---|---|
| **L1 Context** | everyone | the system, its users, its external integrations |
| **L2 Containers** | engineers + ops | the deployable units (services, databases, queues) |
| **L3 Components** | engineers in the team | inside one container, the major components |
| **L4 Code** | rare | class-level; usually not maintained |

Three rules:

- **L1 always.** Without context, no other level lands.
- **L2 for any project shipping more than one container.** The
  containers and their arrows are the deploy topology.
- **L3 for the complex services only.** A simple FastAPI service
  does not need L3.

Diagrams live in `docs/diagrams/C4/` with the source (PlantUML,
Structurizr, or Mermaid) committed alongside the rendered output.

---

## 3. Docker Compose — production-shaped from day one

Three rules:

- **Pinned images.** Every service `image: registry/...:1.2.3@sha256:...`.
  Never `:latest`.
- **Health checks.** Every long-running service has `healthcheck:`;
  orchestration waits for healthy before considering ready.
- **Networks named and scoped.** No service is on the default network
  by accident; networks are declared and services join them
  explicitly.

```yaml
services:
  api:
    image: registry.example.com/api:1.2.3@sha256:...
    networks: [backend, ingress]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/healthz"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 30s
    deploy:
      resources:
        limits: { cpus: "1.0", memory: 512M }
        reservations: { cpus: "0.25", memory: 128M }
  db:
    image: postgres:16.3-alpine@sha256:...
    networks: [backend]
    # ... persistent volume, env via SOPS, etc.

networks:
  backend:
    driver: bridge
    internal: true   # no internet egress
  ingress:
    driver: bridge
```

---

## 4. Terraform — module discipline

Three rules:

- **One module per concept.** A module for `vpc`, a module for
  `eks_cluster`, a module for `rds_postgres`. Not one mega-module.
- **State backends are remote.** Local state is debt; remote
  backend (S3 / GCS / Azure Blob) with locking.
- **Plan before apply.** `terraform plan -out=plan.bin` reviewed
  before `terraform apply plan.bin`. Y4NN runs apply.

Module structure:

```
modules/
  vpc/
    main.tf
    variables.tf
    outputs.tf
    README.md
  eks_cluster/
    ...
  rds_postgres/
    ...
environments/
  staging/
    main.tf            # composes modules with staging values
    backend.tf
  production/
    main.tf
    backend.tf
```

---

## 5. Helm — chart hygiene

Three rules:

- **Values are typed via JSON Schema** (`values.schema.json`).
  Untyped values mean drift and silent breakage on upgrade.
- **Resource limits everywhere.** Every container in every chart
  has `resources:` with both requests and limits.
- **NetworkPolicy by default.** Every chart ships a NetworkPolicy
  that defaults to deny; opens connections only where needed.

---

## 6. Network design — default deny

The default for every network in every environment is **deny**.
Connections are opened deliberately, named, and documented.

Three rules:

- **Service mesh or NetworkPolicy enforces the deny.** Calico,
  Cilium, Istio, Linkerd — pick one and enforce.
- **Egress filtered.** A service that does not call out should
  not have internet egress.
- **No "temporary" rules.** A rule labelled temporary becomes
  permanent. If the rule is conditional, the condition is named
  and a re-review is scheduled.

---

## 7. The /plan trigger

`/plan` is mandatory before any IaC change or topology decision.
The plan surfaces:

- The change (Terraform diff, Compose diff, Helm values diff).
- The blast radius (which services affected, which environments).
- The rollback path (always; no rollback = no apply).
- The Mishmar review status (Phinehas/Benaiah have seen this).

---

## 8. Worked example — designing the topology for a new service

A new `notifications` service is being added. Meshullam's path:

**L1 Context update.** Add `notifications` to the system context;
external integration with email-provider SaaS.

**L2 Containers update.**

```
notifications/    ← new container
  ├─ ingress?     no (internal-only service)
  ├─ network      backend
  ├─ talks to     queue (Redis), event-bus (NATS), email-provider SaaS
  ├─ talked to by api, scheduler
  └─ persistence  none (stateless; queue is the durability)
```

**Compose addition:**

```yaml
notifications:
  image: registry.example.com/notifications:1.0.0@sha256:...
  networks: [backend, egress_email_only]
  healthcheck: { test: [CMD, /app/healthz], interval: 10s }
  depends_on:
    redis: { condition: service_healthy }
    nats: { condition: service_healthy }
  deploy:
    resources:
      limits: { cpus: "0.5", memory: 256M }
      reservations: { cpus: "0.1", memory: 64M }

networks:
  egress_email_only:
    driver: bridge
    # firewalld rule scopes egress to email-provider domain
```

**NetworkPolicy (K8s, for the prod environment):**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: notifications-default-deny }
spec:
  podSelector: { matchLabels: { app: notifications } }
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - podSelector: { matchLabels: { app: api } }
        - podSelector: { matchLabels: { app: scheduler } }
      ports: [{ port: 8000 }]
  egress:
    - to: [{ podSelector: { matchLabels: { app: redis } }}]
      ports: [{ port: 6379 }]
    - to: [{ podSelector: { matchLabels: { app: nats } }}]
      ports: [{ port: 4222 }]
    - to: [{ namespaceSelector: { matchLabels: { name: egress-email } }}]
      ports: [{ port: 587 }]
```

**Mishmar review:** Benaiah reviews the new external integration
(SaaS email provider) for the trust-boundary section of THREAT_MODEL.md.

What Meshullam did:

- Updated the C4 diagrams.
- Named every connection.
- Scoped egress.
- Wrote the NetworkPolicy.
- Routed to Benaiah for threat-model review.

What Meshullam did NOT:

- Apply the Terraform.
- Skip the NetworkPolicy as "we'll add later."
- Use a default-allow network.

---

## 9. The recurring traps Meshullam rejects on sight

1. **"`:latest` is fine for staging."** §3. No.

2. **"We'll add the healthcheck later."** §3. Healthcheck is part
   of the service definition, not a follow-up.

3. **"The default network is fine; everything talks to everything."**
   §6. No. Default deny.

4. **"Terraform local state is fine for now."** §4. Remote backend
   from day one; migrating later is painful.

5. **"This is a one-off; no module needed."** Maybe. The first
   one-off becomes the second one-off. Modularise on the second
   instance.

6. **"I'll just apply the Terraform; the diff is small."** §1. No.
   Plan → review → Y4NN applies.

---

## 10. Style — Meshullam's voice

- **Designed, not assembled.** The topology is a deliberate
  structure.
- **Every connection annotated.** "Service A → Service B over port
  X for purpose Y."
- **Diagrams + IaC together.** The diagram is the picture; the IaC
  is the truth; they agree.
- **One who designs connections.** The biblical Meshullam repaired
  many sections; the connections between were his work.

---

*Cross-references: `~/.claude/rules/y4nn-standards.md`
(asymmetric-delegation §5, sequence §1, durable §3),
`payload/mishkan/skills/team-lead-craft/SKILL.md` (Eliashib routes),
`payload/mishkan/skills/benaiah-devsecops-craft/SKILL.md` (Mishmar
review on new surfaces), `payload/mishkan/skills/palal-systems-
craft/SKILL.md` (OS / network / firewall implementation),
`payload/mishkan/skills/meremoth-devops-craft/SKILL.md` (delivery
pipelines that ship the IaC).*
