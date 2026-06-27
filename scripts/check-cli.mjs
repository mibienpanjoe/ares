#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;

function run(args, opts = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: opts.cwd || root,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const cmd = args.join(" ");
    process.stderr.write(`check: command failed (${result.status}): ${cmd}\n`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  return result.stdout || "";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runForOutput(args, opts = {}) {
  const command = args.map(shellQuote).join(" ");
  const result = spawnSync("/bin/bash", ["-lc", `${command} | cat`], {
    cwd: opts.cwd || root,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(`check: command failed (${result.status}): ${args.join(" ")}\n`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  return result.stdout || "";
}

function runExpectFailure(args, opts = {}) {
  const command = `set -o pipefail; ${args.map(shellQuote).join(" ")} 2>&1 | cat`;
  const result = spawnSync("/bin/bash", ["-lc", command], {
    cwd: opts.cwd || root,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: "utf8",
  });
  if (result.status === 0) {
    process.stderr.write(`check: command unexpectedly succeeded: ${args.join(" ")}\n`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(1);
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function assert(condition, message) {
  if (!condition) {
    process.stderr.write(`check: ${message}\n`);
    process.exit(1);
  }
}

function read(path) {
  assert(existsSync(path), `missing expected file: ${path}`);
  return readFileSync(path, "utf8");
}

function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function assertNoStaleRuntimeText(dir, label) {
  const stale = [
    "~/.claude/mishkan",
    "mishkan-harness",
    "mishkan knowledge",
    "mishkan model",
    "/mishkan-init",
    "mishkan-work-",
    "mishkan-cognee",
    "mishkan-curated",
    "`ares: ingest` still accepted as legacy",
    "ares-ingest.sh",
  ];
  for (const file of walkFiles(dir)) {
    if (!file.endsWith(".md") && !file.endsWith(".toml") && !file.endsWith(".json")) continue;
    const text = readFileSync(file, "utf8");
    for (const value of stale) {
      assert(!text.includes(value), `${label} stale runtime text in ${file}: ${value}`);
    }
  }
}

function frontmatterName(text) {
  const match = text.match(/^---\n[\s\S]*?\n---/);
  if (!match) return null;
  const name = match[0].match(/^name:\s*(.+)$/m);
  return name ? name[1].trim().replace(/^["']|["']$/g, "") : null;
}

function assertUniqueSkillNames(dir, label) {
  const seen = new Map();
  for (const file of walkFiles(dir).filter(path => path.endsWith("SKILL.md"))) {
    const text = readFileSync(file, "utf8");
    const name = frontmatterName(text);
    if (!name) continue;
    assert(name === basename(dirname(file)), `${label} skill name '${name}' does not match directory ${dirname(file)}`);
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1] || "";
    const description = frontmatter.match(/^description:\s*(.*)$/m)?.[1]?.trim();
    assert(description !== undefined && description !== "", `${label} skill description missing in ${file}`);
    if (!description.startsWith('"') && !description.startsWith("'") && !description.startsWith("|") && !description.startsWith(">")) {
      assert(!description.includes(": "), `${label} skill description is not portable YAML in ${file}`);
    }
    assert(!name.startsWith("mishkan-"), `${label} exposes legacy technical skill name '${name}' in ${file}`);
    assert(!seen.has(name), `${label} duplicate skill name '${name}' in ${seen.get(name)} and ${file}`);
    seen.set(name, file);
  }
  assert(!existsSync(join(dir, "mishkan-init", "SKILL.md")), `${label} installed legacy mishkan-init skill`);
  assert(!existsSync(join(dir, "mishkan-ingest", "SKILL.md")), `${label} installed legacy mishkan-ingest skill`);
  assert(existsSync(join(dir, "ares-ingest", "SKILL.md")), `${label} missing ares-ingest skill`);
}

function assertSymlink(path, expectedFragment, message) {
  let stat = null;
  try { stat = lstatSync(path); } catch {}
  assert(stat, `missing expected symlink: ${path}`);
  assert(stat.isSymbolicLink(), `${message}: not a symlink`);
  const target = readlinkSync(path);
  assert(target.includes(expectedFragment), `${message}: unexpected target ${target}`);
}

function cleanTmp(path) {
  if (!path.startsWith("/tmp/ares-")) {
    throw new Error(`refusing to clean non-ARES temp path: ${path}`);
  }
  rmSync(path, { recursive: true, force: true });
}

const projectDir = "/tmp/ares-project-check";
const wiringOnlyDir = "/tmp/ares-project-wiring-only-check";
const brownfieldDir = "/tmp/ares-project-brownfield-check";
const cogneeProjectDir = "/tmp/ares-project-cognee-check";
const defaultInstallHome = "/tmp/ares-check-home-default-install";
const claudeHome = "/tmp/ares-check-home-claude";
const codexHomeRoot = "/tmp/ares-check-home";
const opencodeHomeRoot = "/tmp/ares-check-home-opencode";
const cogneeInstallHome = "/tmp/ares-check-home-cognee";
const legacyHomeRoot = "/tmp/ares-check-home-legacy";
const legacyGuardHomeRoot = "/tmp/ares-check-home-legacy-guard";
const missingProjectDir = "/tmp/ares-missing-project-check";
const targetProjectDirs = Object.fromEntries(
  ["claude", "codex", "opencode"].map(target => [target, `/tmp/ares-project-${target}-check`]),
);
const targetWiringDirs = Object.fromEntries(
  ["claude", "codex", "opencode"].map(target => [target, `/tmp/ares-project-${target}-wiring-check`]),
);

for (const dir of [
  projectDir,
  wiringOnlyDir,
  brownfieldDir,
  cogneeProjectDir,
  defaultInstallHome,
  claudeHome,
  codexHomeRoot,
  opencodeHomeRoot,
  cogneeInstallHome,
  legacyHomeRoot,
  legacyGuardHomeRoot,
  missingProjectDir,
  ...Object.values(targetProjectDirs),
  ...Object.values(targetWiringDirs),
]) cleanTmp(dir);
mkdirSync(projectDir, { recursive: true });
mkdirSync(wiringOnlyDir, { recursive: true });
mkdirSync(cogneeProjectDir, { recursive: true });
for (const dir of [...Object.values(targetProjectDirs), ...Object.values(targetWiringDirs)]) {
  mkdirSync(dir, { recursive: true });
}
mkdirSync(join(brownfieldDir, "docs"), { recursive: true });
mkdirSync(join(brownfieldDir, ".claude"), { recursive: true });
mkdirSync(join(brownfieldDir, ".codex", "agents"), { recursive: true });
mkdirSync(join(brownfieldDir, ".opencode", "commands"), { recursive: true });
mkdirSync(join(claudeHome, ".local", "bin"), { recursive: true });

run([node, "bin/mishkan.js", "help"]);
run([node, "bin/ares.js", "help"]);
assert(runForOutput([node, "bin/mishkan.js", "help"]).includes("mishkan is a legacy alias; use ares"), "legacy mishkan help warning missing");
run([node, "bin/mishkan.js", "org", "show", "--json"]);
run([node, "bin/mishkan.js", "model", "show"]);
const aresModelShow = runForOutput([node, "bin/ares.js", "model", "show"]);
assert(aresModelShow.includes("ARES model-tier routing"), "ares model show heading not branded ARES");
assert(aresModelShow.includes("ares model set"), "ares model show missing ARES set command");
assert(!aresModelShow.includes("mishkan model set"), "ares model show leaks legacy model command");
run([node, "bin/ares.js", "status", "--target", "all"]);
run([node, "bin/ares.js", "runtime", "check", "--target", "all"]);

const defaultInstallEnv = {
  HOME: defaultInstallHome,
  ARES_HOME: join(defaultInstallHome, ".ares"),
  CODEX_HOME: join(defaultInstallHome, ".codex"),
  OPENCODE_CONFIG_DIR: join(defaultInstallHome, ".config", "opencode"),
  ARES_SKIP_OBSERVABILITY: "1",
};
run([node, "bin/ares.js", "install"], { env: defaultInstallEnv });
const defaultStatus = runForOutput([node, "bin/ares.js", "status"], { env: defaultInstallEnv });
assert(defaultStatus.includes("linked:"), "bare ares status did not default to Claude");
assert(existsSync(join(defaultInstallHome, ".claude", "CLAUDE.md")), "bare ares install did not default to Claude");
assert(!existsSync(join(defaultInstallHome, ".codex", "AGENTS.md")), "bare ares install unexpectedly installed Codex");
assert(!existsSync(join(defaultInstallHome, ".config", "opencode", "AGENTS.md")), "bare ares install unexpectedly installed OpenCode");

mkdirSync(join(legacyHomeRoot, ".claude", "mishkan", "config"), { recursive: true });
mkdirSync(join(legacyHomeRoot, ".ares", "config"), { recursive: true });
writeFileSync(join(legacyHomeRoot, ".claude", "mishkan", "config", "legacy-only.txt"), "legacy\n");
writeFileSync(join(legacyHomeRoot, ".ares", "config", "ares-only.txt"), "ares\n");
run([node, "bin/ares.js", "migrate", "legacy-mishkan"], {
  env: {
    HOME: legacyHomeRoot,
    ARES_HOME: join(legacyHomeRoot, ".ares"),
    MISHKAN_HOME: join(legacyHomeRoot, ".claude", "mishkan"),
  },
});
assert(read(join(legacyHomeRoot, ".ares", "config", "legacy-only.txt")).includes("legacy"), "legacy migration did not copy missing file");
assert(read(join(legacyHomeRoot, ".ares", "config", "ares-only.txt")).includes("ares"), "legacy migration overwrote existing ARES file");
assert(existsSync(join(legacyHomeRoot, ".claude", "mishkan", "config", "legacy-only.txt")), "legacy migration removed legacy runtime");

mkdirSync(join(legacyGuardHomeRoot, ".claude", "mishkan", "config"), { recursive: true });
writeFileSync(join(legacyGuardHomeRoot, ".claude", "mishkan", "config", "legacy-only.txt"), "legacy\n");
writeFileSync(join(legacyGuardHomeRoot, ".claude", "mishkan", ".install-stamp"), JSON.stringify({ version: "legacy", installedAt: "2026-01-01T00:00:00Z" }) + "\n");
const legacyOnlyStatus = runForOutput([node, "bin/mishkan.js", "status"], {
  env: {
    HOME: legacyGuardHomeRoot,
    ARES_HOME: join(legacyGuardHomeRoot, ".ares"),
    MISHKAN_HOME: join(legacyGuardHomeRoot, ".claude", "mishkan"),
  },
});
assert(legacyOnlyStatus.includes("runtime: ~/.claude/mishkan"), "legacy mishkan status did not detect a legacy-only install");
const guardedLegacyUninstall = runExpectFailure([node, "bin/ares.js", "uninstall", "--legacy-mishkan"], {
  env: {
    HOME: legacyGuardHomeRoot,
    ARES_HOME: join(legacyGuardHomeRoot, ".ares"),
    MISHKAN_HOME: join(legacyGuardHomeRoot, ".claude", "mishkan"),
  },
});
assert(guardedLegacyUninstall.includes("refusing to remove"), "legacy uninstall guard did not explain refusal");
assert(existsSync(join(legacyGuardHomeRoot, ".claude", "mishkan", "config", "legacy-only.txt")), "guarded legacy uninstall removed runtime without ARES_HOME");

run([node, "bin/ares.js", "uninstall", "--legacy-mishkan"], {
  env: {
    HOME: legacyHomeRoot,
    ARES_HOME: join(legacyHomeRoot, ".ares"),
    MISHKAN_HOME: join(legacyHomeRoot, ".claude", "mishkan"),
  },
});
assert(!existsSync(join(legacyHomeRoot, ".claude", "mishkan")), "legacy uninstall did not remove legacy runtime");
assert(existsSync(join(legacyHomeRoot, ".ares", "config", "legacy-only.txt")), "legacy uninstall removed ARES runtime");

run([node, "bin/ares.js", "project", "init", "--target", "all", "--dir", projectDir]);
run([node, "bin/ares.js", "project", "init", "--target", "all", "--dir", projectDir]);
run([node, "bin/ares.js", "project", "init", "--target", "codex", "--wiring-only", "--dir", projectDir]);
run([node, "bin/ares.js", "project", "init", "--target", "all", "--wiring-only", "--dir", wiringOnlyDir]);
assert((read(join(projectDir, "CLAUDE.md")).match(/ARES-HARNESS:BEGIN project-claude/g) || []).length === 1, "repeated project init duplicated Claude managed block");
assert((read(join(projectDir, "AGENTS.md")).match(/ARES-HARNESS:BEGIN project-codex/g) || []).length === 1, "repeated project init duplicated Codex managed block");
assert((read(join(projectDir, "AGENTS.md")).match(/ARES-HARNESS:BEGIN project-opencode/g) || []).length === 1, "repeated project init duplicated OpenCode managed block");

for (const target of ["claude", "codex", "opencode"]) {
  const fullDir = targetProjectDirs[target];
  const wiringDir = targetWiringDirs[target];
  run([node, "bin/ares.js", "project", "init", "--target", target, "--dir", fullDir], { env: defaultInstallEnv });
  run([node, "bin/ares.js", "project", "init", "--target", target, "--wiring-only", "--dir", wiringDir], { env: defaultInstallEnv });
  assert(existsSync(join(fullDir, "docs", "README.md")), `${target} full project init did not create docs`);
  assert(!existsSync(join(wiringDir, "docs")), `${target} wiring-only project init created docs`);

  if (target === "claude") {
    assert(read(join(fullDir, "CLAUDE.md")).includes("ARES-HARNESS:BEGIN project-claude"), "isolated Claude project guidance missing");
    assert(!existsSync(join(fullDir, ".mcp.json")), "isolated Claude native init wrote Cognee MCP config");
    assert(existsSync(join(fullDir, ".claude", "rules", "y4nn-standards.md")), "isolated Claude rules missing");
    assert(!existsSync(join(fullDir, "AGENTS.md")), "isolated Claude init wrote AGENTS.md");
  } else if (target === "codex") {
    assert(read(join(fullDir, "AGENTS.md")).includes("ARES-HARNESS:BEGIN project-codex"), "isolated Codex project guidance missing");
    assert(existsSync(join(fullDir, ".codex", "config.toml")), "isolated Codex MCP config missing");
    assert(existsSync(join(fullDir, ".codex", "agents", "nathan.toml")), "isolated Codex agent files missing");
    assert(!existsSync(join(fullDir, "CLAUDE.md")), "isolated Codex init wrote CLAUDE.md");
    assert(!existsSync(join(wiringDir, ".codex", "agents")), "Codex wiring-only created project agents");
  } else {
    assert(read(join(fullDir, "AGENTS.md")).includes("ARES-HARNESS:BEGIN project-opencode"), "isolated OpenCode project guidance missing");
    assert(existsSync(join(fullDir, "opencode.json")), "isolated OpenCode MCP config missing");
    assert(existsSync(join(fullDir, ".opencode", "commands", "ares-init.md")), "isolated OpenCode command files missing");
    assert(existsSync(join(fullDir, ".opencode", "agents", "nathan.md")), "isolated OpenCode agent files missing");
    assert(!existsSync(join(fullDir, "CLAUDE.md")), "isolated OpenCode init wrote CLAUDE.md");
    assert(!existsSync(join(wiringDir, ".opencode", "agents")), "OpenCode wiring-only created project agents");
    assert(!existsSync(join(wiringDir, ".opencode", "commands")), "OpenCode wiring-only created project commands");
  }
}
const projectRuntimeCheck = runForOutput([node, "bin/ares.js", "runtime", "check", "--target", "all", "--dir", projectDir]);
for (const expected of [
  "Project Claude CLAUDE.md",
  "Project Codex AGENTS.md",
  "Project Codex memory config",
  "Project OpenCode AGENTS.md",
  "Project OpenCode config",
  "Project OpenCode /ares-init command",
]) {
  assert(projectRuntimeCheck.includes(expected), `project runtime check missing: ${expected}`);
}
const missingProjectRuntimeCheck = runExpectFailure([node, "bin/ares.js", "runtime", "check", "--target", "codex", "--dir", missingProjectDir]);
assert(missingProjectRuntimeCheck.includes("project directory not found"), "runtime check missing-project error not reported");

writeFileSync(join(brownfieldDir, "AGENTS.md"), "# Existing AGENTS\n\nKeep this Codex guidance.\n");
writeFileSync(join(brownfieldDir, "CLAUDE.md"), "# Existing CLAUDE\n\nKeep this Claude guidance.\n");
writeFileSync(join(brownfieldDir, "docs", "README.md"), "# Existing Docs\n\nDo not replace.\n");
writeFileSync(join(brownfieldDir, ".mcp.json"), JSON.stringify({ mcpServers: { existing: { url: "http://127.0.0.1:9999/mcp" } } }, null, 2) + "\n");
writeFileSync(join(brownfieldDir, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm -rf *)"] } }, null, 2) + "\n");
writeFileSync(join(brownfieldDir, ".codex", "agents", "nathan.toml"), "name = \"nathan\"\ndescription = \"custom\"\ndeveloper_instructions = \"keep custom\"\n");
writeFileSync(join(brownfieldDir, ".opencode", "commands", "ares-init.md"), "---\ndescription: custom\n---\n\nKeep custom OpenCode command.\n");
run([node, "bin/ares.js", "project", "init", "--target", "all", "--dir", brownfieldDir]);

assert(read(join(projectDir, "AGENTS.md")).includes("ARES-HARNESS:BEGIN project-codex"), "project Codex AGENTS block missing");
assert(read(join(projectDir, "AGENTS.md")).includes("ARES-HARNESS:BEGIN project-opencode"), "project OpenCode AGENTS block missing");
assert(read(join(projectDir, "CLAUDE.md")).includes("ARES-HARNESS:BEGIN project-claude"), "project Claude CLAUDE block missing");
assert(!existsSync(join(projectDir, ".mcp.json")), "project native mode wrote Claude Cognee MCP config");
assert(read(join(projectDir, ".codex", "config.toml")).includes("ARES native-memory project mode"), "project Codex native memory config missing");
assert(!read(join(projectDir, ".codex", "config.toml")).includes("[mcp_servers.cognee_memory]"), "project Codex native mode wrote Cognee MCP config");
assert(read(join(projectDir, ".codex", "hooks.json")).includes("session-start-skill-index.sh"), "project Codex SessionStart hook missing");
assert(!read(join(projectDir, ".codex", "hooks.json")).includes("pre-tool-security.sh"), "project Codex duplicated global tool hooks");
assert(!existsSync(join(projectDir, ".codex", "prompts")), "project init created removed Codex custom prompts");
assertNoStaleRuntimeText(join(projectDir, ".codex", "agents"), "project Codex agents");
assert(!existsSync(join(projectDir, ".agents", "skills")), "project init duplicated shared skills under .agents/skills");
const projectOpenCode = JSON.parse(read(join(projectDir, "opencode.json")));
assert(!projectOpenCode.mcp?.cognee_memory, "project OpenCode native mode wrote Cognee MCP config");
assert(existsSync(join(projectDir, ".opencode", "commands", "ares-init.md")), "project OpenCode /ares-init command missing");
assert(existsSync(join(projectDir, ".opencode", "agents", "nathan.md")), "project OpenCode nathan agent missing");
assertNoStaleRuntimeText(join(projectDir, ".opencode", "agents"), "project OpenCode agents");
assert(!existsSync(join(projectDir, ".opencode", "skills")), "project init duplicated shared skills under .opencode/skills");

assert(read(join(wiringOnlyDir, "AGENTS.md")).includes("ARES-HARNESS:BEGIN project-codex"), "wiring-only Codex AGENTS block missing");
assert(read(join(wiringOnlyDir, "CLAUDE.md")).includes("ARES-HARNESS:BEGIN project-claude"), "wiring-only Claude CLAUDE block missing");
assert(read(join(wiringOnlyDir, ".codex", "config.toml")).includes("ARES native-memory project mode"), "wiring-only Codex native memory config missing");
assert(!read(join(wiringOnlyDir, ".codex", "config.toml")).includes("[mcp_servers.cognee_memory]"), "wiring-only Codex native mode wrote Cognee MCP config");
assert(!read(join(wiringOnlyDir, "opencode.json")).includes("cognee_memory"), "wiring-only OpenCode native mode wrote Cognee MCP config");
assert(!existsSync(join(wiringOnlyDir, "docs")), "wiring-only unexpectedly created docs/");
assert(!existsSync(join(wiringOnlyDir, ".agents", "skills")), "wiring-only unexpectedly created Codex skills");
assert(!existsSync(join(wiringOnlyDir, ".codex", "agents")), "wiring-only unexpectedly created Codex agents");
assert(!existsSync(join(wiringOnlyDir, ".codex", "prompts")), "wiring-only unexpectedly created Codex prompts");
assert(!existsSync(join(wiringOnlyDir, ".opencode", "agents")), "wiring-only unexpectedly created OpenCode agents");
assert(!existsSync(join(wiringOnlyDir, ".opencode", "commands")), "wiring-only unexpectedly created OpenCode commands");
assert(!existsSync(join(wiringOnlyDir, ".opencode", "skills")), "wiring-only unexpectedly created OpenCode skills");

assert(read(join(brownfieldDir, "AGENTS.md")).includes("Keep this Codex guidance."), "brownfield AGENTS user content not preserved");
assert(read(join(brownfieldDir, "AGENTS.md")).includes("ARES-HARNESS:BEGIN project-codex"), "brownfield Codex block missing");
assert(read(join(brownfieldDir, "CLAUDE.md")).includes("Keep this Claude guidance."), "brownfield CLAUDE user content not preserved");
assert(read(join(brownfieldDir, "CLAUDE.md")).includes("ARES-HARNESS:BEGIN project-claude"), "brownfield Claude block missing");
assert(read(join(brownfieldDir, "docs", "README.md")).includes("Do not replace."), "brownfield docs README overwritten");
assert(read(join(brownfieldDir, ".mcp.json")).includes("127.0.0.1:9999"), "brownfield Claude MCP overwritten");
assert(read(join(brownfieldDir, ".claude", "settings.json")).includes("Bash(rm -rf *)"), "brownfield Claude settings overwritten");
assert(read(join(brownfieldDir, ".codex", "agents", "nathan.toml")).includes("keep custom"), "brownfield Codex agent overwritten");
assert(read(join(brownfieldDir, ".opencode", "commands", "ares-init.md")).includes("Keep custom OpenCode command."), "brownfield OpenCode command overwritten");
assert(!read(join(brownfieldDir, "opencode.json")).includes("cognee_memory"), "brownfield OpenCode native mode wrote Cognee MCP config");

run([node, "bin/ares.js", "install", "--target", "claude"], {
  env: {
    HOME: claudeHome,
    ARES_HOME: join(claudeHome, ".ares"),
    ARES_SKIP_OBSERVABILITY: "1",
  },
});
run([node, "bin/ares.js", "install", "--target", "claude"], {
  env: {
    HOME: claudeHome,
    ARES_HOME: join(claudeHome, ".ares"),
    ARES_SKIP_OBSERVABILITY: "1",
  },
});
run([node, "bin/ares.js", "status", "--target", "claude"], {
  env: { HOME: claudeHome, ARES_HOME: join(claudeHome, ".ares") },
});
run([node, "bin/ares.js", "runtime", "check", "--target", "claude"], {
  env: { HOME: claudeHome, ARES_HOME: join(claudeHome, ".ares") },
});
assertSymlink(join(claudeHome, ".local", "bin", "ares"), "bin/ares.js", "local ares CLI alias");
assertSymlink(join(claudeHome, ".local", "bin", "mishkan"), "bin/mishkan.js", "local mishkan legacy CLI alias");
assertSymlink(join(claudeHome, ".claude", "commands", "ares-init.md"), ".ares/commands/ares-init.md", "Claude /ares-init command");
assertSymlink(join(claudeHome, ".claude", "commands", "mishkan-init.md"), ".ares/commands/mishkan-init.md", "Claude legacy /mishkan-init command");
const claudeSettings = JSON.parse(read(join(claudeHome, ".claude", "settings.json")));
const claudeManagedCommands = Object.values(claudeSettings.hooks || {}).flatMap(entries =>
  (entries || []).flatMap(entry => (entry.hooks || []).map(hook => hook.command || "")),
);
assert(claudeManagedCommands.filter(command => command.includes("pre-tool-security.sh")).length === 1, "repeated Claude install duplicated security hook");
assert(read(join(claudeHome, ".ares", "commands", "ares-init.md")).includes("`ares knowledge-stack up`"), "ARES Claude command body not adapted");
assert(read(join(claudeHome, ".ares", "commands", "mishkan-init.md")).includes("`mishkan knowledge-stack up`"), "legacy Claude command body not preserved");
const modelOverlay = read(join(claudeHome, ".ares", "config", "model-routing.local.yaml"));
assert(modelOverlay.includes("Preserved across `ares install`"), "model overlay still points at legacy install command");
assert(modelOverlay.includes("Managed by `ares model set/reset`"), "model overlay still points at legacy model command");
assert(!modelOverlay.includes("`mishkan install`"), "model overlay leaks legacy install command");

run([node, "bin/ares.js", "install", "--target", "codex"], {
  env: {
    HOME: codexHomeRoot,
    CODEX_HOME: join(codexHomeRoot, ".codex"),
    ARES_HOME: join(codexHomeRoot, ".ares"),
  },
});
run([node, "bin/ares.js", "install", "--target", "codex"], {
  env: {
    HOME: codexHomeRoot,
    CODEX_HOME: join(codexHomeRoot, ".codex"),
    ARES_HOME: join(codexHomeRoot, ".ares"),
  },
});
run([node, "bin/ares.js", "status", "--target", "codex"], {
  env: {
    HOME: codexHomeRoot,
    CODEX_HOME: join(codexHomeRoot, ".codex"),
    ARES_HOME: join(codexHomeRoot, ".ares"),
  },
});
run([node, "bin/ares.js", "runtime", "check", "--target", "codex"], {
  env: {
    HOME: codexHomeRoot,
    CODEX_HOME: join(codexHomeRoot, ".codex"),
    ARES_HOME: join(codexHomeRoot, ".ares"),
  },
});
assert(read(join(codexHomeRoot, ".codex", "AGENTS.md")).includes("ARES Harness For Codex"), "global Codex AGENTS missing");
assert(read(join(codexHomeRoot, ".codex", "config.toml")).includes("ARES native-memory mode"), "global Codex native memory config missing");
assert(!read(join(codexHomeRoot, ".codex", "config.toml")).includes("[mcp_servers.cognee_memory]"), "global Codex native mode wrote Cognee MCP config");
assert(read(join(codexHomeRoot, ".codex", "hooks.json")).includes("session-start-skill-index.sh"), "global Codex SessionStart hook missing");
assert(read(join(codexHomeRoot, ".codex", "hooks.json")).includes("pre-tool-security.sh"), "global Codex PreToolUse security hook missing");
assert(read(join(codexHomeRoot, ".codex", "hooks.json")).includes("pre-tool-trace.sh"), "global Codex PreToolUse trace hook missing");
assert(read(join(codexHomeRoot, ".codex", "hooks.json")).includes("post-tool-observe.sh"), "global Codex PostToolUse observability hook missing");
const codexHooks = JSON.parse(read(join(codexHomeRoot, ".codex", "hooks.json")));
const codexManagedCommands = Object.values(codexHooks.hooks || {}).flatMap(entries =>
  (entries || []).flatMap(entry => (entry.hooks || []).map(hook => hook.command || "")),
);
for (const script of ["session-start-skill-index.sh", "pre-tool-security.sh", "pre-tool-trace.sh", "post-tool-observe.sh"]) {
  assert(codexManagedCommands.filter(command => command.includes(script)).length === 1, `repeated Codex install duplicated ${script}`);
}
assert(!existsSync(join(codexHomeRoot, ".codex", "prompts")), "Codex install created removed custom prompts");
assert(existsSync(join(codexHomeRoot, ".agents", "skills", "ares-init", "SKILL.md")), "global Codex ares-init skill missing");
const codexSharedInit = read(join(codexHomeRoot, ".agents", "skills", "ares-init", "SKILL.md"));
assert(codexSharedInit.includes("`/ares-init`"), "shared ares-init skill missing Claude/OpenCode invocation");
assert(codexSharedInit.includes("`$ares-init`"), "shared ares-init skill missing Codex invocation");
assert(existsSync(join(codexHomeRoot, ".codex", "ares", "rules", "y4nn-standards.md")), "global Codex support rules missing");
assertNoStaleRuntimeText(join(codexHomeRoot, ".codex", "agents"), "global Codex agents");
assertNoStaleRuntimeText(join(codexHomeRoot, ".agents", "skills"), "global Codex skills");
assertUniqueSkillNames(join(codexHomeRoot, ".agents", "skills"), "global Codex skills");

run([node, "bin/ares.js", "install", "--target", "opencode"], {
  env: {
    HOME: opencodeHomeRoot,
    OPENCODE_CONFIG_DIR: join(opencodeHomeRoot, ".config", "opencode"),
    ARES_HOME: join(opencodeHomeRoot, ".ares"),
  },
});
run([node, "bin/ares.js", "install", "--target", "opencode"], {
  env: {
    HOME: opencodeHomeRoot,
    OPENCODE_CONFIG_DIR: join(opencodeHomeRoot, ".config", "opencode"),
    ARES_HOME: join(opencodeHomeRoot, ".ares"),
  },
});
run([node, "bin/ares.js", "status", "--target", "opencode"], {
  env: {
    HOME: opencodeHomeRoot,
    OPENCODE_CONFIG_DIR: join(opencodeHomeRoot, ".config", "opencode"),
    ARES_HOME: join(opencodeHomeRoot, ".ares"),
  },
});
run([node, "bin/ares.js", "runtime", "check", "--target", "opencode"], {
  env: {
    HOME: opencodeHomeRoot,
    OPENCODE_CONFIG_DIR: join(opencodeHomeRoot, ".config", "opencode"),
    ARES_HOME: join(opencodeHomeRoot, ".ares"),
  },
});
const opencodeDir = join(opencodeHomeRoot, ".config", "opencode");
assert(read(join(opencodeDir, "AGENTS.md")).includes("ARES Harness For OpenCode"), "global OpenCode AGENTS missing");
assert(existsSync(join(opencodeDir, "commands", "ares-init.md")), "global OpenCode /ares-init command missing");
const opencodeSharedSkills = join(opencodeHomeRoot, ".agents", "skills");
assert(existsSync(join(opencodeSharedSkills, "ares-init", "SKILL.md")), "global OpenCode shared ares-init skill missing");
assert(!existsSync(join(opencodeDir, "skills", "ares-init", "SKILL.md")), "global OpenCode duplicate ares-init skill was not removed");
assert(existsSync(join(opencodeDir, "agents", "nathan.md")), "global OpenCode nathan agent missing");
assert(existsSync(join(opencodeDir, "ares", "rules", "y4nn-standards.md")), "global OpenCode support rules missing");
const opencodeSessionPlugin = read(join(opencodeDir, "plugins", "ares-session.js"));
assert(opencodeSessionPlugin.includes('event?.type !== "session.created"'), "global OpenCode session.created plugin missing");
assert(opencodeSessionPlugin.includes("session-start-skill-index.sh"), "global OpenCode plugin does not call safe skill-index hook");
run([node, "--check", join(opencodeDir, "plugins", "ares-session.js")]);
const pluginModuleUrl = `data:text/javascript;base64,${Buffer.from(opencodeSessionPlugin).toString("base64")}`;
const { AresSessionPlugin } = await import(pluginModuleUrl);
assert(typeof AresSessionPlugin === "function", "global OpenCode plugin export missing");
const shellCalls = [];
const fakeShell = (strings, ...values) => {
  shellCalls.push({ strings: [...strings], values });
  return Promise.resolve({ exitCode: 0 });
};
const previousAresHome = process.env.ARES_HOME;
process.env.ARES_HOME = join(opencodeHomeRoot, ".ares");
try {
  const pluginHooks = await AresSessionPlugin({ $: fakeShell });
  assert(typeof pluginHooks?.event === "function", "global OpenCode plugin event hook missing");
  await pluginHooks.event({ event: { type: "message.updated" } });
  assert(shellCalls.length === 0, "global OpenCode plugin ran for an unrelated event");
  await pluginHooks.event({ event: { type: "session.created" } });
  assert(shellCalls.length === 1, "global OpenCode plugin did not run once for session.created");
  assert(shellCalls[0].strings.join("").includes("bash "), "global OpenCode plugin did not invoke bash");
  assert(shellCalls[0].values[0] === join(opencodeHomeRoot, ".ares", "hooks", "session-start-skill-index.sh"), "global OpenCode plugin invoked the wrong hook path");
} finally {
  if (previousAresHome === undefined) delete process.env.ARES_HOME;
  else process.env.ARES_HOME = previousAresHome;
}
const opencodeToolPluginPath = join(opencodeDir, "plugins", "ares-tool-hooks.js");
const opencodeToolPlugin = read(opencodeToolPluginPath);
assert(opencodeToolPlugin.includes('"tool.execute.before"'), "global OpenCode before-tool hook missing");
assert(opencodeToolPlugin.includes('"tool.execute.after"'), "global OpenCode after-tool hook missing");
assert(opencodeToolPlugin.includes("pre-tool-security.sh"), "global OpenCode security adapter missing");
assert(opencodeToolPlugin.includes("post-tool-observe.sh"), "global OpenCode observability adapter missing");
run([node, "--check", opencodeToolPluginPath]);
const { AresToolHooksPlugin } = await import(`${pathToFileURL(opencodeToolPluginPath).href}?check=${Date.now()}`);
assert(typeof AresToolHooksPlugin === "function", "global OpenCode tool plugin export missing");
const toolHooks = await AresToolHooksPlugin({ directory: projectDir });
assert(typeof toolHooks?.["tool.execute.before"] === "function", "global OpenCode before-tool callback missing");
assert(typeof toolHooks?.["tool.execute.after"] === "function", "global OpenCode after-tool callback missing");
const openCodeSession = "opencode-plugin-check";
const safeToolInput = {
  tool: "write",
  sessionID: openCodeSession,
  callID: "write-safe-1",
};
const safeToolArgs = {
  filePath: "src/opencode-safe.js",
  content: "const apiKey = process.env.API_KEY;\n",
};
await toolHooks["tool.execute.before"](safeToolInput, { args: safeToolArgs });
let blocked = false;
try {
  await toolHooks["tool.execute.before"](
    { tool: "apply_patch", sessionID: openCodeSession, callID: "patch-blocked-1" },
    { args: { patchText: '*** Begin Patch\n*** Add File: src/leak.js\n+const apiKey = "super-secret-token";\n*** End Patch' } },
  );
} catch (error) {
  blocked = String(error?.message || error).includes("hardcoded secret literal");
}
assert(blocked, "global OpenCode security plugin did not block a hardcoded secret patch");
await toolHooks["tool.execute.after"](
  { ...safeToolInput, args: safeToolArgs },
  { title: "Wrote file", output: "Done", metadata: {} },
);
const openCodeEvents = read(join(opencodeHomeRoot, ".ares", "logs", `${openCodeSession}.jsonl`))
  .trim()
  .split("\n")
  .map(line => JSON.parse(line));
assert(openCodeEvents.some(event => event.type === "tool_call" && event.tool === "Write"), "global OpenCode plugin did not emit tool_call");
assert(openCodeEvents.some(event => event.type === "file_change" && event.payload?.path === "src/opencode-safe.js"), "global OpenCode plugin did not emit file_change");
assertNoStaleRuntimeText(join(opencodeDir, "agents"), "global OpenCode agents");
assertNoStaleRuntimeText(opencodeSharedSkills, "global OpenCode shared skills");
assertUniqueSkillNames(opencodeSharedSkills, "global OpenCode shared skills");
const opencodeConfig = JSON.parse(read(join(opencodeDir, "opencode.json")));
assert(!opencodeConfig.mcp?.cognee_memory, "global OpenCode native mode wrote Cognee MCP config");

const cogneeInstallEnv = {
  HOME: cogneeInstallHome,
  CODEX_HOME: join(cogneeInstallHome, ".codex"),
  OPENCODE_CONFIG_DIR: join(cogneeInstallHome, ".config", "opencode"),
  ARES_HOME: join(cogneeInstallHome, ".ares"),
  ARES_SKIP_OBSERVABILITY: "1",
};
run([node, "bin/ares.js", "install", "--target", "all", "--memory", "cognee"], { env: cogneeInstallEnv });
assert(read(join(cogneeInstallHome, ".codex", "config.toml")).includes("[mcp_servers.cognee_memory]"), "global Codex Cognee memory config missing");
const cogneeOpenCodeConfig = JSON.parse(read(join(cogneeInstallHome, ".config", "opencode", "opencode.json")));
assert(cogneeOpenCodeConfig.mcp?.cognee_memory?.url === "http://127.0.0.1:7777/mcp", "global OpenCode Cognee MCP missing");

run([node, "bin/ares.js", "project", "init", "--target", "all", "--memory", "cognee", "--dir", cogneeProjectDir], { env: cogneeInstallEnv });
assert(read(join(cogneeProjectDir, ".mcp.json")).includes("cognee-memory"), "project Claude Cognee MCP config missing");
assert(read(join(cogneeProjectDir, ".codex", "config.toml")).includes("[mcp_servers.cognee_memory]"), "project Codex Cognee MCP config missing");
const cogneeProjectOpenCode = JSON.parse(read(join(cogneeProjectDir, "opencode.json")));
assert(cogneeProjectOpenCode.mcp?.cognee_memory?.url === "http://127.0.0.1:7777/mcp", "project OpenCode Cognee MCP missing");

console.log("check:cli ok");
