#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const tmp = `/tmp/ares-work-store-check-${process.pid}`;
const fakeBin = join(tmp, "bin");
const logPath = join(tmp, "docker.log");
const script = join(root, "payload", "mishkan", "scripts", "ensure-work-store.sh");
const runtimeHome = join(root, "payload", "mishkan");

function fail(message, result = null) {
  process.stderr.write(`check-work-store: ${message}\n`);
  if (result?.stdout) process.stderr.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function run(mode, port) {
  writeFileSync(logPath, "");
  const result = spawnSync("bash", [script, "demo", String(port)], {
    cwd: tmp,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      ARES_HOME: runtimeHome,
      COGNEE_MCP_REF: "v1.1.0",
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

const docker = join(fakeBin, "docker");
writeFileSync(docker, [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "printf '%s|%s|%s|%s|%s|%s\\n' \"${FAKE_MODE:-}\" \"${WORK_CONTAINER:-}\" \"${WORK_COMPOSE_PROJECT:-}\" \"${COGNEE_MCP_IMAGE:-}\" \"${COGNEE_WORK_NETWORK:-}\" \"$*\" >> \"${FAKE_DOCKER_LOG:?}\"",
  "if [[ \"${1:-}\" == ps ]]; then",
  "  if [[ \"${FAKE_MODE:-}\" == legacy ]]; then printf '%s\\n' 'mishkan-work-demo'; fi",
  "  exit 0",
  "fi",
  "if [[ \"${1:-}\" == network && \"${2:-}\" == inspect ]]; then",
  "  [[ \"${FAKE_MODE:-}\" == legacy-network && \"${3:-}\" == mishkan-cognee_cognee_net ]]",
  "  exit",
  "fi",
  "if [[ \"${1:-}\" == inspect ]]; then",
  "  if [[ \"$*\" == *Health.Status* ]]; then printf '%s\\n' healthy; fi",
  "  if [[ \"$*\" == *NetworkSettings.Ports* ]]; then printf '%s\\n' 7888; fi",
  "  exit 0",
  "fi",
  "exit 0",
  "",
].join("\n"));
chmodSync(docker, 0o755);

const ss = join(fakeBin, "ss");
writeFileSync(ss, "#!/usr/bin/env bash\nexit 0\n");
chmodSync(ss, 0o755);

try {
  const fresh = run("fresh", 7890);
  assert(fresh.output.trim() === "7890", "fresh ARES store did not return requested port");
  assert(fresh.error.includes("container='ares-work-demo'"), "fresh store did not choose ARES container");
  assert(fresh.log.includes("fresh|ares-work-demo|ares-work-demo|ares/cognee-mcp|ares-cognee_cognee_net|compose"), "fresh compose environment is not fully ARES-native");

  const legacy = run("legacy", 7890);
  assert(legacy.output.trim() === "7888", "legacy running store did not return bound legacy port");
  assert(legacy.error.includes("already healthy on :7888"), "legacy running store was not reused");
  assert(legacy.log.includes("legacy|mishkan-work-demo|mishkan-work-demo|mishkan/cognee-mcp|mishkan-cognee_cognee_net|ps"), "legacy container compatibility environment not selected");

  const legacyNetwork = run("legacy-network", 7891);
  assert(legacyNetwork.output.trim() === "7891", "legacy-network store did not return requested port");
  assert(legacyNetwork.error.includes("container='ares-work-demo'"), "legacy-network scenario did not keep ARES container name");
  assert(legacyNetwork.log.includes("legacy-network|ares-work-demo|ares-work-demo|ares/cognee-mcp|mishkan-cognee_cognee_net|compose"), "legacy-network bridge compatibility not selected");

  console.log("check-work-store ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
