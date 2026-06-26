#!/usr/bin/env node
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const tmp = `/tmp/ares-curated-check-${process.pid}`;
const runtime = join(tmp, "runtime");
const fakeBin = join(tmp, "bin");
const logPath = join(tmp, "docker.log");
const sourceCognee = join(root, "payload", "mishkan", "cognee");
const script = join(root, "payload", "mishkan", "scripts", "ensure-curated-box.sh");

function fail(message, result = null) {
  process.stderr.write(`check-curated: ${message}\n`);
  if (result?.stdout) process.stderr.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function run(mode) {
  writeFileSync(logPath, "");
  const result = spawnSync("bash", [script], {
    cwd: tmp,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      HOME: join(tmp, "home"),
      ARES_HOME: runtime,
      FAKE_MODE: mode,
      FAKE_DOCKER_LOG: logPath,
    },
    encoding: "utf8",
  });
  if (result.status !== 0) fail(`${mode} scenario failed (${result.status})`, result);
  return { output: result.stdout || "", error: result.stderr || "", log: readFileSync(logPath, "utf8") };
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(fakeBin, { recursive: true });
mkdirSync(join(tmp, "home"), { recursive: true });
cpSync(sourceCognee, join(runtime, "cognee"), { recursive: true });
writeFileSync(join(runtime, "cognee", ".env"), "LLM_API_KEY=test\nDB_PASSWORD=test\n");
writeFileSync(join(runtime, "cognee", ".env.curated"), "GRAPH_DATABASE_PASSWORD=test\n");

const docker = join(fakeBin, "docker");
writeFileSync(docker, [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "printf '%s|%s|%s|%s|%s|%s|%s\\n' \"${FAKE_MODE:-}\" \"${COGNEE_PG_CONTAINER:-}\" \"${CURATED_MCP_CONTAINER:-}\" \"${CURATED_NEO4J_CONTAINER:-}\" \"${COGNEE_WORK_NETWORK:-}\" \"${COGNEE_MCP_IMAGE:-}\" \"$*\" >> \"${FAKE_DOCKER_LOG:?}\"",
  "if [[ \"${1:-}\" == ps ]]; then",
  "  if [[ \"${FAKE_MODE:-}\" == legacy ]]; then",
  "    printf '%s\\n' mishkan-cognee-pg mishkan-curated-mcp mishkan-curated-neo4j",
  "  else",
  "    printf '%s\\n' ares-cognee-pg",
  "  fi",
  "  exit 0",
  "fi",
  "if [[ \"${1:-}\" == inspect ]]; then printf '%s\\n' healthy; exit 0; fi",
  "if [[ \"${1:-}\" == exec ]]; then",
  "  if [[ \"$*\" == *'SELECT 1 FROM pg_database'* ]]; then printf '%s\\n' 1; fi",
  "  if [[ \"$*\" == *'MATCH (n:CuratedResource)'* ]]; then printf '%s\\n' 1; fi",
  "  exit 0",
  "fi",
  "exit 0",
  "",
].join("\n"));
chmodSync(docker, 0o755);

try {
  const fresh = run("fresh");
  assert(fresh.output.includes("curated box ready on :7730"), "fresh curated scenario did not complete");
  assert(fresh.output.includes("already populated (1 nodes)"), "fresh curated graph count was not read");
  assert(fresh.log.includes("fresh|ares-cognee-pg|ares-curated-mcp|ares-curated-neo4j|ares-cognee_cognee_net|ares/cognee-mcp|compose"), "fresh curated compose environment is not fully ARES-native");

  const legacy = run("legacy");
  assert(legacy.output.includes("curated box ready on :7730"), "legacy curated scenario did not complete");
  assert(legacy.log.includes("legacy|mishkan-cognee-pg|mishkan-curated-mcp|mishkan-curated-neo4j|mishkan-cognee_cognee_net|mishkan/cognee-mcp|ps"), "legacy curated compatibility environment not selected");
  assert(!legacy.log.includes("legacy|ares-cognee-pg|"), "legacy curated scenario unexpectedly selected ARES Postgres");

  console.log("check-curated ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
