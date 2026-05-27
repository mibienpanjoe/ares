---
name: dependency-audit
description: Audit dependencies across ALL of Y4NN's projects and coordinate updates portfolio-wide. Inventories manifests/lockfiles across the project registry, runs OSV/trivy, aggregates shared vulnerabilities and shared packages, prioritises, and produces a coordinated update plan. Use for periodic cross-project security audits and fleet-wide upgrades. Cross-harness scope.
---

# dependency-audit

Audit and update dependencies **across every project**, not one repo at a time.
A vulnerability in a package Y4NN uses in five projects is one finding with five
blast points. Cross-harness scope — owned by Benaiah, documented by Seraiah
(org layer), rolled out via Migdal.

## When to use

- Periodic portfolio security audit (recommended every sprint close, or on demand).
- When a high-profile CVE drops in a widely-used package.
- Before a fleet-wide framework bump.

## Procedure

1. **Inventory** — run `~/.claude/mishkan/scripts/dependency-audit.sh`, which reads
   the project registry (`~/.claude/mishkan/config/projects.yaml`) and collects
   every manifest/lockfile across the listed project roots.
2. **Scan** — the script runs OSV-Scanner / `trivy fs` per project where available
   and aggregates results.
3. **Aggregate cross-project** —
   - **Shared packages:** which dependency+version appears in which projects.
   - **Shared vulnerabilities:** one CVE → all affected projects (the portfolio view).
   - **Version drift:** the same package pinned to different versions across projects.
4. **Prioritise** — order by severity × blast radius (how many projects affected ×
   exposure). Critical-in-many-projects first.
5. **Vet upgrades** — for each fix, run **dependency-vetting** on the target version,
   then **dependency-upgrade** for compatibility/breaking-change analysis per project.
6. **Coordinate the rollout** — Migdal sequences the update across projects (staging
   first, per project's deploy flow). Stateful operations stop at Y4NN's hands —
   prepare the pinned manifest + lockfile regen command per project; Y4NN runs them.
7. **Record** — write a cross-harness Cognee node (SecurityFinding + the portfolio
   audit summary); Seraiah documents the portfolio posture; Huldah/Maaseiah surface
   it at milestone.

## Output

```
audit_date: <iso>
projects_scanned: [...]
critical_findings:
  - cve: <id>  severity: <>  package: <name@version>
    affected_projects: [...]   # the blast radius
    fix_version: <>            # vetted target
    breaking: yes|no
version_drift: [{package, versions_by_project}]
update_plan: [ordered steps, per project, staging-first ]
```

## Constraints

No fabricated CVEs (OSV/NVD ids only). No update is executed by AI — manifests
and lockfile regen commands are prepared; Y4NN runs installs and deploys.
Cross-harness promotion gated by Nehemiah + Bezalel. English only.
