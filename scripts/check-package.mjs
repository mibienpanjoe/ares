#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const tmp = `/tmp/ares-package-check-${process.pid}`;
const packDir = join(tmp, "pack");
const prefix = join(tmp, "prefix");
const home = join(tmp, "home");
const project = join(tmp, "project");
const cache = process.env.ARES_NPM_CACHE || join(tmp, "npm-cache");

function fail(message, result = null) {
  process.stderr.write(`check-package: ${message}\n`);
  if (result?.stdout) process.stderr.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
  process.exit(1);
}

function run(args, opts = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: opts.cwd || root,
    env: {
      ...process.env,
      npm_config_cache: cache,
      npm_config_dry_run: "false",
      ...(opts.env || {}),
    },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 || (result.error && !result.stdout && !result.stderr)) {
    fail(`command failed (${result.status}): ${args.join(" ")}`, result);
  }
  return result.stdout || "";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runShell(args, opts = {}) {
  const command = `set -o pipefail; ${args.map(shellQuote).join(" ")} | cat`;
  return run(["/bin/bash", "-lc", command], opts);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(packDir, { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });

try {
  const packedRaw = runShell(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", packDir]);
  let packed;
  try {
    packed = JSON.parse(packedRaw)?.[0];
  } catch {
    fail("npm pack returned invalid JSON", { stdout: packedRaw });
  }
  assert(packed?.filename, "npm pack did not report a tarball filename");
  const tarball = join(packDir, packed.filename);
  assert(existsSync(tarball), `tarball missing after npm pack: ${tarball}`);

  runShell(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline", "--prefix", prefix, tarball]);
  const binDir = join(prefix, "node_modules", ".bin");
  const ares = join(binDir, "ares-harness");
  const legacy = join(binDir, "mishkan");
  assert(existsSync(ares), "packed ares-harness bin link missing");
  assert(existsSync(legacy), "packed legacy mishkan bin link missing");

  const runtimeEnv = {
    HOME: home,
    ARES_HOME: join(home, ".ares"),
    CODEX_HOME: join(home, ".codex"),
    OPENCODE_CONFIG_DIR: join(home, ".config", "opencode"),
    ARES_SKIP_OBSERVABILITY: "1",
  };
  const help = runShell([ares, "help"], { env: runtimeEnv });
  assert(help.includes("ARES harness"), "packed ARES help did not run");
  const legacyHelp = runShell([legacy, "help"], { env: runtimeEnv });
  assert(legacyHelp.includes("mishkan is a legacy alias; use ares"), "packed legacy bin warning missing");

  runShell([ares, "install", "--target", "all"], { env: runtimeEnv });
  runShell([ares, "runtime", "check", "--target", "all"], { env: runtimeEnv });

  assert(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8").includes("MISHKAN"), "packed Claude guidance install missing");
  assert(existsSync(join(home, ".claude", "commands", "ares-init.md")), "packed Claude /ares-init command missing");
  assert(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8").includes("ARES Harness For Codex"), "packed Codex AGENTS install missing");
  assert(!readFileSync(join(home, ".codex", "config.toml"), "utf8").includes("[mcp_servers.cognee_memory]"), "packed default install wrote Codex Cognee MCP");
  assert(existsSync(join(home, ".agents", "skills", "ares-init", "SKILL.md")), "packed Codex ares-init skill missing");
  assert(!existsSync(join(home, ".codex", "prompts")), "packed Codex install created removed custom prompts");
  assert(existsSync(join(home, ".agents", "skills", "ares-ingest", "SKILL.md")), "packed Codex ares-ingest skill missing");
  assert(!existsSync(join(home, ".agents", "skills", "mishkan-init")), "packed Codex install leaked mishkan-init skill");
  assert(readFileSync(join(home, ".config", "opencode", "AGENTS.md"), "utf8").includes("ARES Harness For OpenCode"), "packed OpenCode AGENTS install missing");
  assert(existsSync(join(home, ".config", "opencode", "commands", "ares-init.md")), "packed OpenCode /ares-init command missing");
  assert(!existsSync(join(home, ".config", "opencode", "skills", "ares-init", "SKILL.md")), "packed OpenCode install duplicated shared ares-init skill");
  assert(readFileSync(join(home, ".config", "opencode", "plugins", "ares-session.js"), "utf8").includes("session.created"), "packed OpenCode session plugin missing");
  assert(readFileSync(join(home, ".config", "opencode", "plugins", "ares-tool-hooks.js"), "utf8").includes("tool.execute.before"), "packed OpenCode tool plugin missing");

  runShell([ares, "project", "init", "--target", "all", "--dir", project], { env: runtimeEnv });
  runShell([ares, "runtime", "check", "--target", "all", "--dir", project], { env: runtimeEnv });
  assert(existsSync(join(project, "CLAUDE.md")), "packed project init Claude guidance missing");
  assert(!existsSync(join(project, ".mcp.json")), "packed default project init wrote Claude Cognee MCP");
  assert(existsSync(join(project, ".codex", "config.toml")), "packed project init Codex config missing");
  assert(!readFileSync(join(project, ".codex", "config.toml"), "utf8").includes("[mcp_servers.cognee_memory]"), "packed default project init wrote Codex Cognee MCP");
  assert(!existsSync(join(project, ".codex", "prompts")), "packed project init created removed Codex custom prompts");
  assert(existsSync(join(project, ".opencode", "commands", "ares-init.md")), "packed project init OpenCode command missing");
  assert(!existsSync(join(project, ".agents", "skills")), "packed project init duplicated shared Codex skills");
  assert(!existsSync(join(project, ".opencode", "skills")), "packed project init duplicated shared OpenCode skills");

  console.log("check-package ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
