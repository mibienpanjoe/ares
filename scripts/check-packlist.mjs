#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const cacheDir = process.env.ARES_NPM_CACHE || "/tmp/ares-npm-cache";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function fail(message, stdout = "", stderr = "") {
  process.stderr.write(`check-packlist: ${message}\n`);
  if (stdout) process.stderr.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(1);
}

const result = spawnSync("/bin/bash", [
  "-lc",
  `set -o pipefail; npm_config_cache=${shellQuote(cacheDir)} npm --silent pack --dry-run --json --ignore-scripts | cat`,
], {
  cwd: root,
  env: process.env,
  encoding: "utf8",
});

if (result.status !== 0) {
  fail(`npm pack dry-run failed (${result.status})`, result.stdout, result.stderr);
}

let parsed;
try {
  parsed = JSON.parse(result.stdout);
} catch {
  fail("npm pack did not return parseable JSON", result.stdout, result.stderr);
}

const pack = parsed?.[0];
const files = pack?.files?.map(file => file.path) || [];
const fileSet = new Set(files);

function assert(condition, message) {
  if (!condition) fail(message);
}

for (const required of [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "bin/ares.js",
  "bin/mishkan.js",
  "scripts/check-cli.mjs",
  "scripts/check-compose.mjs",
  "scripts/check-curated.mjs",
  "scripts/check-docs.mjs",
  "scripts/check-hooks.mjs",
  "scripts/check-ingest.mjs",
  "scripts/check-layout.mjs",
  "scripts/check-observability.mjs",
  "scripts/check-package.mjs",
  "scripts/check-packlist.mjs",
  "scripts/check-runtime-clis.mjs",
  "scripts/check-work-store.mjs",
  "docs/design/ARES_runtime_portability_plan.md",
  "payload/core/manifest.json",
  "payload/targets/index.json",
  "payload/targets/claude/manifest.json",
  "payload/targets/codex/manifest.json",
  "payload/targets/opencode/manifest.json",
  "payload/mishkan/org/org.json",
  "payload/mishkan/commands/mishkan-init.md",
  "payload/mishkan/observability/watchd/src/mishkan_watchd/sources/opencode_storage.py",
]) {
  assert(fileSet.has(required), `missing required package file: ${required}`);
}

for (const path of files) {
  assert(!path.includes("__pycache__/"), `Python cache directory leaked into package: ${path}`);
  assert(!path.endsWith(".pyc"), `Python bytecode leaked into package: ${path}`);
  assert(!/^ares-harness-.*\.tgz$/.test(path), `local tarball leaked into package: ${path}`);
}

assert(pack.name === "ares-harness", `unexpected package name: ${pack.name}`);
assert(pack.entryCount === files.length, "entryCount does not match files list length");
assert(files.length > 200, `package file count unexpectedly small: ${files.length}`);

console.log(`check-packlist ok (${files.length} files)`);
