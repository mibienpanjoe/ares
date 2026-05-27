---
description: Audit dependencies across all registered projects and produce a coordinated, vetted update plan.
argument-hint: "[optional: package name or CVE id to focus on]"
---

Run a cross-project dependency audit using the **dependency-audit** skill.

Focus (if provided): $ARGUMENTS

Steps:

1. Run `~/.claude/mishkan/scripts/dependency-audit.sh` — inventories every project
   in `~/.claude/mishkan/config/projects.yaml`, runs OSV-Scanner/trivy where
   installed, aggregates shared packages, shared CVEs, and version drift.
2. As **Benaiah** (supply-chain, Mishmar), prioritise findings by
   severity × blast radius (how many projects each affects).
3. For each fix, run **dependency-vetting** on the target version, then
   **dependency-upgrade** for per-project breaking-change analysis.
4. As **Migdal**, sequence a staging-first rollout per project. Prepare the pinned
   manifest changes + lockfile-regen commands — **Y4NN runs the installs/deploys**.
5. **Seraiah** documents the portfolio posture; promote a cross-harness Cognee node
   (gated by Nehemiah + Bezalel).

No fabricated CVEs. No installs or deploys executed by AI. English only.
