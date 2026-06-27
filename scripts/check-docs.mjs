#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);

const checks = [
  {
    file: "docs/usage/01-installation.md",
    forbidden: [
      "npx mishkan-harness",
      "docker ps --filter 'name=mishkan-'",
      "mishkan-cognee-mcp",
      "mishkan-curated-mcp",
      "mishkan-ollama",
    ],
    required: [
      "npx ares-harness install --target codex",
      "docker ps --filter 'name=ares-'",
      "ares-cognee-mcp",
      "ares-curated-mcp",
      "ares-ollama",
    ],
  },
  {
    file: "docs/usage/02-project-init.md",
    forbidden: [
      "`/mishkan-init`",
      "`/mishkan-resume`",
      "~/.claude/mishkan",
      "mishkan-work-",
      "npx mishkan-harness",
      "mishkan install",
      "expected: ['cognee', 'cognee-curated']",
      "should list 'cognee' and 'cognee-curated'",
    ],
    required: [
      "ares project init --target all",
      "ares project init --target all --memory cognee",
      "The default memory backend is `native`",
      "expected: ['cognee-memory', 'cognee-curated']",
      "In Codex, invoke `$ares-init` or select `ares-init` through `/skills`",
    ],
  },
  {
    file: "docs/usage/README.md",
    forbidden: [
      "npx mishkan-harness",
      "/mishkan-init",
      "The `mishkan` CLI",
      "mishkan-work-",
      "mishkan install",
    ],
    required: [
      "npx ares-harness install --target ...",
      "`ares project init`, `/ares-init`",
      "The `ares` CLI",
      "ares-work-{slug}",
      "`ares knowledge ingest`, frontmatter tagging",
    ],
  },
  {
    file: "docs/usage/03-orchestration.md",
    forbidden: [
      "~/.claude/mishkan/AGENTS_SKILLS.md",
    ],
    required: [
      "payload/mishkan/AGENT_SPEC.md",
      "`ares-ingest`",
    ],
  },
  {
    file: "docs/usage/04-memory-layer.md",
    forbidden: [
      "mishkan-work-",
      "`/mishkan-init`",
      "~/.claude/mishkan",
      "declares **three** servers",
      "three doorways",
      "\"cognee\":",
      "mishkan-cognee",
    ],
    required: [
      "Native runtime memory",
      "optional advanced infrastructure",
      "ares-work-<slug>",
      "ares project-work-store up",
      "ARES projects initialized with `--memory cognee`",
      "\"cognee-memory\"",
      "\"cognee-curated\"",
      "~/.ares/cognee/.env",
    ],
  },
  {
    file: "docs/usage/05-selective-ingest.md",
    forbidden: [
      "bash ~/.claude/mishkan/scripts/mishkan-ingest.sh",
      "~/.claude/mishkan",
      "docker exec mishkan-cognee-pg",
      "mishkan-curated-mcp",
      "npx mishkan-harness",
    ],
    required: [
      "ares knowledge ingest --tagged-only",
      "ares knowledge ingest docs/SECURITY.md docs/ROADMAP.md",
      "ares knowledge ingest --dataset=research docs/research.md",
      "ares: ingest",
      "legacy `mishkan: ingest`",
      "docker exec ares-cognee-pg",
      "ares-curated-mcp",
    ],
  },
  {
    file: "docs/usage/06-llm-providers.md",
    forbidden: [
      "~/.claude/mishkan",
      "docker exec mishkan-cognee-pg",
      "mishkan-curated-mcp",
      "npx mishkan-harness",
    ],
    required: [
      "~/.ares/cognee/.env",
      "docker exec ares-cognee-pg",
      "cd ~/.ares/cognee",
      "~/.ares/cognee/_src/cognee/.env.template",
    ],
  },
  {
    file: "docs/usage/07-troubleshooting.md",
    forbidden: [
      "mishkan-cognee",
      "mishkan-curated",
      "mishkan-work-",
      "docker exec mishkan",
      "docker logs --since 5m mishkan",
      "docker ps --filter 'name=mishkan-'",
      "~/.claude/mishkan",
      "`/mishkan-init`",
    ],
    required: [
      "docker logs --since 5m ares-cognee-mcp",
      "docker exec ares-cognee-pg",
      "docker run --rm -u 0 -v ares-cognee_cognee_data:/v busybox",
      "ares project-work-store reset",
      "ares knowledge ingest --tagged-only",
      "cd ~/.ares/cognee",
      "docker ps --filter 'name=ares-'",
    ],
  },
  {
    file: "docs/usage/08-glossary.md",
    forbidden: [
      "mishkan-work-",
      "`/mishkan-init`",
      "Reached via the `cognee` MCP alias",
    ],
    required: [
      "ares-work-<slug>",
      "ares project-work-store up",
    ],
  },
  {
    file: "docs/usage/09-workflows.md",
    forbidden: [
      "`/mishkan-init`",
    ],
    required: [
      "`/ares-init`",
    ],
  },
  {
    file: "docs/usage/10-observability.md",
    forbidden: [
      "npx mishkan-harness",
      "mishkan-watch",
      "~/.claude/mishkan/logs",
      "~/.claude/mishkan/run",
      "~/.claude/mishkan/cognee/.env",
      "`/mishkan-init`",
    ],
    required: [
      "npx ares-harness observability install",
      "ares-watchd",
      "ares-watch",
      "~/.ares/logs/*.jsonl",
      "~/.ares/run/watch.sock",
      "~/.ares/cognee/.env",
    ],
  },
  {
    file: "docs/usage/11-graphify.md",
    forbidden: [
      "npx mishkan-harness",
      "`/mishkan-init`",
    ],
    required: [
      "npx ares-harness code-graph scan",
      "npx ares-harness code-graph status",
      "`/ares-init`",
    ],
  },
  {
    file: "docs/usage/12-skill-discovery.md",
    forbidden: [
      "~/.claude/mishkan/scripts/skill-discovery",
      "~/.claude/mishkan/skill-discovery",
      "~/.claude/mishkan/skills/skill-discovery",
      "/mishkan-skills-reindex",
      "/mishkan-skills-misses",
      "mishkan-init` workflow",
    ],
    required: [
      "~/.ares/scripts/skill-discovery-indexer.py",
      "~/.ares/scripts/skill-discovery-router.py",
      "~/.ares/scripts/skill-discovery-misses.py",
      "~/.ares/skill-discovery/",
      "/ares-skills-reindex",
      "/ares-skills-misses",
    ],
  },
  {
    file: "docs/design/ARES_runtime_portability_plan.md",
    forbidden: [],
    required: [
      "## External Acceptance Runbook",
      "npm publish --dry-run",
      "npx ares-harness install --target codex",
      "claude        # run /ares-init or /ares-resume",
      "codex         # run $ares-init or select ares-init through /skills",
      "opencode      # run /ares-init",
      "ares knowledge-stack up",
      "docker ps --filter 'name=ares-'",
    ],
  },
];

function fail(message) {
  process.stderr.write(`check-docs: ${message}\n`);
  process.exit(1);
}

for (const check of checks) {
  const text = readFileSync(join(root, check.file), "utf8");
  for (const value of check.forbidden) {
    if (text.includes(value)) fail(`${check.file} contains stale instruction: ${value}`);
  }
  for (const value of check.required) {
    if (!text.includes(value)) fail(`${check.file} missing expected instruction: ${value}`);
  }
}

console.log("check-docs ok");
