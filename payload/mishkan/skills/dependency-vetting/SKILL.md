---
name: dependency-vetting
description: Vet a single dependency before adopting or upgrading it. Drives the research pipeline to check known CVEs (OSV/NVD), maintenance health, typosquatting, provenance, and transitive blast radius. Use before adding any new package or doing a major version bump. Produces a research log and a go/no-go.
---

# dependency-vetting

Vet one package before it enters the codebase. Adding a dependency is a security
decision — never adopt unvetted. Owned by Benaiah (supply-chain) / Ira (code level).

## When to use

- Before adding any new dependency.
- Before any **major** version upgrade.
- When a package's maintainer/owner changes.

## Procedure (drives the research pipeline)

Invoke the **research-pipeline** skill with a brief covering, for the exact
package + version:

1. **Known vulnerabilities** — OSV.dev and NVD for that version and its range.
2. **Maintenance health** — last release date, release cadence, open critical
   issues, single-maintainer risk, deprecation/archival status.
3. **Typosquatting / impersonation** — is this the genuine package name and
   namespace? Cross-check the source repo and download counts.
4. **Provenance** — signed releases, SLSA level, source repo matches the registry.
5. **Transitive blast radius** — what it pulls in; any risky transitive deps.

Caleb gathers (OSV, registry, repo); Shaphan compresses; Shemaiah judges against
the curated security library; Baruch writes the research log
(`curated_library_match` where OWASP/SLSA/OSV applied).

## Output

```
package: <name@version>
verdict: adopt | adopt-with-conditions | reject
findings:
  cves: [...]            # with severities
  maintenance: <summary>
  typosquat_risk: none|suspected
  provenance: signed|unsigned|unknown
conditions: [...]        # e.g. "pin to >=X.Y.Z", "add OSV-Scanner gate"
```

## After a clean verdict

- Pin the exact version (rules/common/dependencies.md). Add a CVE-pin comment if
  the pin dodges a known issue.
- Regenerate the lockfile via the package manager (never hand-edit).
- On `reject` or `adopt-with-conditions`, surface to the team lead; do not adopt
  silently.

## Constraints

No fabricated CVEs — anchor to OSV/NVD ids. Stateful operations hard stop (the
agent never runs the install; it prepares the pinned manifest change and hands
the install command to Y4NN). English only.
