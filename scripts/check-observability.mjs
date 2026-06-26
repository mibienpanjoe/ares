#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const testPath = "payload/mishkan/observability/watchd/tests/test_state.py";

function findPython() {
  for (const bin of ["python3", "python"]) {
    const result = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return bin;
  }
  return null;
}

function run(args) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: root,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
    },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(`check-observability: command failed (${result.status}): ${args.join(" ")}\n`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  return result.stdout || "";
}

if (!existsSync(resolve(root, testPath))) {
  process.stderr.write(`check-observability: missing ${testPath}\n`);
  process.exit(1);
}

const python = findPython();
if (!python) {
  console.warn("check-observability: python not found; skipping watchd tests");
  process.exit(0);
}

run([python, "-B", testPath]);
console.log("check-observability ok");
