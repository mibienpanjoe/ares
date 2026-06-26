#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const payloadRoot = realpathSync(join(root, "payload"));

function fail(message) {
  process.stderr.write(`check-layout: ${message}\n`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot parse ${path}: ${error.message}`);
  }
}

const coreManifestPath = join(payloadRoot, "core", "manifest.json");
const core = readJson(coreManifestPath);
assert(core.schemaVersion === 1, "unsupported core manifest schema");
assert(typeof core.sourceRoot === "string" && core.sourceRoot, "core sourceRoot missing");
const coreSource = realpathSync(resolve(dirname(coreManifestPath), core.sourceRoot));
assert(coreSource === payloadRoot || coreSource.startsWith(`${payloadRoot}/`), "core sourceRoot escapes payload/");
for (const domain of core.domains || []) {
  assert(existsSync(join(coreSource, domain)), `core domain missing from sourceRoot: ${domain}`);
}
for (const required of ["agents", "skills", "workflows", "config", "cognee", "observability", "org", "scripts"]) {
  assert((core.domains || []).includes(required), `core manifest omits required domain: ${required}`);
}

const targetsRoot = join(payloadRoot, "targets");
const index = readJson(join(targetsRoot, "index.json"));
assert(index.schemaVersion === 1, "unsupported target index schema");
assert(JSON.stringify(index.targets) === JSON.stringify(["claude", "codex", "opencode"]), "target order changed unexpectedly");
for (const target of index.targets) {
  const manifest = readJson(join(targetsRoot, target, "manifest.json"));
  assert(manifest.id === target, `${target} manifest id mismatch`);
  for (const field of ["instructionFile", "agentFormat", "commandSurface", "hookSurface", "initInvocation", "initUsage"]) {
    assert(typeof manifest[field] === "string" && manifest[field], `${target} manifest missing ${field}`);
  }
}

const codex = readJson(join(targetsRoot, "codex", "manifest.json"));
assert(codex.initInvocation === "$ares-init", "Codex canonical init invocation changed");
assert(!codex.initUsage.includes("/prompts:"), "Codex manifest reintroduced removed custom prompts");
for (const target of ["claude", "opencode"]) {
  const manifest = readJson(join(targetsRoot, target, "manifest.json"));
  assert(manifest.initInvocation === "/ares-init", `${target} slash init invocation changed`);
}

const cli = readFileSync(join(root, "bin", "mishkan.js"), "utf8");
assert(cli.includes("CORE_PAYLOAD"), "CLI does not resolve the core manifest");
assert(cli.includes("TARGET_DEFINITIONS"), "CLI does not resolve target manifests");
assert(!cli.includes('join(PKG, "payload", "mishkan"'), "CLI bypasses the core manifest with a direct legacy payload path");

console.log("check-layout ok");
