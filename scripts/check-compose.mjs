#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const srcDir = join(root, "payload", "mishkan", "cognee");
const tmpDir = `/tmp/ares-compose-check-${process.pid}`;

function run(args, opts = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: opts.cwd || root,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: "utf8",
  });
  return result;
}

function requireOk(result, args) {
  if (result.status !== 0) {
    process.stderr.write(`check-compose: command failed (${result.status}): ${args.join(" ")}\n`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  return result.stdout || "";
}

function assert(condition, message) {
  if (!condition) {
    process.stderr.write(`check-compose: ${message}\n`);
    process.exit(1);
  }
}

function render(files, env, profiles = []) {
  const args = ["docker", "compose"];
  for (const profile of profiles) args.push("--profile", profile);
  for (const file of files) args.push("-f", file);
  args.push("config");
  return requireOk(run(args, { cwd: tmpDir, env }), args);
}

function assertIncludes(text, values, label) {
  for (const value of values) {
    assert(text.includes(value), `${label} missing expected value: ${value}`);
  }
}

function assertExcludes(text, values, label) {
  for (const value of values) {
    assert(!text.includes(value), `${label} contains legacy value: ${value}`);
  }
}

const dockerVersion = run(["docker", "compose", "version"]);
if (dockerVersion.status !== 0) {
  console.warn("check-compose: docker compose not available; skipping static compose render");
  process.exit(0);
}

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });
cpSync(srcDir, tmpDir, { recursive: true });

try {
  if (existsSync(join(tmpDir, ".env.example"))) {
    writeFileSync(join(tmpDir, ".env"), readFileSync(join(tmpDir, ".env.example"), "utf8"));
  }
  if (existsSync(join(tmpDir, ".env.curated.example"))) {
    writeFileSync(join(tmpDir, ".env.curated"), readFileSync(join(tmpDir, ".env.curated.example"), "utf8"));
  }

  const commonEnv = {
    COGNEE_MCP_REF: "v1.1.0",
    OLLAMA_VERSION: "0.1.0",
    COGNEE_SRC: "/tmp/cognee",
    DB_NAME: "cognee_db",
    DB_USERNAME: "cognee",
    DB_PASSWORD: "test",
    GRAPH_DATABASE_USERNAME: "neo4j",
    GRAPH_DATABASE_PASSWORD: "test",
    DEFAULT_USER_EMAIL: "test@example.com",
    DEFAULT_USER_PASSWORD: "test",
    LLM_API_KEY: "test",
  };

  const shared = render([
    "docker-compose.yml",
    "docker-compose.hardening.yml",
    "docker-compose.selfhosted.yml",
    "docker-compose.curated.yml",
    "docker-compose.ui.yml",
    "docker-compose.curated-ui.yml",
  ], commonEnv, ["ui"]);

  assertIncludes(shared, [
    "ares-cognee",
    "ares-cognee-mcp",
    "ares-cognee-pg",
    "ares-ollama",
    "ares-curated-mcp",
    "ares-curated-neo4j",
    "ares/cognee-mcp",
    "ares-cognee-backend",
    "ares-cognee-frontend",
  ], "shared compose render");
  assertExcludes(shared, [
    "mishkan-cognee-",
    "mishkan-curated-",
    "mishkan/cognee-",
  ], "shared compose render");

  const work = render([
    "docker-compose.work.yml",
    "docker-compose.hardening.yml",
  ], {
    ...commonEnv,
    WORK_PROJECT: "demo",
    WORK_PORT: "7890",
    COGNEE_MCP_IMAGE: "ares/cognee-mcp",
    COGNEE_WORK_NETWORK: "ares-cognee_cognee_net",
  });

  assertIncludes(work, [
    "ares-work-demo",
    "ares-work-demo_work_data",
    "ares/cognee-mcp",
    "ares-cognee_cognee_net",
  ], "work-store compose render");
  assertExcludes(work, [
    "mishkan-work-",
    "mishkan/cognee-",
  ], "work-store compose render");

  console.log("check-compose ok");
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
