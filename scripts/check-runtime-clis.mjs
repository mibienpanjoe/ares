#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const tmp = `/tmp/ares-runtime-cli-check-${process.pid}-${randomUUID()}`;
const home = join(tmp, "home");
const project = join(tmp, "project");
const opencodeRuntime = join(tmp, "opencode-runtime");

function fail(message, result = null) {
  process.stderr.write(`check-runtime-clis: ${message}\n`);
  if (result?.stdout) process.stderr.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
  process.exit(1);
}

function findExecutable(name) {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (spawnSync("test", ["-x", candidate]).status === 0) return candidate;
  }
  return null;
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd || root,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
  });
  if (result.status !== 0 || (result.status === null && result.error)) {
    fail(`command failed (${result.status}): ${command} ${args.join(" ")}`, result);
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function assertIncludes(output, expected, label) {
  if (!output.includes(expected)) fail(`${label} missing expected text: ${expected} (output: ${output.length} bytes)`);
}

function runToFile(command, args, outputPath, opts = {}) {
  const fd = openSync(outputPath, "w");
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: opts.cwd || root,
      env: { ...process.env, ...(opts.env || {}) },
      encoding: "utf8",
      stdio: ["ignore", fd, "pipe"],
      maxBuffer: 5 * 1024 * 1024,
    });
  } finally {
    closeSync(fd);
  }
  if (result.status !== 0 || (result.status === null && result.error)) {
    fail(`command failed (${result.status}): ${command} ${args.join(" ")}`, result);
  }
  return readFileSync(outputPath, "utf8");
}

function parseJson(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    fail(`${label} did not return valid JSON (${output.length} bytes)`);
  }
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(opencodeRuntime, { recursive: true });

try {
  const runtimeEnv = {
    HOME: home,
    ARES_HOME: join(home, ".ares"),
    CODEX_HOME: join(home, ".codex"),
    OPENCODE_CONFIG_DIR: join(home, ".config", "opencode"),
    ARES_SKIP_OBSERVABILITY: "1",
  };
  run(node, ["bin/ares.js", "install", "--target", "all", "--memory", "cognee"], { env: runtimeEnv });
  run(node, ["bin/ares.js", "project", "init", "--target", "all", "--memory", "cognee", "--dir", project], { env: runtimeEnv });
  const runtimeSkills = join(home, ".ares", "skills");
  const portableSkills = join(home, ".agents", "skills");
  for (const entry of readdirSync(portableSkills, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const portable = join(portableSkills, entry.name, "SKILL.md");
    if (!existsSync(portable)) continue;
    const runtime = join(runtimeSkills, entry.name, "SKILL.md");
    if (!existsSync(runtime) || readFileSync(runtime, "utf8") !== readFileSync(portable, "utf8")) {
      fail(`portable skill differs from Claude runtime copy: ${entry.name}`);
    }
  }
  if (existsSync(join(runtimeSkills, "mishkan-init")) || existsSync(join(portableSkills, "mishkan-init"))) {
    fail("legacy mishkan-init leaked into runtime-discoverable skills");
  }

  const checked = [];
  const claude = findExecutable("claude");
  if (claude) {
    const output = run(claude, ["mcp", "list"], { cwd: project, env: runtimeEnv });
    assertIncludes(output, "cognee-memory", "Claude MCP loader");
    assertIncludes(output, "cognee-curated", "Claude MCP loader");
    checked.push("claude");
  }

  const codex = findExecutable("codex");
  if (codex) {
    const features = run(codex, ["features", "list"], { cwd: project, env: runtimeEnv });
    if (!features.split("\n").some(line => /^hooks\s+stable\s+true\s*$/.test(line.trim()))) {
      fail("Codex CLI does not report stable enabled hook support");
    }
    const mcp = run(codex, ["mcp", "list"], { cwd: project, env: runtimeEnv });
    assertIncludes(mcp, "cognee_memory", "Codex MCP loader");
    assertIncludes(mcp, "cognee_curated", "Codex MCP loader");
    const prompt = run(codex, ["debug", "prompt-input", "ARES runtime probe"], { cwd: project, env: runtimeEnv });
    assertIncludes(prompt, "ARES Harness For Codex", "Codex instruction loader");
    assertIncludes(prompt, "ARES-HARNESS:BEGIN project-codex", "Codex project instruction loader");
    assertIncludes(prompt, "ares-init", "Codex skill loader");
    assertIncludes(prompt, "nathan", "Codex custom-agent loader");
    checked.push("codex");
  }

  const opencode = findExecutable("opencode");
  if (opencode) {
    const modelsPath = join(opencodeRuntime, "models.json");
    writeFileSync(modelsPath, "{}\n");
    const opencodeEnv = {
      ...runtimeEnv,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(opencodeRuntime, "data"),
      XDG_CACHE_HOME: join(opencodeRuntime, "cache"),
      XDG_STATE_HOME: join(opencodeRuntime, "state"),
      OPENCODE_DB: ":memory:",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_MODELS_PATH: modelsPath,
    };
    const config = parseJson(
      runToFile(opencode, ["--pure", "debug", "config"], join(opencodeRuntime, "config.json"), { cwd: project, env: opencodeEnv }),
      "OpenCode config loader",
    );
    if (!config.mcp?.cognee_memory) fail("OpenCode config loader missing cognee_memory");
    if (!config.agent?.nathan) fail("OpenCode agent loader missing nathan");
    if (config.agent.nathan.mode !== "subagent" || !String(config.agent.nathan.prompt || "").includes("Nathan")) {
      fail("OpenCode agent loader returned an unexpected nathan definition");
    }
    if (!config.command?.["ares-init"]) fail("OpenCode command loader missing ares-init");
    if (!String(config.command["ares-init"].template || "").includes("Sequence before implementation: no code is written during init")) {
      fail("OpenCode /ares-init command loader returned an unexpected template");
    }
    const skills = parseJson(
      runToFile(opencode, ["--pure", "debug", "skill"], join(opencodeRuntime, "skills.json"), { cwd: project, env: opencodeEnv }),
      "OpenCode skill loader",
    );
    const skillNames = new Set(skills.map(skill => skill.name));
    if (!skillNames.has("ares-init")) fail("OpenCode skill loader missing ares-init");
    if (!skillNames.has("ares-ingest")) fail("OpenCode skill loader missing ares-ingest");
    if ([...skillNames].some(name => name.startsWith("mishkan-"))) {
      fail("OpenCode skill loader exposed a legacy mishkan-* technical skill");
    }
    const aresInit = skills.find(skill => skill.name === "ares-init");
    const allowedSkillRoots = [join(home, ".agents", "skills"), join(home, ".claude", "skills")];
    if (!allowedSkillRoots.some(skillRoot => aresInit.location.startsWith(skillRoot))) {
      fail(`OpenCode loaded ares-init outside the shared skill tree: ${aresInit.location}`);
    }
    if (!aresInit.content.includes("/ares-init") || !aresInit.content.includes("$ares-init")) {
      fail("OpenCode loaded a non-portable ares-init skill");
    }
    checked.push("opencode");
  }

  console.log(`check-runtime-clis ok (${checked.length ? checked.join(", ") : "no supported CLI installed; skipped"})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
