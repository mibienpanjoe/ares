#!/usr/bin/env node
// ARES installer — dependency-free (Node >=18, built-ins only).
// Commands: install | uninstall | status | observability
//
// Portability by design: every path is resolved from os.homedir() at runtime.
// No machine-specific paths are baked in. Idempotent: re-running install updates
// in place. Never clobbers user-edited files (CLAUDE.md, rules, real agents).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
         copyFileSync, lstatSync, readlinkSync, symlinkSync, rmSync, statSync,
         chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const HOME = homedir();
const BRAND = "ares";
const LEGACY_BRAND = "mishkan";
const PACKAGE_NAME = "ares-harness";
const LEGACY_PACKAGE_NAME = "mishkan-harness";
const CLAUDE = join(HOME, ".claude");
const ARES_HOME = process.env.ARES_HOME || join(HOME, ".ares");
const LEGACY_HOME = process.env.MISHKAN_HOME || join(CLAUDE, LEGACY_BRAND);
const CODEX_HOME = process.env.CODEX_HOME || join(HOME, ".codex");
const OPENCODE_HOME = process.env.OPENCODE_CONFIG_DIR || join(HOME, ".config", "opencode");
const CORE_MANIFEST_PATH = join(PKG, "payload", "core", "manifest.json");
const CORE_MANIFEST = JSON.parse(readFileSync(CORE_MANIFEST_PATH, "utf8"));
const CORE_PAYLOAD = resolve(dirname(CORE_MANIFEST_PATH), CORE_MANIFEST.sourceRoot);
const TARGETS_ROOT = join(PKG, "payload", "targets");
const TARGET_INDEX = JSON.parse(readFileSync(join(TARGETS_ROOT, "index.json"), "utf8"));
const TARGETS = TARGET_INDEX.targets;
const TARGET_DEFINITIONS = Object.fromEntries(TARGETS.map(target => [
  target,
  JSON.parse(readFileSync(join(TARGETS_ROOT, target, "manifest.json"), "utf8")),
]));
const RUNTIME_HOME = runtimeHome();
const STAMP = join(RUNTIME_HOME, ".install-stamp");

function runtimeHome() {
  if (existsSync(ARES_HOME)) return ARES_HOME;
  if (existsSync(LEGACY_HOME)) return LEGACY_HOME;
  return ARES_HOME;
}
function legacyHome() { return LEGACY_HOME; }
function targetHome(target) {
  return { claude: CLAUDE, codex: CODEX_HOME, opencode: OPENCODE_HOME }[target] || runtimeHome();
}

function invokedCommand() {
  const invoked = basename(process.argv[1] || "");
  if (invoked === BRAND || invoked === `${BRAND}.js`) return BRAND;
  if (invoked === PACKAGE_NAME) return BRAND;
  if (invoked === LEGACY_BRAND || invoked === `${LEGACY_BRAND}.js`) return LEGACY_BRAND;
  if (invoked === LEGACY_PACKAGE_NAME) return LEGACY_BRAND;
  return BRAND;
}

function displayCommand() { return invokedCommand(); }
function isLegacyInvocation() { return displayCommand() === LEGACY_BRAND; }
function legacyWarning() { return `${LEGACY_BRAND} is a legacy alias; use ${BRAND}`; }

const TARGET_SET = new Set([...TARGETS, "all"]);

function parseTargetOption(argv, fallback = "claude") {
  let target = fallback;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") {
      target = argv[i + 1] || "";
      i++;
    } else if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
    }
  }
  if (!TARGET_SET.has(target)) {
    console.error(c.red(`invalid target '${target || "(empty)"}' — valid: ${[...TARGET_SET].join(", ")}`));
    process.exit(2);
  }
  return target;
}

function optionValue(argv, name, fallback = null) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === name) return argv[i + 1] ?? fallback;
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return fallback;
}

function expandTargets(target) {
  return target === "all" ? TARGETS : [target];
}

// ─── output ────────────────────────────────────────────────────────────────

const NO_COLOR = process.env.NO_COLOR || !process.stdout.isTTY;
const c = NO_COLOR
  ? { dim: s => s, bold: s => s, cyan: s => s, green: s => s, yellow: s => s, red: s => s }
  : {
      dim:    s => `\x1b[2m${s}\x1b[0m`,
      bold:   s => `\x1b[1m${s}\x1b[0m`,
      cyan:   s => `\x1b[36m${s}\x1b[0m`,
      green:  s => `\x1b[32m${s}\x1b[0m`,
      yellow: s => `\x1b[33m${s}\x1b[0m`,
      red:    s => `\x1b[31m${s}\x1b[0m`,
    };

const log = (...a) => console.log(`${displayCommand()}:`, ...a);
const warn = (...a) => console.warn(`${displayCommand()}: ${c.yellow("WARN")}`, ...a);

// Print a phase header with a one-line "why" subtitle. Helps the engineer
// see what each step does and why, instead of an unstructured wall of logs.
function phase(n, total, title, why) {
  console.log();
  console.log(c.bold(c.cyan(`[${n}/${total}] ${title}`)));
  if (why) console.log(c.dim(`        ${why}`));
}

function ensureDir(d) { mkdirSync(d, { recursive: true }); }
function shellQuote(s) { return `'${String(s).replaceAll("'", "'\\''")}'`; }

function copyDir(src, dst, skip = new Set()) {
  ensureDir(dst);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const s = join(src, entry.name), d = join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d, skip);
    else if (entry.isFile()) copyFileSync(s, d);
  }
}

function writeManagedBlock(filePath, begin, end, body) {
  ensureDir(dirname(filePath));
  const block = `${begin}\n${body.trimEnd()}\n${end}\n`;
  if (!existsSync(filePath)) {
    writeFileSync(filePath, block);
    return;
  }
  const current = readFileSync(filePath, "utf8");
  const start = current.indexOf(begin);
  const finish = start >= 0 ? current.indexOf(end, start) : -1;
  if (start >= 0 && finish >= 0) {
    const after = finish + end.length;
    writeFileSync(filePath, current.slice(0, start) + block + current.slice(after).replace(/^\n/, ""));
    return;
  }
  const spacer = current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(filePath, current + spacer + block);
}

function pathExists(p) {
  return existsSync(p) || isSymlink(p);
}

function writeFileIfAbsent(filePath, content) {
  ensureDir(dirname(filePath));
  if (pathExists(filePath)) return false;
  writeFileSync(filePath, content);
  return true;
}

function copyFileIfAbsent(src, dst) {
  ensureDir(dirname(dst));
  if (pathExists(dst)) return false;
  copyFileSync(src, dst);
  return true;
}

function copyDirNoClobber(src, dst, skip = new Set()) {
  ensureDir(dst);
  let copied = 0, skipped = 0;
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const s = join(src, entry.name), d = join(dst, entry.name);
    if (entry.isDirectory()) {
      const r = copyDirNoClobber(s, d, skip);
      copied += r.copied;
      skipped += r.skipped;
    } else if (entry.isFile()) {
      if (copyFileIfAbsent(s, d)) copied++;
      else skipped++;
    }
  }
  return { copied, skipped };
}

function isAdaptableTextFile(name) {
  return name.endsWith(".md") || name.endsWith(".txt") || name.endsWith(".json") ||
    name.endsWith(".yaml") || name.endsWith(".yml") || name.endsWith(".toml");
}

function copyDirAdapted(src, dst, adapt, opts = {}) {
  ensureDir(dst);
  let copied = 0, skipped = 0;
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (opts.skip?.has(entry.name)) continue;
    const targetName = opts.rename?.[entry.name] || entry.name;
    const s = join(src, entry.name), d = join(dst, targetName);
    if (entry.isDirectory()) {
      const r = copyDirAdapted(s, d, adapt, opts);
      copied += r.copied;
      skipped += r.skipped;
    } else if (entry.isFile()) {
      if (opts.noClobber && pathExists(d)) {
        skipped++;
        continue;
      }
      ensureDir(dirname(d));
      if (isAdaptableTextFile(entry.name)) writeFileSync(d, adapt(readFileSync(s, "utf8")));
      else copyFileSync(s, d);
      copied++;
    }
  }
  return { copied, skipped };
}

function copyTargetSkills(skillsDir, adapt, opts = {}) {
  const src = join(CORE_PAYLOAD, "skills");
  const skip = new Set(opts.skip || []);
  const rename = { ...(opts.rename || {}), "mishkan-ingest": "ares-ingest" };
  // `mishkan-init` adapts to `name: ares-init`; target adapters generate the
  // native `ares-init` skill separately, so copying the legacy source would
  // create a duplicate skill name under a stale directory.
  skip.add("mishkan-init");
  const result = copyDirAdapted(src, skillsDir, adapt, { ...opts, skip, rename });
  return {
    ...result,
    dirs: readdirSync(src, { withFileTypes: true }).filter(e => e.isDirectory() && !skip.has(e.name)).length,
  };
}

function parseFrontmatterMarkdown(text) {
  if (!text.startsWith("---\n")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { data: {}, body: text };
  const raw = text.slice(4, end).trim();
  const data = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  const bodyStart = text.indexOf("\n", end + 4);
  return { data, body: bodyStart >= 0 ? text.slice(bodyStart + 1) : "" };
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function adaptCodexText(text) {
  return text
    .replaceAll("~/.claude/CLAUDE.md", "~/.codex/AGENTS.md")
    .replaceAll("~/.claude/mishkan/agents/", "~/.codex/agents/")
    .replaceAll("~/.claude/mishkan/skills/", "~/.agents/skills/")
    .replaceAll("~/.claude/mishkan/profile.md", `${tilde(ARES_HOME)}/profile.md`)
    .replaceAll("~/.claude/mishkan", tilde(ARES_HOME))
    .replaceAll("~/.claude/rules/y4nn-standards.md", "~/.codex/ares/rules/y4nn-standards.md")
    .replaceAll("~/.claude/rules/engineer-standards.md", "~/.codex/ares/rules/engineer-standards.md")
    .replaceAll("{{MISHKAN}}", tilde(ARES_HOME))
    .replaceAll("mishkan-harness", "ares-harness")
    .replaceAll("mishkan-watchd", "ares-watchd")
    .replaceAll("mishkan-watch", "ares-watch")
    .replaceAll("`mishkan ", "`ares ")
    .replaceAll("mishkan-init", "ares-init")
    .replaceAll("mishkan-ingest", "ares-ingest")
    .replaceAll("mishkan-skills-reindex", "ares-skills-reindex")
    .replaceAll("mishkan-skills-misses", "ares-skills-misses")
    .replaceAll("mishkan-org-reference", "ares-org-reference")
    .replaceAll("/ares-init", "$ares-init")
    .replaceAll("/ares-resume", "$ares-resume")
    .replaceAll("/ares-skills-reindex", "$ares-skills-reindex")
    .replaceAll("/ares-skills-misses", "$ares-skills-misses")
    .replaceAll("/ares-org-reference", "$ares-org-reference")
    .replaceAll("/mishkan-init", "$ares-init")
    .replaceAll("/mishkan-resume", "$ares-resume")
    .replaceAll("/mishkan-skills-reindex", "$ares-skills-reindex")
    .replaceAll("/mishkan-skills-misses", "$ares-skills-misses")
    .replaceAll("/mishkan-org-reference", "$ares-org-reference")
    .replaceAll("/sprint-close", "$sprint-close")
    .replaceAll("/sefer-pull", "$sefer-pull")
    .replaceAll("/dep-audit", "$dependency-audit")
    .replaceAll("/dependency-audit", "$dependency-audit")
    .replaceAll("/eval-baruch", "$eval-baruch")
    .replaceAll("/promote", "$promote")
    .replaceAll("`./CLAUDE.md`", "`./AGENTS.md`")
    .replaceAll("./CLAUDE.md", "./AGENTS.md")
    .replaceAll("project `CLAUDE.md`", "project `AGENTS.md`")
    .replaceAll("into `.claude/`", "into `.codex/`");
}

function isHarnessLinkTarget(target) {
  return target.includes(".ares/") || target.includes("mishkan/");
}

// Symlink every entry of runtimeSub into claudeSub as a relative link.
// Skip names that already exist as a NON-symlink real file (preserve user's).
function linkInto(runtimeRoot, runtimeSub, claudeSub, dirEntries = false) {
  ensureDir(claudeSub);
  const srcDir = join(runtimeRoot, runtimeSub);
  if (!existsSync(srcDir)) return { linked: 0, skipped: 0 };
  let linked = 0, skipped = 0;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const isDir = entry.isDirectory();
    if (dirEntries !== isDir) continue;           // dirs for skills, files for agents/commands
    if (!dirEntries && !entry.name.endsWith(".md")) continue;
    const linkPath = join(claudeSub, entry.name);
    const target = relative(claudeSub, join(srcDir, entry.name));
    if (existsSync(linkPath) || isSymlink(linkPath)) {
      if (isSymlink(linkPath)) { unlinkSync(linkPath); }
      else { warn(`real file exists, not overwriting: ${tilde(linkPath)}`); skipped++; continue; }
    }
    symlinkSync(target, linkPath);
    linked++;
  }
  return { linked, skipped };
}

function isSymlink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
function tilde(p) { return p.replace(HOME, "~"); }

// Merge the hook fragment into settings.json, resolving {{MISHKAN}} and
// preserving any existing hooks (dedupe by exact command string).
function mergeHooks(runtimeRoot = RUNTIME_HOME) {
  const fragPath = join(PKG, "payload", "install", "settings.hooks.json");
  const frag = JSON.parse(readFileSync(fragPath, "utf8"));
  const settingsPath = join(CLAUDE, "settings.json");
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); }
    catch { warn("settings.json is not valid JSON; writing a backup and starting fresh hooks block");
            copyFileSync(settingsPath, settingsPath + ".mishkan-bak"); }
  }
  settings.hooks ||= {};
  const resolve = (s) => s.replaceAll("{{MISHKAN}}", runtimeRoot);
  const has = (arr, cmd) => arr.some(e => (e.hooks || []).some(h => h.command === cmd));
  for (const [event, entries] of Object.entries(frag.hooks)) {
    settings.hooks[event] ||= [];
    for (const entry of entries) {
      const resolvedHooks = entry.hooks.map(h => ({ ...h, command: resolve(h.command) }));
      // append into an existing matcher block if same matcher, else push new
      const existing = settings.hooks[event].find(e => (e.matcher || "") === (entry.matcher || ""));
      const targetArr = existing ? existing.hooks : null;
      if (existing) {
        for (const h of resolvedHooks) if (!targetArr.some(x => x.command === h.command)) targetArr.push(h);
      } else if (!has(settings.hooks[event], resolvedHooks[0]?.command)) {
        settings.hooks[event].push({ matcher: entry.matcher || "", hooks: resolvedHooks });
      }
    }
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function removeHooks() {
  const settingsPath = join(CLAUDE, "settings.json");
  if (!existsSync(settingsPath)) return;
  let settings; try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { return; }
  if (!settings.hooks) return;
  const isHarness = (h) => {
    const command = h.command || "";
    return command.includes("/mishkan/hooks/") || command.includes("/.ares/hooks/");
  };
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = settings.hooks[event]
      .map(e => ({ ...e, hooks: (e.hooks || []).filter(h => !isHarness(h)) }))
      .filter(e => (e.hooks || []).length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

// ─── tool availability + interactive prompts ──────────────────────────────

function commandExists(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which",
                      [cmd], { stdio: "ignore" });
  return r.status === 0;
}

function dockerNameExists(name) {
  const r = spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" });
  return r.status === 0 && (r.stdout || "").split("\n").includes(name);
}

function dockerNetworkExists(name) {
  const r = spawnSync("docker", ["network", "inspect", name], { stdio: "ignore" });
  return r.status === 0;
}

function preferExistingDockerName(primary, legacy) {
  return dockerNameExists(legacy) && !dockerNameExists(primary) ? legacy : primary;
}

function knowledgeDockerMode() {
  const hasAres = dockerNameExists("ares-cognee-mcp") ||
    dockerNameExists("ares-cognee-pg") ||
    dockerNameExists("ares-curated-mcp") ||
    dockerNetworkExists("ares-cognee_cognee_net");
  const hasLegacy = dockerNameExists("mishkan-cognee-mcp") ||
    dockerNameExists("mishkan-cognee-pg") ||
    dockerNameExists("mishkan-curated-mcp") ||
    dockerNetworkExists("mishkan-cognee_cognee_net");
  return hasLegacy && !hasAres ? "legacy" : "ares";
}

function knowledgeEnv(extra = {}) {
  const mode = knowledgeDockerMode();
  const prefix = mode === "legacy" ? LEGACY_BRAND : BRAND;
  return {
    ...process.env,
    COGNEE_COMPOSE_PROJECT: process.env.COGNEE_COMPOSE_PROJECT || `${prefix}-cognee`,
    COGNEE_MCP_IMAGE: process.env.COGNEE_MCP_IMAGE || `${prefix}/cognee-mcp`,
    COGNEE_MCP_CONTAINER: process.env.COGNEE_MCP_CONTAINER || `${prefix}-cognee-mcp`,
    OLLAMA_CONTAINER: process.env.OLLAMA_CONTAINER || `${prefix}-ollama`,
    COGNEE_NEO4J_CONTAINER: process.env.COGNEE_NEO4J_CONTAINER || `${prefix}-cognee-neo4j`,
    COGNEE_PG_CONTAINER: process.env.COGNEE_PG_CONTAINER || `${prefix}-cognee-pg`,
    COGNEE_WORK_NETWORK: process.env.COGNEE_WORK_NETWORK || `${prefix}-cognee_cognee_net`,
    CURATED_MCP_CONTAINER: process.env.CURATED_MCP_CONTAINER || `${prefix}-curated-mcp`,
    CURATED_NEO4J_CONTAINER: process.env.CURATED_NEO4J_CONTAINER || `${prefix}-curated-neo4j`,
    COGNEE_BACKEND_IMAGE: process.env.COGNEE_BACKEND_IMAGE || `${prefix}/cognee-backend`,
    COGNEE_FRONTEND_IMAGE: process.env.COGNEE_FRONTEND_IMAGE || `${prefix}/cognee-frontend`,
    COGNEE_BACKEND_CONTAINER: process.env.COGNEE_BACKEND_CONTAINER || `${prefix}-cognee-backend`,
    COGNEE_FRONTEND_CONTAINER: process.env.COGNEE_FRONTEND_CONTAINER || `${prefix}-cognee-frontend`,
    CURATED_BACKEND_CONTAINER: process.env.CURATED_BACKEND_CONTAINER || `${prefix}-curated-backend`,
    CURATED_FRONTEND_CONTAINER: process.env.CURATED_FRONTEND_CONTAINER || `${prefix}-curated-frontend`,
    ...extra,
  };
}

async function promptYN(question, defaultYes = true) {
  // Non-TTY (CI, piped install) -> use the default, never block.
  if (!stdin.isTTY) return defaultYes;
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = await new Promise(r => rl.question(question + suffix, r));
  rl.close();
  const a = ans.trim().toLowerCase();
  if (!a) return defaultYes;
  return a === "y" || a === "yes" || a === "o" || a === "oui";
}

async function promptText(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = await new Promise(r => rl.question(question, r));
  rl.close();
  return ans.trim();
}

// Masked input: each typed char becomes "*". Ctrl-C aborts. Backspace works.
// Non-TTY: falls back to a normal readline with a one-line warning.
async function promptSecret(question) {
  if (!stdin.isTTY) {
    warn("non-TTY stdin — secret input will be visible.");
    return promptText(question);
  }
  stdout.write(question);
  return new Promise((resolve) => {
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch) => {
      if (ch === "\r" || ch === "\n") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        stdout.write("\n");
        resolve(buf);
      } else if (ch === "") { // Ctrl-C
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        stdout.write("\n");
        process.exit(130);
      } else if (ch === "" || ch === "") { // backspace
        if (buf.length > 0) { buf = buf.slice(0, -1); stdout.write("\b \b"); }
      } else if (ch >= " " && ch.length === 1) {
        buf += ch;
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

async function promptChoice(question, choices) {
  if (!stdin.isTTY) return choices[0]?.key;
  console.log();
  console.log(c.bold(question));
  for (const ch of choices) {
    console.log(`  ${c.cyan(ch.key)}) ${c.bold(ch.name)}`);
    if (ch.why) console.log(c.dim(`     ${ch.why}`));
  }
  const valid = new Set(choices.map(c => c.key.toUpperCase()));
  while (true) {
    const ans = (await promptText(`  Choose [${choices.map(c => c.key).join("/")}]: `)).toUpperCase();
    if (valid.has(ans)) return ans;
    console.log(c.yellow(`  ? not a valid choice`));
  }
}

// ─── Knowledge stack configuration wizard ─────────────────────────────────
// Configures the whole cognee .env: LLM provider + key(s), neo4j/pg/admin
// secrets (generated or preserved), admin email. Without this, the stack
// doesn't have enough env to bring docker-compose up.

const LLM_PROFILES = {
  A: {
    name: "Ollama (fully self-hosted)",
    why: "No key, no quota. Free but slower for cognify. Recommended for personal hosts.",
    needs: [],
    block: () => `# Provider profile: Ollama (local, no external dependency)
LLM_PROVIDER=ollama
LLM_MODEL=qwen2.5:3b
LLM_ENDPOINT=http://ollama:11434/v1
LLM_API_KEY=ollama
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=nomic-embed-text:latest
EMBEDDING_ENDPOINT=http://ollama:11434/api/embed
EMBEDDING_DIMENSIONS=768`,
  },
  B: {
    name: "Google Gemini (cloud, paired LLM+embed)",
    why: "Generous free tier at Google AI Studio. Single key. Strong for cognify volume.",
    needs: [{ key: "LLM_API_KEY", prompt: "  Google AI Studio key: " }],
    block: (k) => `# Provider profile: Google Gemini (paired LLM + embeddings)
LLM_PROVIDER=gemini
LLM_MODEL=gemini/gemini-2.5-flash
LLM_API_KEY=${k.LLM_API_KEY}
EMBEDDING_PROVIDER=gemini
EMBEDDING_MODEL=gemini/gemini-embedding-001
EMBEDDING_DIMENSIONS=3072`,
  },
  C: {
    name: "OpenAI (cloud, paired LLM+embed)",
    why: "Pay per token, no free tier. Single key. Predictable quality.",
    needs: [{ key: "LLM_API_KEY", prompt: "  OpenAI API key (sk-...): " }],
    block: (k) => `# Provider profile: OpenAI (paired LLM + embeddings)
LLM_PROVIDER=openai
LLM_MODEL=openai/gpt-5-mini
LLM_API_KEY=${k.LLM_API_KEY}
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=openai/text-embedding-3-large
EMBEDDING_DIMENSIONS=3072`,
  },
  D: {
    name: "Anthropic LLM + OpenAI embeddings (TWO keys)",
    why: "Claude for reasoning; OpenAI for embed (Claude has none). Two providers, two keys.",
    needs: [
      { key: "LLM_API_KEY", prompt: "  Anthropic API key (sk-ant-...): " },
      { key: "EMBEDDING_API_KEY", prompt: "  OpenAI API key for embeddings (sk-...): " },
    ],
    block: (k) => `# Provider profile: Anthropic LLM + OpenAI embeddings
LLM_PROVIDER=anthropic
LLM_MODEL=anthropic/claude-sonnet-4-5
LLM_API_KEY=${k.LLM_API_KEY}
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=openai/text-embedding-3-large
EMBEDDING_DIMENSIONS=3072
EMBEDDING_API_KEY=${k.EMBEDDING_API_KEY}`,
  },
  E: {
    name: "NVIDIA API Catalog + Ollama embeddings",
    why: "Free NVIDIA cloud LLM (rate-limited, OpenAI-compatible) + local Ollama embed.",
    needs: [{ key: "LLM_API_KEY", prompt: "  NVIDIA nvapi-... key (build.nvidia.com): " }],
    block: (k) => `# Provider profile: NVIDIA API Catalog (LLM) + Ollama (embeddings)
LLM_PROVIDER=custom
LLM_MODEL=openai/meta/llama-3.1-70b-instruct
LLM_ENDPOINT=https://integrate.api.nvidia.com/v1
LLM_API_KEY=${k.LLM_API_KEY}
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=nomic-embed-text:latest
EMBEDDING_ENDPOINT=http://ollama:11434/api/embed
EMBEDDING_DIMENSIONS=768`,
  },
};

// Parse a KEY=VALUE env file into a flat dict (ignores comments / blank lines).
function parseEnv(text) {
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1);
    out[k] = v;
  }
  return out;
}

// 32-char URL-safe random secret. Strong enough for local-only daemons.
function genSecret() { return randomBytes(16).toString("hex"); }

async function configureKnowledge() {
  const targetDir = join(RUNTIME_HOME, "cognee");
  const exampleEnv = join(targetDir, ".env.example");
  const targetEnv = join(targetDir, ".env");

  console.log();
  console.log(c.bold(c.cyan("Configure the knowledge stack")));
  console.log(c.dim(
    `  Writes ${tilde(targetEnv)} (0600, gitignored).\n` +
    "  Sets the LLM provider + keys, generates neo4j + postgres + admin\n" +
    "  passwords on a fresh install, preserves them on a re-run so an\n" +
    "  initialised neo4j volume keeps working."));

  if (!existsSync(targetDir)) {
    warn(`cognee dir missing. Run \`npx ${PACKAGE_NAME} install\` first.`);
    return;
  }
  if (!existsSync(exampleEnv)) {
    warn(`template missing: ${tilde(exampleEnv)}`);
    return;
  }

  // Preserve existing local secrets if a .env is already initialised — neo4j
  // and pg volumes are encrypted-at-rest with their first-boot password and
  // would lock us out if we regenerated.
  let preserved = {};
  if (existsSync(targetEnv)) {
    const ok = await promptYN(`  .env exists. Overwrite (preserving the 3 local secrets)?`, false);
    if (!ok) { console.log(c.dim("  Aborted.")); return; }
    copyFileSync(targetEnv, targetEnv + ".bak");
    preserved = parseEnv(readFileSync(targetEnv, "utf8"));
  }

  // 1) provider profile
  const profileKey = await promptChoice("LLM provider profiles:",
    Object.entries(LLM_PROFILES).map(([key, p]) => ({ key, name: p.name, why: p.why })));
  const profile = LLM_PROFILES[profileKey];

  // 2) provider keys (masked)
  const apiKeys = {};
  for (const need of profile.needs) {
    const v = await promptSecret(need.prompt);
    if (!v) { console.log(c.yellow("  Aborted (empty key).")); return; }
    apiKeys[need.key] = v;
  }

  // 3) admin email (cognee backend bootstrap user)
  const defaultEmail = preserved.DEFAULT_USER_EMAIL || "admin@local.dev";
  const emailIn = await promptText(`  Cognee admin email [${defaultEmail}]: `);
  const adminEmail = emailIn || defaultEmail;

  // 4) stack secrets — preserve if .env existed, else generate
  const stackSecrets = {
    GRAPH_DATABASE_USERNAME: preserved.GRAPH_DATABASE_USERNAME || "neo4j",
    GRAPH_DATABASE_PASSWORD: preserved.GRAPH_DATABASE_PASSWORD || genSecret(),
    DB_PASSWORD:             preserved.DB_PASSWORD             || genSecret(),
    DEFAULT_USER_PASSWORD:   preserved.DEFAULT_USER_PASSWORD   || genSecret(),
  };
  const generated = Object.entries(stackSecrets).filter(([k]) => !preserved[k]).map(([k]) => k);

  // 5) build the .env. Strip provider + stack-secret lines from the example
  // so our explicit blocks land cleanly, then append the rest verbatim so the
  // engineer's tuning (rate limits, common defaults) survives.
  const example = readFileSync(exampleEnv, "utf8");
  const strip = /^(LLM|EMBEDDING)_(API_KEY|PROVIDER|MODEL|ENDPOINT|DIMENSIONS)=|^(GRAPH_DATABASE_USERNAME|GRAPH_DATABASE_PASSWORD|DB_PASSWORD|DEFAULT_USER_EMAIL|DEFAULT_USER_PASSWORD)=/;
  const tail = example.split("\n").filter(l => !strip.test(l)).join("\n");

  const stackBlock = `# Local-only stack secrets (neo4j, postgres, cognee backend admin).
# Generated fresh on first run; preserved across re-runs of configure-knowledge.
GRAPH_DATABASE_USERNAME=${stackSecrets.GRAPH_DATABASE_USERNAME}
GRAPH_DATABASE_PASSWORD=${stackSecrets.GRAPH_DATABASE_PASSWORD}
DB_PASSWORD=${stackSecrets.DB_PASSWORD}
DEFAULT_USER_EMAIL=${adminEmail}
DEFAULT_USER_PASSWORD=${stackSecrets.DEFAULT_USER_PASSWORD}`;

  const final = `# Generated by '${displayCommand()} knowledge configure' on ${new Date().toISOString()}
# Profile: ${profile.name}
# Re-run \`${displayCommand()} knowledge configure\` to switch providers (secrets preserved).

${profile.block(apiKeys)}

${stackBlock}

${tail}`;

  writeFileSync(targetEnv, final, { mode: 0o600 });

  // Companion file: ACCESS.txt with every URL, every credential, and the
  // remote-SSH-tunnel howto. Lives next to .env, same 0600 perms, gitignored
  // because it carries plaintext passwords.
  const accessPath = join(targetDir, "ACCESS.txt");
  writeFileSync(accessPath, renderAccessTxt({
    profile,
    adminEmail,
    secrets: stackSecrets,
  }), { mode: 0o600 });

  console.log();
  console.log(c.green(`✓ wrote ${tilde(targetEnv)} (0600)`));
  console.log(c.green(`✓ wrote ${tilde(accessPath)} (0600) — URLs + creds + connection guide`));
  console.log(c.dim(`  Profile: ${profile.name}`));
  if (generated.length) {
    console.log(c.yellow(`  Generated fresh: ${generated.join(", ")}`));
    console.log(c.dim("  All creds are in ACCESS.txt; back it up if you need them outside this host."));
  } else {
    console.log(c.dim("  Preserved existing neo4j / pg / admin secrets."));
  }

  // Live summary in the terminal — quick reference even without opening
  // the file. URLs come straight from the docker-compose port mappings.
  console.log();
  console.log(c.bold("Quick reference (also written to ACCESS.txt):"));
  console.log(c.dim("  ──────────────────────────────────────────────────────────────"));
  console.log(`  Memory · MCP       ${c.cyan("http://127.0.0.1:7777/mcp")}   ${c.dim("cognee-memory — shared session memory")}`);
  console.log(`  Memory · Graph UI  ${c.cyan("http://127.0.0.1:7724")}   ${c.dim(`${adminEmail} / DEFAULT_USER_PASSWORD`)}`);
  console.log(`  Memory · Neo4j     ${c.cyan("http://127.0.0.1:7716")}   ${c.dim("neo4j / GRAPH_DATABASE_PASSWORD")}`);
  console.log(`  Memory · REST      ${c.cyan("http://127.0.0.1:7737")}`);
  console.log(`  Per-project work   ${c.dim("provisioned per project at /ares-init (own port, embedded Ladybug) — ADR D-012")}`);
  console.log(`  Curated · MCP      ${c.cyan("http://127.0.0.1:7730/mcp")}`);
  console.log(`  Curated · Graph    ${c.cyan("http://127.0.0.1:7734")}`);
  console.log(`  Curated · Neo4j    ${c.cyan("http://127.0.0.1:7731")}`);
  console.log(`  Curated · REST     ${c.cyan("http://127.0.0.1:7733")}`);
  if (profile.name.includes("Ollama")) {
    console.log(`  Ollama             ${c.cyan("http://127.0.0.1:11434")}   ${c.dim("local LLM / embeddings")}`);
  }
  console.log();
  console.log(c.bold("Bring up the knowledge stack:"));
  console.log(c.dim(`  ${displayCommand()} knowledge-stack up`) + c.dim("   (guided: preflights config, then memory :7777 + curated :7730)"));
  console.log(c.dim(`\n  Full guide (incl. SSH-tunnel for remote hosts): ${tilde(accessPath)}`));
}

// Human-readable access guide written alongside .env. Sectioned plain text,
// 0600, gitignored. Contains every URL the Cognee stack exposes + the
// credentials each endpoint needs + the SSH-tunnel howto for remote access.
function renderAccessTxt({ profile, adminEmail, secrets }) {
  const sep = "─".repeat(70);
  const stamp = new Date().toISOString();
  const ollamaSection = profile.name.includes("Ollama")
    ? `\n${sep}\nOllama (local LLM / embeddings)\n${sep}\n
URL          : http://127.0.0.1:11434
Models       : qwen2.5:3b (LLM), nomic-embed-text:latest (embeddings)
Auth         : none (local)
Health       : curl -fsS http://127.0.0.1:11434/api/tags

Used by      : the Cognee containers via http://ollama:11434/* (internal DNS).
`
    : "";

  return `ARES — Cognee access guide
Generated ${stamp}
Profile     : ${profile.name}

This file lists every URL the Cognee stack exposes, the credentials each
endpoint needs, and how to reach them from a remote machine. Keep it private:
it carries plaintext passwords. Mode 0600. Gitignored.

${sep}
Cognee MEMORY store (shared session memory — alias cognee-memory, :7777)
${sep}

This is the kept Neo4j box, repurposed to hold only claude_code_memory (per-client
session memory). Per-project KNOWLEDGE lives in SEPARATE per-project work stores
(embedded Ladybug, own port each), provisioned by ensure-work-store.sh at
/ares-init — ADR D-012. This box is no longer the project work store.

MCP endpoint           : http://127.0.0.1:7777/mcp   (alias: cognee-memory)
  - Health check: \`curl -sf http://127.0.0.1:7777/mcp\` returns 406 = healthy
    (the endpoint requires the MCP handshake; a vanilla GET is rejected).

Cognee Graph Explorer  : http://127.0.0.1:7724
  - Web UI to browse the session-memory graph.
  - Login email    : ${adminEmail}
  - Login password : ${secrets.DEFAULT_USER_PASSWORD}

Cognee Backend REST    : http://127.0.0.1:7737
  - Backend API the Graph Explorer calls. Same creds as above.

Neo4j Browser          : http://127.0.0.1:7716
  - Direct cypher access to the session-memory graph (read-only recommended).
  - Username : ${secrets.GRAPH_DATABASE_USERNAME}
  - Password : ${secrets.GRAPH_DATABASE_PASSWORD}
  - Bolt URI : bolt://127.0.0.1:7709  (for desktop neo4j clients)

${sep}
Cognee CURATED store (cross-project reference library)
${sep}

MCP endpoint           : http://127.0.0.1:7730/mcp
Cognee Graph Explorer  : http://127.0.0.1:7734
Cognee Backend REST    : http://127.0.0.1:7733
Neo4j Browser          : http://127.0.0.1:7731
Neo4j Bolt             : bolt://127.0.0.1:7732

Web login              : ${adminEmail} / ${secrets.DEFAULT_USER_PASSWORD}
Neo4j login            : ${secrets.GRAPH_DATABASE_USERNAME} / ${secrets.GRAPH_DATABASE_PASSWORD}

Note: the curated stack runs its own neo4j with the SAME admin password by
default (set by '${displayCommand()} knowledge configure'). The compose stack reads .env.curated
for the curated containers — re-run '${displayCommand()} knowledge configure' to sync both.
${ollamaSection}
${sep}
Reaching a remote host (SSH tunnel)
${sep}

If the harness runs on a remote VPS / dev server, forward the ports to your
laptop with one SSH session:

  ssh -N -L 7777:127.0.0.1:7777 \\
         -L 7724:127.0.0.1:7724 \\
         -L 7716:127.0.0.1:7716 \\
         -L 7730:127.0.0.1:7730 \\
         -L 7734:127.0.0.1:7734 \\
         -L 7731:127.0.0.1:7731 \\
         <user>@<host>

Then open the URLs above on http://localhost:<port> from your laptop. The
ports are bound to 127.0.0.1 on the host (never 0.0.0.0), so tunneling is
the only remote access path by design.

${sep}
Postgres (internal only — not exposed)
${sep}

Container  : ${knowledgeEnv().COGNEE_PG_CONTAINER}
Database   : cognee
Password   : ${secrets.DB_PASSWORD}
Reachable  : from inside the docker network only.

To open psql for debugging:
  docker exec -it ${knowledgeEnv().COGNEE_PG_CONTAINER} psql -U cognee -d cognee
  (use the password above)

${sep}
Re-running this wizard
${sep}

  ares knowledge configure        (or: npx ares-harness knowledge configure)

Re-runs preserve the three local secrets (neo4j, pg, admin) so an
initialised neo4j volume keeps working. Both .env and ACCESS.txt are
regenerated; previous .env is backed up to .env.bak.
`;
}

// ─── observability opt-in (Phase 1.5 of the install contract, §10 of doc) ──

function installObservabilityStack() {
  console.log();
  console.log("   " + c.bold(c.cyan("▸ Observability")) + c.dim("   live cross-session daemon + TUI"));
  console.log(c.dim(
    "       Aggregates the harness event bus into a live snapshot you can watch.\n" +
    "       Needs `uv` (https://astral.sh/uv) + Python 3.11+ · docs/design/MISHKAN_observability.md."));

  if (!commandExists("uv")) {
    console.log(c.yellow("  uv not found — skipping observability install."));
    console.log(c.dim(
      "  Install uv with:\n" +
      "    curl -LsSf https://astral.sh/uv/install.sh | sh\n" +
      "  Then re-run:  npx ares-harness observability install"));
    return { installed: false, reason: "uv-missing" };
  }

  const watchdSrc = join(CORE_PAYLOAD, "observability", "watchd");
  const watchSrc  = join(CORE_PAYLOAD, "observability", "watch");
  for (const dir of [watchdSrc, watchSrc]) {
    if (!existsSync(dir)) {
      warn(`observability source missing: ${tilde(dir)}`);
      return { installed: false, reason: "payload-missing" };
    }
  }

  console.log(c.dim("  Installing ares-watchd (daemon)…"));
  const r1 = spawnSync("uv", ["tool", "install", "--from", watchdSrc, "ares-watchd"],
                       { stdio: "inherit" });
  if (r1.status !== 0) { warn("ares-watchd install failed"); return { installed: false, reason: "install-failed" }; }

  console.log(c.dim("  Installing ares-watch (TUI client)…"));
  const r2 = spawnSync("uv", ["tool", "install", "--from", watchSrc, "ares-watch"],
                       { stdio: "inherit" });
  if (r2.status !== 0) { warn("ares-watch install failed"); return { installed: false, reason: "install-failed" }; }

  console.log("   " + c.green("✓ observability installed") + c.dim("   ·   executables: ares-watch, ares-watchd"));
  console.log(c.dim(
    "       Open the TUI       ares-watch   (auto-starts the daemon)\n" +
    "       Two-terminal       ares-watchd start, then  ares-watch --no-autostart\n" +
    "       Stop the daemon    ares-watchd stop\n" +
    "       Start at login     ares-watchd install-service"));
  return { installed: true };
}

// ─── post-install sign-off ───────────────────────────────────────────────────
// The wordmark + a short, builder-to-builder note. ASCII art (ANSI Shadow); the
// block glyphs are plain Unicode and render uncolored under NO_COLOR.
const WORDMARK = [
  "███╗   ███╗██╗███████╗██╗  ██╗██╗  ██╗ █████╗ ███╗   ██╗",
  "████╗ ████║██║██╔════╝██║  ██║██║ ██╔╝██╔══██╗████╗  ██║",
  "██╔████╔██║██║███████╗███████║█████╔╝ ███████║██╔██╗ ██║",
  "██║╚██╔╝██║██║╚════██║██╔══██║██╔═██╗ ██╔══██║██║╚██╗██║",
  "██║ ╚═╝ ██║██║███████║██║  ██║██║  ██╗██║  ██║██║ ╚████║",
  "╚═╝     ╚═╝╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝",
];

function printBanner(version) {
  console.log();
  for (const line of WORDMARK) console.log("   " + c.cyan(line));
  console.log();
  console.log("   " + c.bold("מִשְׁכָּן") + c.dim("  ·  a dwelling place for your engineering work"));
  console.log("   " + c.dim(`v${version}  ·  45 agents · 6 teams · research pipeline · knowledge graph`));
}

async function install(argv = []) {
  const target = parseTargetOption(argv, "claude");
  for (const t of expandTargets(target)) {
    if (t === "claude") await installClaudeTarget();
    else if (t === "codex") installCodexTarget();
    else if (t === "opencode") installOpenCodeTarget();
    else installPendingTarget(t);
  }
}

function installPendingTarget(target) {
  console.log();
  console.log(c.bold(c.cyan(`${target} target adapter`)));
  console.log(c.yellow("  Pending: no files written yet."));
  console.log(c.dim(`  Planned home: ${tilde(targetHome(target))}`));
  console.log(c.dim("  This CLI shape is in place so native Codex/OpenCode renderers can land next."));
}

function installCorePayload(runtimeRoot = ARES_HOME) {
  copyDir(CORE_PAYLOAD, runtimeRoot);
  ensureDir(join(runtimeRoot, "logs"));
  ensureDir(join(runtimeRoot, "cognee"));
}

function installAresCorePayload() {
  if (!existsSync(ARES_HOME) && existsSync(LEGACY_HOME)) {
    copyDir(LEGACY_HOME, ARES_HOME);
    log(`migrated legacy runtime ${tilde(LEGACY_HOME)} -> ${tilde(ARES_HOME)}`);
  }
  installCorePayload(ARES_HOME);
  ensureDir(join(ARES_HOME, "logs"));
  ensureDir(join(ARES_HOME, "cognee"));
  const runtimeProfile = join(ARES_HOME, "profile.md");
  const realProfile = join(PKG, "docs", "engineer", "profile.md");
  const exampleProfile = join(PKG, "docs", "engineer", "profile.example.md");
  if (!existsSync(runtimeProfile)) {
    const src = existsSync(realProfile) ? realProfile : exampleProfile;
    if (existsSync(src)) copyFileSync(src, runtimeProfile);
  }
  writeAresCommandAliases(ARES_HOME);
  installSharedSkills(join(ARES_HOME, "skills"));
}

function adaptClaudeAresText(text) {
  return text
    .replaceAll("~/.claude/mishkan/agents/", "~/.ares/agents/")
    .replaceAll("~/.claude/mishkan/skills/", "~/.ares/skills/")
    .replaceAll("~/.claude/mishkan/profile.md", "~/.ares/profile.md")
    .replaceAll("~/.claude/mishkan", "~/.ares")
    .replaceAll("{{MISHKAN}}", "~/.ares")
    .replaceAll("mishkan-harness", "ares-harness")
    .replaceAll("mishkan-watchd", "ares-watchd")
    .replaceAll("mishkan-watch", "ares-watch")
    .replaceAll("`mishkan ", "`ares ")
    .replaceAll("mishkan-init", "ares-init")
    .replaceAll("mishkan-ingest", "ares-ingest")
    .replaceAll("mishkan-skills-reindex", "ares-skills-reindex")
    .replaceAll("mishkan-skills-misses", "ares-skills-misses")
    .replaceAll("mishkan-org-reference", "ares-org-reference")
    .replaceAll("/mishkan-init", "/ares-init")
    .replaceAll("/mishkan-resume", "/ares-resume")
    .replaceAll("/mishkan-skills-reindex", "/ares-skills-reindex")
    .replaceAll("/mishkan-skills-misses", "/ares-skills-misses")
    .replaceAll("/mishkan-org-reference", "/ares-org-reference")
    .replaceAll("/dep-audit", "/dependency-audit");
}

function writeAresCommandAliases(runtimeRoot) {
  const commandsDir = join(runtimeRoot, "commands");
  ensureDir(commandsDir);
  for (const spec of CODEX_COMMAND_SKILLS) {
    if (!["ares-init", "ares-resume", "ares-skills-reindex", "ares-skills-misses", "ares-org-reference", "dependency-audit"].includes(spec.name)) continue;
    const command = readFileSync(join(CORE_PAYLOAD, "commands", spec.source), "utf8");
    const { data, body } = parseFrontmatterMarkdown(command);
    const description = adaptClaudeAresText(data.description || spec.description).replace(/\n/g, " ");
    const md = `---
description: ${description}
${data["argument-hint"] ? `argument-hint: ${data["argument-hint"]}\n` : ""}---

${adaptClaudeAresText(body.trim())}
`;
    writeFileSync(join(commandsDir, `${spec.name}.md`), md);
  }
}

function adaptSharedSkillText(text) {
  return adaptClaudeAresText(text)
    .replaceAll("~/.claude/CLAUDE.md", "the target-native global guidance file")
    .replaceAll("~/.claude/rules/y4nn-standards.md", "~/.ares/rules/y4nn-standards.md")
    .replaceAll("~/.claude/rules/engineer-standards.md", "~/.ares/rules/engineer-standards.md")
    .replaceAll("`./CLAUDE.md`", "the target-native project state file")
    .replaceAll("./CLAUDE.md", "the target-native project state file")
    .replaceAll("project `CLAUDE.md`", "target-native project state file")
    .replaceAll("into `.claude/`", "into the target-native runtime directory");
}

function writeSharedCommandSkills(skillsDir) {
  let written = 0;
  for (const spec of CODEX_COMMAND_SKILLS) {
    const dir = join(skillsDir, spec.name);
    const skillPath = join(dir, "SKILL.md");
    if (existsSync(skillPath) && !spec.generated) continue;
    ensureDir(dir);
    const command = readFileSync(join(CORE_PAYLOAD, "commands", spec.source), "utf8");
    const { body } = parseFrontmatterMarkdown(command);
    const skill = `---
name: ${spec.name}
description: ${spec.description}
---

# ${spec.name}

Use this shared ARES workflow skill through the native runtime surface:

- Claude Code or OpenCode: \`/${spec.name}\`
- Codex: \`$${spec.name}\` or the skill picker

## Workflow

${adaptSharedSkillText(body.trim())}
`;
    writeFileSync(skillPath, skill);
    written++;
  }
  return written;
}

function managedSharedSkillNames() {
  const names = new Set(CODEX_COMMAND_SKILLS.map(spec => spec.name));
  const src = join(CORE_PAYLOAD, "skills");
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "mishkan-init") continue;
    names.add(entry.name === "mishkan-ingest" ? "ares-ingest" : entry.name);
  }
  return names;
}

function removeManagedSkillCopies(skillsDir) {
  let removed = 0;
  for (const name of managedSharedSkillNames()) {
    const dir = join(skillsDir, name);
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

function installSharedSkills(skillsDir) {
  ensureDir(skillsDir);
  for (const legacyName of ["mishkan-init", "mishkan-ingest"]) {
    const legacyDir = join(skillsDir, legacyName);
    if (existsSync(legacyDir)) rmSync(legacyDir, { recursive: true, force: true });
  }
  const copied = copyTargetSkills(skillsDir, adaptSharedSkillText).dirs;
  const commands = writeSharedCommandSkills(skillsDir);
  return { copied, commands };
}

const CODEX_COMMAND_SKILLS = [
  { name: "ares-init", source: "mishkan-init.md", description: "Initialise the current project under ARES with the PRD to Sprint S0 spec chain.", generated: true },
  { name: "ares-resume", source: "mishkan-resume.md", description: "Resume an ARES project by loading repo state, sprint state, blockers, and pending decisions.", generated: true },
  { name: "ares-skills-reindex", source: "mishkan-skills-reindex.md", description: "Rebuild the universal skill-discovery index." },
  { name: "ares-skills-misses", source: "mishkan-skills-misses.md", description: "Aggregate skill-discovery miss logs for tuning." },
  { name: "ares-org-reference", source: "mishkan-org-reference.md", description: "Print the 45-agent reference inline." },
  { name: "sprint-close", source: "sprint-close.md", description: "Close the current sprint with reporters, documentation pull, Cognee promotion, and next sprint state.", generated: true },
  { name: "code-graph", source: "code-graph.md", description: "Inspect, open, or refresh the Graphify code graph." },
  { name: "skills", source: "skills.md", description: "Route a task through the skill-discovery index." },
  { name: "sefer-pull", source: "sefer-pull.md", description: "Trigger a Sefer documentation pull outside the milestone." },
  { name: "dependency-audit", source: "dep-audit.md", description: "Audit dependencies across registered projects and produce a coordinated vetted update plan." },
  { name: "eval-baruch", source: "eval-baruch.md", description: "Run the Baruch contract eval." },
  { name: "promote", source: "promote.md", description: "Promote a learning into Cognee by blast radius." },
];

function installCodexTarget() {
  const codexHome = targetHome("codex");
  const agentsDir = join(codexHome, "agents");
  const supportDir = join(codexHome, "ares");
  const skillsDir = join(HOME, ".agents", "skills");

  ensureDir(codexHome);
  ensureDir(agentsDir);
  ensureDir(supportDir);
  ensureDir(skillsDir);

  installAresCorePayload();
  installCodexSupportFiles(supportDir);
  writeCodexAgentsMd(codexHome);
  const agents = writeCodexAgents(agentsDir);
  const sharedSkills = installSharedSkills(skillsDir);
  writeCodexMcpConfig(codexHome);
  mergeCodexHooks(join(codexHome, "hooks.json"), ARES_HOME);

  log(`codex target installed into ${tilde(codexHome)}`);
  log(`codex artifacts: agents=${agents}, shared skills=${sharedSkills.copied + sharedSkills.commands}`);
  warn("codex SessionStart and safe PreToolUse/PostToolUse hooks are installed; review and trust them through /hooks on first use.");
}

function adaptOpenCodeText(text) {
  return text
    .replaceAll("~/.claude/CLAUDE.md", "~/.config/opencode/AGENTS.md")
    .replaceAll("~/.claude/mishkan/agents/", "~/.config/opencode/agents/")
    .replaceAll("~/.claude/mishkan/skills/", "~/.agents/skills/")
    .replaceAll("~/.claude/mishkan/profile.md", `${tilde(ARES_HOME)}/profile.md`)
    .replaceAll("~/.claude/mishkan", tilde(ARES_HOME))
    .replaceAll("~/.claude/rules/y4nn-standards.md", "~/.config/opencode/ares/rules/y4nn-standards.md")
    .replaceAll("~/.claude/rules/engineer-standards.md", "~/.config/opencode/ares/rules/engineer-standards.md")
    .replaceAll("{{MISHKAN}}", tilde(ARES_HOME))
    .replaceAll("mishkan-harness", "ares-harness")
    .replaceAll("mishkan-watchd", "ares-watchd")
    .replaceAll("mishkan-watch", "ares-watch")
    .replaceAll("`mishkan ", "`ares ")
    .replaceAll("mishkan-init", "ares-init")
    .replaceAll("mishkan-ingest", "ares-ingest")
    .replaceAll("mishkan-skills-reindex", "ares-skills-reindex")
    .replaceAll("mishkan-skills-misses", "ares-skills-misses")
    .replaceAll("mishkan-org-reference", "ares-org-reference")
    .replaceAll("/mishkan-init", "/ares-init")
    .replaceAll("/mishkan-resume", "/ares-resume")
    .replaceAll("/mishkan-skills-reindex", "/ares-skills-reindex")
    .replaceAll("/mishkan-skills-misses", "/ares-skills-misses")
    .replaceAll("/mishkan-org-reference", "/ares-org-reference")
    .replaceAll("/dep-audit", "/dependency-audit")
    .replaceAll("`./CLAUDE.md`", "`./AGENTS.md`")
    .replaceAll("./CLAUDE.md", "./AGENTS.md")
    .replaceAll("project `CLAUDE.md`", "project `AGENTS.md`")
    .replaceAll("into `.claude/`", "into `.opencode/`");
}

function installOpenCodeTarget() {
  const opencodeHome = targetHome("opencode");
  const agentsDir = join(opencodeHome, "agents");
  const commandsDir = join(opencodeHome, "commands");
  const legacySkillsDir = join(opencodeHome, "skills");
  const skillsDir = join(HOME, ".agents", "skills");
  const pluginsDir = join(opencodeHome, "plugins");
  const supportDir = join(opencodeHome, "ares");

  ensureDir(opencodeHome);
  ensureDir(agentsDir);
  ensureDir(commandsDir);
  ensureDir(pluginsDir);
  ensureDir(supportDir);

  installAresCorePayload();
  installOpenCodeSupportFiles(supportDir);
  writeOpenCodeAgentsMd(opencodeHome);
  const agents = writeOpenCodeAgents(agentsDir);
  const commands = writeOpenCodeCommands(commandsDir);
  const removedLegacySkills = removeManagedSkillCopies(legacySkillsDir);
  const sharedSkills = installSharedSkills(skillsDir);
  const plugins = writeOpenCodePlugins(pluginsDir);
  writeOpenCodeConfig(opencodeHome);

  log(`opencode target installed into ${tilde(opencodeHome)}`);
  log(`opencode artifacts: agents=${agents}, commands=${commands}, shared skills=${sharedSkills.copied + sharedSkills.commands}, plugins=${plugins}`);
  if (removedLegacySkills) log(`opencode migration: removed ${removedLegacySkills} obsolete managed skill copies from ${tilde(legacySkillsDir)}`);
  warn("opencode session indexing and safe tool security/observability plugins are installed.");
}

function installOpenCodeSupportFiles(supportDir) {
  ensureDir(join(supportDir, "rules"));
  const profileSrc = existsSync(join(PKG, "docs", "engineer", "profile.md"))
    ? join(PKG, "docs", "engineer", "profile.md")
    : join(PKG, "docs", "engineer", "profile.example.md");
  const profileDst = join(supportDir, "profile.md");
  if (!existsSync(profileDst) && existsSync(profileSrc)) copyFileSync(profileSrc, profileDst);
  copyFileSync(join(PKG, "payload", "user", "rules", "y4nn-standards.md"),
               join(supportDir, "rules", "y4nn-standards.md"));
  const engineerRule = join(supportDir, "rules", "engineer-standards.md");
  if (!existsSync(engineerRule)) {
    copyFileSync(join(PKG, "payload", "user", "rules", "engineer-standards.md"), engineerRule);
  }
}

function writeOpenCodeAgentsMd(opencodeHome) {
  const src = readFileSync(join(PKG, "payload", "user", "CLAUDE.md"), "utf8");
  const body = `# ARES Harness For OpenCode

This managed block adapts the current MISHKAN organization to OpenCode.
ARES is the technical namespace; the team and agent names remain MISHKAN for now.

OpenCode-native locations installed by \`${displayCommand()} install --target opencode\`:

- Global guidance: \`~/.config/opencode/AGENTS.md\`
- Agents: \`~/.config/opencode/agents/*.md\`
- Commands: \`~/.config/opencode/commands/*.md\`
- Shared skills: \`~/.agents/skills/*/SKILL.md\`
- Session plugin: \`~/.config/opencode/plugins/ares-session.js\`
- ARES support files: \`~/.config/opencode/ares/\`

Use top-level OpenCode commands such as \`/ares-init\`, \`/ares-resume\`,
\`/sprint-close\`, \`/sefer-pull\`, \`/dependency-audit\`, and \`/promote\`.

${adaptOpenCodeText(src)}`;
  writeManagedBlock(
    join(opencodeHome, "AGENTS.md"),
    "<!-- ARES-HARNESS:BEGIN opencode-agents -->",
    "<!-- ARES-HARNESS:END opencode-agents -->",
    body,
  );
}

function writeOpenCodeAgents(agentsDir) {
  const srcDir = join(CORE_PAYLOAD, "agents");
  let count = 0;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const raw = readFileSync(join(srcDir, entry.name), "utf8");
    const { data, body } = parseFrontmatterMarkdown(raw);
    const name = data.name || entry.name.replace(/\.md$/, "");
    const description = data.description || `${name} MISHKAN agent.`;
    const md = `---
description: ${description}
mode: subagent
permission:
  edit: ask
  bash: ask
---

${adaptOpenCodeText(body.trim())}
`;
    writeFileSync(join(agentsDir, `${name}.md`), md);
    count++;
  }
  return count;
}

function writeOpenCodeCommands(commandsDir) {
  let written = 0;
  for (const spec of CODEX_COMMAND_SKILLS) {
    const command = readFileSync(join(CORE_PAYLOAD, "commands", spec.source), "utf8");
    const { data, body } = parseFrontmatterMarkdown(command);
    const description = adaptOpenCodeText(data.description || spec.description).replace(/\n/g, " ");
    const md = `---
description: ${description}
---

${adaptOpenCodeText(body.trim())}
`;
    writeFileSync(join(commandsDir, `${spec.name}.md`), md);
    written++;
  }
  return written;
}

function renderOpenCodeSessionPlugin() {
  return `// Managed by ARES harness. OpenCode loads global plugins at startup.
export const AresSessionPlugin = async ({ $ }) => ({
  event: async ({ event }) => {
    if (event?.type !== "session.created") return;
    const home = process.env.ARES_HOME ||
      (process.env.HOME ? process.env.HOME + "/.ares" : null);
    if (!home) return;
    const hook = home + "/hooks/session-start-skill-index.sh";
    try {
      await $\`bash \${hook}\`;
    } catch {
      // Skill indexing is advisory and must never block an OpenCode session.
    }
  },
});
`;
}

function renderOpenCodeToolHooksPlugin(runtimeRoot = ARES_HOME) {
  const home = JSON.stringify(runtimeRoot);
  return `// Managed by ARES harness. OpenCode loads global plugins at startup.
import { spawn } from "node:child_process";

const runtimeHome = ${home};
const hookPaths = {
  security: runtimeHome + "/hooks/pre-tool-security.sh",
  trace: runtimeHome + "/hooks/pre-tool-trace.sh",
  observe: runtimeHome + "/hooks/post-tool-observe.sh",
};

function runHook(path, payload, timeoutMs = 10000) {
  let serialized;
  try {
    serialized = JSON.stringify(payload, (_key, value) =>
      typeof value === "bigint" ? String(value) : value
    );
  } catch (error) {
    return Promise.resolve({ code: null, stdout: "", stderr: "", error: error.message });
  }
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn("bash", [path], {
      env: {
        ...process.env,
        ARES_HOME: runtimeHome,
        ARES_TRACE_DIR: runtimeHome + "/tmp",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: null, stdout, stderr, error: "timeout" });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ code: null, stdout, stderr, error: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr, error: null }));
    child.stdin.on("error", () => {});
    child.stdin.end(serialized);
  });
}

function canonicalTool(name) {
  switch (name) {
    case "write": return "Write";
    case "edit": return "Edit";
    case "bash": return "Bash";
    case "skill": return "Skill";
    default: return name || "unknown";
  }
}

function canonicalInput(name, args = {}) {
  if (name === "write") {
    return { file_path: args.filePath ?? args.file_path, content: args.content };
  }
  if (name === "edit") {
    return {
      file_path: args.filePath ?? args.file_path,
      old_string: args.oldString ?? args.old_string,
      new_string: args.newString ?? args.new_string,
    };
  }
  if (name === "apply_patch") {
    return { command: args.patchText ?? args.command ?? "" };
  }
  if (name === "bash") {
    return { command: args.command ?? "", cwd: args.workdir ?? args.cwd };
  }
  if (name === "skill") {
    return { skill: args.name ?? args.skill, args: args.arguments ?? args.args };
  }
  return args;
}

function payload(input, args, directory, eventName, response) {
  const result = {
    session_id: input?.sessionID || "unknown",
    cwd: directory || process.cwd(),
    hook_event_name: eventName,
    tool_name: canonicalTool(input?.tool),
    tool_input: canonicalInput(input?.tool, args),
    tool_use_id: input?.callID || "",
    runtime: "opencode",
  };
  if (eventName === "PostToolUse") result.tool_response = response ?? {};
  return result;
}

export const AresToolHooksPlugin = async ({ directory }) => ({
  "tool.execute.before": async (input, output) => {
    const adapted = payload(input, output?.args || {}, directory, "PreToolUse");
    if (["write", "edit", "apply_patch"].includes(input?.tool)) {
      const decision = await runHook(hookPaths.security, adapted);
      if (decision.code === 0 && decision.stdout.trim()) {
        try {
          const parsed = JSON.parse(decision.stdout);
          if (parsed?.hookSpecificOutput?.permissionDecision === "deny") {
            throw new Error(parsed.hookSpecificOutput.permissionDecisionReason || "Blocked by ARES security policy");
          }
        } catch (error) {
          if (error instanceof SyntaxError) {
            // Invalid hook output fails open, matching the shell hook contract.
          } else {
            throw error;
          }
        }
      }
    }
    await runHook(hookPaths.trace, adapted);
  },
  "tool.execute.after": async (input, output) => {
    const adapted = payload(input, input?.args || {}, directory, "PostToolUse", output);
    await runHook(hookPaths.observe, adapted, 20000);
  },
});
`;
}

function writeOpenCodePlugins(pluginsDir) {
  ensureDir(pluginsDir);
  writeFileSync(join(pluginsDir, "ares-session.js"), renderOpenCodeSessionPlugin());
  writeFileSync(join(pluginsDir, "ares-tool-hooks.js"), renderOpenCodeToolHooksPlugin());
  return 2;
}

function mergeJsonConfig(filePath, update) {
  ensureDir(dirname(filePath));
  let config = { "$schema": "https://opencode.ai/config.json" };
  if (existsSync(filePath)) {
    try {
      config = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      copyFileSync(filePath, filePath + ".ares-bak");
      warn(`opencode config was not valid JSON; backed it up to ${tilde(filePath)}.ares-bak and wrote managed config`);
    }
  }
  update(config);
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
}

function writeOpenCodeConfig(opencodeHome) {
  mergeJsonConfig(join(opencodeHome, "opencode.json"), (config) => {
    config.$schema ||= "https://opencode.ai/config.json";
    config.mcp ||= {};
    config.mcp.cognee_memory = {
      type: "remote",
      url: "http://127.0.0.1:7777/mcp",
      enabled: true,
      oauth: false,
    };
    config.mcp.cognee_curated = {
      type: "remote",
      url: "http://127.0.0.1:7730/mcp",
      enabled: true,
      oauth: false,
    };
  });
}

function slugFromPath(root) {
  return (basename(root) || "project")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function renderTemplate(text, vars) {
  let out = text;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, String(value));
  }
  return out;
}

function existingProjectField(root, field) {
  const rx = new RegExp(`- \\*\\*${field}:\\*\\*\\s+(.+)`);
  for (const file of [join(root, "CLAUDE.md"), join(root, "AGENTS.md")]) {
    if (!existsSync(file)) continue;
    const match = readFileSync(file, "utf8").match(rx);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function projectInitOptions(argv) {
  const rootOpt = optionValue(argv, "--dir", process.cwd());
  const root = resolve(rootOpt || process.cwd());
  const name = optionValue(argv, "--name", null) || existingProjectField(root, "Name") || basename(root) || "project";
  const stack = optionValue(argv, "--stack", null) || existingProjectField(root, "Stack") || "undetermined";
  const slug = slugFromPath(root);
  return {
    root,
    name,
    stack,
    slug,
    wiringOnly: argv.includes("--wiring-only"),
    vars: {
      PROJECT_NAME: name,
      STACK: stack,
      COGNEE_NAMESPACE: `ares:${slug}`,
      DATE: new Date().toISOString().slice(0, 10),
      SPRINT: "S0",
      MILESTONE: "project-init",
      MODE: "planning",
      TASKS: "- [ ] Run the target-native ARES init workflow and produce PRD/SRS/CONTRACT/ARCHITECTURE/THREAT_MODEL/C4.",
      BLOCKERS: "- None recorded yet.",
      FLAGS: "- Runtime wiring only; update this state after the first planning pass.",
    },
  };
}

function renderProjectState(target, opts) {
  const raw = readFileSync(join(CORE_PAYLOAD, "templates", "project-CLAUDE.md"), "utf8");
  let state = renderTemplate(raw, opts.vars);
  if (target === "claude") return adaptClaudeAresText(state);
  if (target === "codex") return adaptCodexText(state);
  if (target === "opencode") return adaptOpenCodeText(state);
  return state;
}

function projectStateBlock(target, opts) {
  const invocation = TARGET_DEFINITIONS[target].initUsage;
  const targetName = target === "claude" ? "Claude Code" : target === "codex" ? "Codex" : "OpenCode";
  return `# ARES Project Wiring For ${targetName}

This managed block was written by \`${displayCommand()} project init --target ${target}\`.
It is safe to regenerate; user-authored content outside this block is preserved.

Use ${invocation} to run the full PRD -> Sprint S0 workflow. This command only
lays down target-native wiring; it does not generate product documents, mutate
git state, or start the Cognee work store.

${renderProjectState(target, opts)}`;
}

function writeProjectGitignore(root) {
  writeManagedBlock(
    join(root, ".gitignore"),
    "# ARES-HARNESS:BEGIN project-ignore",
    "# ARES-HARNESS:END project-ignore",
    `.claude/settings.local.json
graphify-out/`,
  );
}

function writeProjectDocs(root) {
  ensureDir(join(root, "docs", "adr"));
  ensureDir(join(root, "docs", "runbooks"));
  ensureDir(join(root, "docs", "diagrams", "C4"));
  writeFileIfAbsent(join(root, "docs", "README.md"), `# Project Documentation

Seeded by ARES project init. The full init workflow should produce:

- PRD.md
- SRS.md
- CONTRACT.md
- ARCHITECTURE.md
- THREAT_MODEL.md
- diagrams/C4/
- adr/
- runbooks/
`);
}

function writeProjectRules(dir) {
  ensureDir(dir);
  let written = 0, skipped = 0;
  for (const name of ["y4nn-standards.md", "engineer-standards.md"]) {
    const src = join(PKG, "payload", "user", "rules", name);
    if (copyFileIfAbsent(src, join(dir, name))) written++;
    else skipped++;
  }
  return { written, skipped };
}

function projectClaudeMcpJson() {
  return JSON.stringify({
    _comment: "ARES project MCP. The per-project Cognee work store is intentionally not wired until `ares project-work-store up` has provisioned a real port.",
    mcpServers: {
      "cognee-memory": {
        type: "http",
        url: "http://127.0.0.1:7777/mcp",
      },
      "cognee-curated": {
        type: "http",
        url: "http://127.0.0.1:7730/mcp",
      },
    },
  }, null, 2) + "\n";
}

function writeProjectClaude(opts) {
  const root = opts.root;
  writeManagedBlock(
    join(root, "CLAUDE.md"),
    "<!-- ARES-HARNESS:BEGIN project-claude -->",
    "<!-- ARES-HARNESS:END project-claude -->",
    projectStateBlock("claude", opts),
  );

  let written = 1, skipped = 0;
  if (writeFileIfAbsent(join(root, ".mcp.json"), projectClaudeMcpJson())) written++;
  else skipped++;

  const settings = adaptClaudeAresText(readFileSync(join(CORE_PAYLOAD, "templates", "settings.json"), "utf8"));
  const localSettings = adaptClaudeAresText(readFileSync(join(CORE_PAYLOAD, "templates", "settings.local.json"), "utf8"));
  if (writeFileIfAbsent(join(root, ".claude", "settings.json"), settings)) written++;
  else skipped++;
  if (writeFileIfAbsent(join(root, ".claude", "settings.local.json"), localSettings)) written++;
  else skipped++;

  const rules = writeProjectRules(join(root, ".claude", "rules"));
  written += rules.written;
  skipped += rules.skipped;
  return { target: "claude", written, skipped };
}

function writeProjectCodexConfig(root) {
  const body = `# The per-project Cognee work store is not added until
# \`ares project-work-store up\` has provisioned a real port.

[mcp_servers.cognee_memory]
url = "http://127.0.0.1:7777/mcp"
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 60

[mcp_servers.cognee_curated]
url = "http://127.0.0.1:7730/mcp"
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 60`;
  writeManagedBlock(
    join(root, ".codex", "config.toml"),
    "# ARES-HARNESS:BEGIN codex-project-mcp",
    "# ARES-HARNESS:END codex-project-mcp",
    body,
  );
}

function codexHooksFragment(runtimeRoot = ARES_HOME, includeToolHooks = true) {
  const hooks = {
      SessionStart: [
        {
          matcher: "startup|resume|clear|compact",
          hooks: [
            {
              type: "command",
              command: `bash ${shellQuote(join(runtimeRoot, "hooks", "session-start-skill-index.sh"))}`,
              statusMessage: "ARES skill index check",
              timeout: 30,
            },
          ],
        },
      ],
  };
  if (includeToolHooks) {
    hooks.PreToolUse = [
      {
        matcher: "Write|Edit|apply_patch",
        hooks: [
          {
            type: "command",
            command: `bash ${shellQuote(join(runtimeRoot, "hooks", "pre-tool-security.sh"))}`,
            statusMessage: "ARES security scan",
            timeout: 10,
          },
        ],
      },
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `bash ${shellQuote(join(runtimeRoot, "hooks", "pre-tool-trace.sh"))}`,
            statusMessage: "ARES tool trace",
            timeout: 10,
          },
        ],
      },
    ];
    hooks.PostToolUse = [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `bash ${shellQuote(join(runtimeRoot, "hooks", "post-tool-observe.sh"))}`,
            statusMessage: "ARES tool observability",
            timeout: 20,
          },
        ],
      },
    ];
  }
  return {
    hooks,
  };
}

function mergeCodexHooks(hooksPath, runtimeRoot = ARES_HOME, includeToolHooks = true) {
  ensureDir(dirname(hooksPath));
  let existing = {};
  if (existsSync(hooksPath)) {
    try { existing = JSON.parse(readFileSync(hooksPath, "utf8")); }
    catch {
      copyFileSync(hooksPath, hooksPath + ".ares-bak");
      existing = {};
    }
  }
  existing.hooks ||= {};
  const frag = codexHooksFragment(runtimeRoot, includeToolHooks);
  for (const [event, entries] of Object.entries(frag.hooks)) {
    existing.hooks[event] ||= [];
    for (const entry of entries) {
      const matcher = entry.matcher || "";
      const found = existing.hooks[event].find(e => (e.matcher || "") === matcher);
      if (found) {
        found.hooks ||= [];
        for (const hook of entry.hooks || []) {
          if (!found.hooks.some(h => h.command === hook.command)) found.hooks.push(hook);
        }
      } else {
        existing.hooks[event].push(entry);
      }
    }
  }
  writeFileSync(hooksPath, JSON.stringify(existing, null, 2) + "\n");
}

function writeCodexAgentsNoClobber(agentsDir) {
  const srcDir = join(CORE_PAYLOAD, "agents");
  let written = 0, skipped = 0;
  ensureDir(agentsDir);
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const raw = readFileSync(join(srcDir, entry.name), "utf8");
    const { data, body } = parseFrontmatterMarkdown(raw);
    const name = data.name || entry.name.replace(/\.md$/, "");
    const description = data.description || `${name} MISHKAN agent.`;
    const instructions = adaptCodexText(body.trim());
    const originalTier = data.model ? `\n# Original MISHKAN model tier: ${data.model}\n` : "";
    const toml =
      `name = ${tomlString(name)}\n` +
      `description = ${tomlString(description)}\n` +
      `developer_instructions = ${tomlString(instructions)}\n` +
      originalTier;
    if (writeFileIfAbsent(join(agentsDir, `${name}.toml`), toml)) written++;
    else skipped++;
  }
  return { written, skipped };
}

function writeProjectCodex(opts) {
  const root = opts.root;
  writeManagedBlock(
    join(root, "AGENTS.md"),
    "<!-- ARES-HARNESS:BEGIN project-codex -->",
    "<!-- ARES-HARNESS:END project-codex -->",
    projectStateBlock("codex", opts),
  );
  writeProjectCodexConfig(root);
  // Tool hooks are global to avoid duplicate execution when Codex merges user
  // and project hook layers. The project keeps only the indexing lifecycle hook.
  mergeCodexHooks(join(root, ".codex", "hooks.json"), ARES_HOME, false);
  let written = 3, skipped = 0;

  if (!opts.wiringOnly) {
    const agents = writeCodexAgentsNoClobber(join(root, ".codex", "agents"));
    written += agents.written;
    skipped += agents.skipped;
  }
  return { target: "codex", written, skipped };
}

function writeOpenCodeAgentsNoClobber(agentsDir) {
  const srcDir = join(CORE_PAYLOAD, "agents");
  let written = 0, skipped = 0;
  ensureDir(agentsDir);
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const raw = readFileSync(join(srcDir, entry.name), "utf8");
    const { data, body } = parseFrontmatterMarkdown(raw);
    const name = data.name || entry.name.replace(/\.md$/, "");
    const description = data.description || `${name} MISHKAN agent.`;
    const md = `---
description: ${description}
mode: subagent
permission:
  edit: ask
  bash: ask
---

${adaptOpenCodeText(body.trim())}
`;
    if (writeFileIfAbsent(join(agentsDir, `${name}.md`), md)) written++;
    else skipped++;
  }
  return { written, skipped };
}

function writeOpenCodeCommandsNoClobber(commandsDir) {
  let written = 0, skipped = 0;
  ensureDir(commandsDir);
  for (const spec of CODEX_COMMAND_SKILLS) {
    const command = readFileSync(join(CORE_PAYLOAD, "commands", spec.source), "utf8");
    const { data, body } = parseFrontmatterMarkdown(command);
    const description = adaptOpenCodeText(data.description || spec.description).replace(/\n/g, " ");
    const md = `---
description: ${description}
---

${adaptOpenCodeText(body.trim())}
`;
    if (writeFileIfAbsent(join(commandsDir, `${spec.name}.md`), md)) written++;
    else skipped++;
  }
  return { written, skipped };
}

function writeProjectOpenCode(opts) {
  const root = opts.root;
  writeManagedBlock(
    join(root, "AGENTS.md"),
    "<!-- ARES-HARNESS:BEGIN project-opencode -->",
    "<!-- ARES-HARNESS:END project-opencode -->",
    projectStateBlock("opencode", opts),
  );
  mergeJsonConfig(join(root, "opencode.json"), (config) => {
    config.$schema ||= "https://opencode.ai/config.json";
    config.mcp ||= {};
    if (config.mcp.cognee?.url?.includes("__ARES_WORK_PORT__")) delete config.mcp.cognee;
    config.mcp.cognee_memory = {
      type: "remote",
      url: "http://127.0.0.1:7777/mcp",
      enabled: true,
      oauth: false,
    };
    config.mcp.cognee_curated = {
      type: "remote",
      url: "http://127.0.0.1:7730/mcp",
      enabled: true,
      oauth: false,
    };
  });
  let written = 2, skipped = 0;
  if (!opts.wiringOnly) {
    const agents = writeOpenCodeAgentsNoClobber(join(root, ".opencode", "agents"));
    const commands = writeOpenCodeCommandsNoClobber(join(root, ".opencode", "commands"));
    written += agents.written + commands.written;
    skipped += agents.skipped + commands.skipped;
  }
  return { target: "opencode", written, skipped };
}

async function projectCmd(argv) {
  const sub = argv[0] || "init";
  if (sub !== "init") {
    console.error(`usage: ${displayCommand()} project init [--target claude|codex|opencode|all] [--wiring-only] [--dir <path>] [--name <name>] [--stack <hint>]`);
    process.exit(1);
  }
  const rest = argv.slice(1);
  const target = parseTargetOption(rest, "claude");
  const opts = projectInitOptions(rest);
  ensureDir(opts.root);
  writeProjectGitignore(opts.root);
  if (!opts.wiringOnly) writeProjectDocs(opts.root);

  const results = [];
  for (const t of expandTargets(target)) {
    if (t === "claude") results.push(writeProjectClaude(opts));
    else if (t === "codex") results.push(writeProjectCodex(opts));
    else if (t === "opencode") results.push(writeProjectOpenCode(opts));
  }

  log(`project init: ${tilde(opts.root)} (${opts.wiringOnly ? "wiring-only" : "full wiring"})`);
  for (const r of results) {
    log(`${r.target}: wrote/managed=${r.written}, preserved=${r.skipped}`);
  }
  log("stateful workflow not run; start the runtime and invoke the target-native ARES init workflow when ready.");
}

function installCodexSupportFiles(supportDir) {
  ensureDir(join(supportDir, "rules"));
  const profileSrc = existsSync(join(PKG, "docs", "engineer", "profile.md"))
    ? join(PKG, "docs", "engineer", "profile.md")
    : join(PKG, "docs", "engineer", "profile.example.md");
  const profileDst = join(supportDir, "profile.md");
  if (!existsSync(profileDst) && existsSync(profileSrc)) copyFileSync(profileSrc, profileDst);
  copyFileSync(join(PKG, "payload", "user", "rules", "y4nn-standards.md"),
               join(supportDir, "rules", "y4nn-standards.md"));
  const engineerRule = join(supportDir, "rules", "engineer-standards.md");
  if (!existsSync(engineerRule)) {
    copyFileSync(join(PKG, "payload", "user", "rules", "engineer-standards.md"), engineerRule);
  }
}

function writeCodexAgentsMd(codexHome) {
  const src = readFileSync(join(PKG, "payload", "user", "CLAUDE.md"), "utf8");
  const body = `# ARES Harness For Codex

This managed block adapts the current MISHKAN organization to Codex.
ARES is the technical namespace; the team and agent names remain MISHKAN for now.

Codex-native locations installed by \`${displayCommand()} install --target codex\`:

- Global guidance: \`~/.codex/AGENTS.md\`
- Custom agents: \`~/.codex/agents/*.toml\`
- Skills: \`~/.agents/skills/*/SKILL.md\`
- ARES support files: \`~/.codex/ares/\`

Canonical reusable workflow invocation in Codex is through skills:
\`$ares-init\`, \`$ares-resume\`, \`$sprint-close\`, \`$sefer-pull\`, and
\`$dependency-audit\`; \`$promote\` is also provided for the Cognee promotion flow.
Use \`/skills\` to browse and select installed skills. Codex does not expose
user-defined skills as literal \`/<skill-name>\` commands, so \`/ares-init\`
is intentionally reserved for Claude Code and OpenCode.

${adaptCodexText(src)}`;
  writeManagedBlock(
    join(codexHome, "AGENTS.md"),
    "<!-- ARES-HARNESS:BEGIN codex-agents -->",
    "<!-- ARES-HARNESS:END codex-agents -->",
    body,
  );
}

function writeCodexAgents(agentsDir) {
  const srcDir = join(CORE_PAYLOAD, "agents");
  let count = 0;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const raw = readFileSync(join(srcDir, entry.name), "utf8");
    const { data, body } = parseFrontmatterMarkdown(raw);
    const name = data.name || entry.name.replace(/\.md$/, "");
    const description = data.description || `${name} MISHKAN agent.`;
    const instructions = adaptCodexText(body.trim());
    const originalTier = data.model ? `\n# Original MISHKAN model tier: ${data.model}\n` : "";
    const toml =
      `name = ${tomlString(name)}\n` +
      `description = ${tomlString(description)}\n` +
      `developer_instructions = ${tomlString(instructions)}\n` +
      originalTier;
    writeFileSync(join(agentsDir, `${name}.toml`), toml);
    count++;
  }
  return count;
}

function writeCodexMcpConfig(codexHome) {
  const body = `[mcp_servers.cognee_memory]
url = "http://127.0.0.1:7777/mcp"
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 60

[mcp_servers.cognee_curated]
url = "http://127.0.0.1:7730/mcp"
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 60`;
  writeManagedBlock(
    join(codexHome, "config.toml"),
    "# ARES-HARNESS:BEGIN codex-mcp",
    "# ARES-HARNESS:END codex-mcp",
    body,
  );
}

async function installClaudeTarget() {
  const runtimeRoot = ARES_HOME;
  const totalPhases = 7;
  log(`installing Claude target into ${tilde(CLAUDE)} with payload ${tilde(runtimeRoot)}`);
  ensureDir(CLAUDE);

  phase(1, totalPhases, "Payload",
        "copy agents, skills, commands, hooks, rules, cognee compose, observability sources");
  // payload/mishkan -> ~/.ares; Claude receives symlinks into this runtime.
  installAresCorePayload();

  // D-017: place the model-routing overlay once (the engineer's tier overrides).
  // copyDir ships no such file, so it is never clobbered on refresh — place-once,
  // then preserve (same philosophy as engineer-standards.md). `ares model` edits it.
  const overlayPath = join(runtimeRoot, "config", "model-routing.local.yaml");
  if (!existsSync(overlayPath)) {
    ensureDir(join(runtimeRoot, "config"));
    writeFileSync(overlayPath,
      "# ARES model-routing OVERLAY (D-017) — your per-agent tier overrides.\n" +
      "# Preserved across `ares install`. Managed by `ares model set/reset`\n" +
      "# (hand-edits are fine). Entries here WIN over config/model-routing.yaml.\n" +
      "# Empty = no overrides (shipped defaults apply). Tiers: opus, sonnet, haiku, fable.\n\n" +
      "agents: {}\n");
    log("placed model-routing overlay ~/.ares/config/model-routing.local.yaml");
  } else {
    log("preserved your ~/.ares/config/model-routing.local.yaml");
  }

  // D-011 Phase 2: rebuild the universal skill-discovery index at install
  // time so the router has a live index.json before the first session boots.
  // The SessionStart hook keeps it fresh thereafter; this seeds it.
  // Fail-open: a missing python3 or an indexer error is logged and the
  // install continues — the router will surface `index_missing_or_unreadable`
  // on its next call and /ares-skills-reindex is the recovery path.
  const indexerPath = join(runtimeRoot, "scripts", "skill-discovery-indexer.py");
  if (existsSync(indexerPath) && commandExists("python3")) {
    const r = spawnSync("python3", [indexerPath, "--rebuild", "--quiet"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    if (r.status === 0) {
      log("seeded skill-discovery index at ~/.ares/skill-discovery/index.json");
    } else {
      warn(`skill-discovery indexer exited ${r.status ?? "with error"}; install continues. ` +
           `Run /ares-skills-reindex once the harness is available.`);
    }
  } else if (!commandExists("python3")) {
    warn("python3 not found; skipping skill-discovery index seed. " +
         "Install python3 then run /ares-skills-reindex.");
  }

  phase(2, totalPhases, "Engineer profile",
        "place runtime profile — never overwrites an existing edited one");
  const realProfile = join(PKG, "docs", "engineer", "profile.md");
  const exampleProfile = join(PKG, "docs", "engineer", "profile.example.md");
  const runtimeProfile = join(runtimeRoot, "profile.md");
  if (!existsSync(runtimeProfile)) {
    const src = existsSync(realProfile) ? realProfile : exampleProfile;
    if (existsSync(src)) copyFileSync(src, runtimeProfile);
    if (src === exampleProfile) log("placed example profile — edit ~/.ares/profile.md with your details");
  } else {
    log("preserved existing ~/.ares/profile.md");
  }

  phase(3, totalPhases, "User-level rules",
        "refresh harness default; preserve your engineer-standards.md + CLAUDE.md");
  ensureDir(join(CLAUDE, "rules"));
  copyFileSync(join(PKG, "payload", "user", "rules", "y4nn-standards.md"),
               join(CLAUDE, "rules", "y4nn-standards.md"));
  log("refreshed harness default ~/.claude/rules/y4nn-standards.md");
  const engRule = join(CLAUDE, "rules", "engineer-standards.md");
  if (!existsSync(engRule)) copyFileSync(join(PKG, "payload", "user", "rules", "engineer-standards.md"), engRule);
  else log("preserved your ~/.claude/rules/engineer-standards.md");
  const userClaude = join(CLAUDE, "CLAUDE.md");
  if (!existsSync(userClaude)) {
    const userIdentity = adaptClaudeAresText(readFileSync(join(PKG, "payload", "user", "CLAUDE.md"), "utf8"));
    writeFileSync(userClaude, userIdentity);
  }
  else log("preserved existing ~/.claude/CLAUDE.md");

  phase(4, totalPhases, "Discovery symlinks",
        "make agents, skills, commands visible to Claude Code");
  const a = linkInto(runtimeRoot, "agents", join(CLAUDE, "agents"), false);
  const s = linkInto(runtimeRoot, "skills", join(CLAUDE, "skills"), true);
  const cm = linkInto(runtimeRoot, "commands", join(CLAUDE, "commands"), false);
  log(`linked agents=${a.linked} (skipped ${a.skipped}), skills=${s.linked}, commands=${cm.linked}`);

  phase(5, totalPhases, "Hooks",
        "merge ARES hooks into ~/.claude/settings.json (preserves existing)");
  removeHooks();
  mergeHooks(runtimeRoot);
  log("hooks merged into settings.json");

  phase(6, totalPhases, "Stamp",
        "record install version + timestamp for status / uninstall");
  const version = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version;
  writeFileSync(join(runtimeRoot, ".install-stamp"), JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2) + "\n");

  phase(7, totalPhases, "Observability (opt-in)",
        "Python daemon + Textual TUI for live cross-session monitoring");
  if (process.env.ARES_SKIP_OBSERVABILITY || process.env.MISHKAN_SKIP_OBSERVABILITY) {
    console.log(c.dim("        Skipped by ARES_SKIP_OBSERVABILITY/MISHKAN_SKIP_OBSERVABILITY."));
  } else if (await promptYN("        Install observability stack now?", true)) {
    installObservabilityStack();
  } else {
    console.log(c.dim("        Skipped. Re-run later:  npx ares-harness observability install"));
  }

  // Auto-symlink ~/.local/bin/ares plus the legacy mishkan alias so
  // the user gets `ares <subcommand>` directly without `npx` or a
  // global npm install. Skipped (silently) when:
  //   - ~/.local/bin doesn't exist (user didn't opt into local bins)
  //   - the link already exists pointing to a different harness install
  //     (don't clobber another version)
  //   - the link exists pointing to us (idempotent re-run)
  const localBin = join(HOME, ".local", "bin");
  const linkTarget = join(PKG, "bin", "ares.js");
  const linkPath = join(localBin, "ares");
  const legacyLinkTarget = join(PKG, "bin", "mishkan.js");
  const legacyLinkPath = join(localBin, "mishkan");
  let directAccess = "absent";
  if (existsSync(localBin)) {
    if (existsSync(linkPath) || isSymlink(linkPath)) {
      try {
        const current = isSymlink(linkPath) ? readlinkSync(linkPath) : null;
        if (current === linkTarget) {
          directAccess = "linked";
        } else {
          directAccess = "blocked"; // a different file lives at the path
        }
      } catch { directAccess = "blocked"; }
    } else {
      try {
        // Defensive +x — npm publish normally sets this from the package.json
        // `bin` field, but a checkout-from-source flow may not.
        try { const st = statSync(linkTarget); chmodSync(linkTarget, st.mode | 0o111); } catch {}
        symlinkSync(linkTarget, linkPath);
        directAccess = "linked";
        log(`linked ${tilde(linkPath)} -> ${tilde(linkTarget)}`);
        if (!existsSync(legacyLinkPath) && !isSymlink(legacyLinkPath)) {
          try { symlinkSync(legacyLinkTarget, legacyLinkPath); } catch {}
        }
      } catch (e) {
        directAccess = "failed";
        warn(`could not symlink ${tilde(linkPath)}: ${e.message}`);
      }
    }
  }
  const pathHasLocalBin = (process.env.PATH || "").split(":").includes(localBin);

  printBanner(version);

  // Whether the bare `ares` command works yet (symlinked AND on PATH) decides
  // how we spell the commands below — bare, or via the published package.
  const onPath = directAccess === "linked" && pathHasLocalBin;
  const m = onPath ? "ares" : `npx ${PACKAGE_NAME}`;

  console.log();
  console.log("   " + c.green("✓") + c.dim("  It's in place — every agent, rule, skill and command is"));
  console.log(c.dim("      wired into ~/.claude and ready to work."));

  console.log();
  console.log("   " + c.bold(c.cyan("▸ Start here")));
  console.log(c.dim("       Open a Claude session and talk to ") + "Nehemiah" + c.dim(" — your PM —"));
  console.log(c.dim("       or run ") + "/ares-init" + c.dim(" inside a project to scaffold it."));

  console.log();
  console.log("   " + c.bold(c.cyan("▸ Commands")) + (onPath ? c.dim("   on your PATH now — no npx needed") : ""));
  {
    const rows = [
      ["knowledge configure", "LLM provider + cognee secrets"],
      ["knowledge-stack up", "bring the knowledge layer up (guided)"],
      ["status", "install state + live stack health"],
      ["project-work-store up", "this project's own store"],
      ["knowledge ingest docs/…", "add docs to memory"],
      ["observability open", "the live TUI"],
    ];
    const w = Math.max(...rows.map(([s]) => `${m} ${s}`.length)) + 3;
    for (const [s, d] of rows) console.log("       " + `${m} ${s}`.padEnd(w) + c.dim(d));
  }
  if (directAccess === "linked" && !pathHasLocalBin)
    console.log(c.dim("       (add ~/.local/bin to PATH for the bare `ares` command)"));
  else if (directAccess !== "linked")
    console.log(c.dim(`       (for a bare \`ares\`: ln -sf ${linkTarget} ~/.local/bin/ares)`));

  // Knowledge stack (Cognee) is opt-in. The three stores answer three different
  // questions (D-008/D-012) — name each one plainly here, then the two bring-up
  // steps. The wizard + ACCESS.txt carry the full URL/cred detail.
  console.log();
  console.log("   " + c.bold(c.cyan("▸ Knowledge")) + c.dim("   three cognee stores + your code graph — optional, opt-in"));
  console.log("       " + "memory".padEnd(9)  + c.cyan(":7777") + c.dim("   what you learn across your sessions — kept and shared"));
  console.log("       " + "curated".padEnd(9) + c.cyan(":7730") + c.dim("   a reference library you mostly read from"));
  console.log("       " + "work".padEnd(9)    + "     "          + c.dim("this project's private notes — never shared with other"));
  console.log(c.dim("                     projects; created the first time you run /ares-init"));
  console.log("       " + "graphify".padEnd(9) + "     "         + c.dim("this project's code structure — a separate CLI, no server"));
  console.log(c.dim("                     (refresh with `ares code-graph scan`)"));
  console.log();
  console.log(c.dim("       Bring it up — two commands:"));
  console.log(c.dim("         1. ") + `${m} knowledge configure` + c.dim("    → writes .env + ACCESS.txt"));
  console.log(c.dim("         2. ") + `${m} knowledge-stack up`   + c.dim("    → starts memory + curated (~5min first boot)"));
  console.log(c.dim("       Aliases cognee-memory / cognee-curated · full URLs + creds in ACCESS.txt."));
  console.log();
}

function uninstallObservabilityHint() {
  if (commandExists("uv")) {
    console.log(c.dim(
      "  Observability stack installed via uv tool — remove manually if desired:\n" +
      "    uv tool uninstall ares-watch ares-watchd\n" +
      "    # legacy installs only: uv tool uninstall mishkan-watch mishkan-watchd"));
  }
}

function migrateLegacyMishkan() {
  if (!existsSync(LEGACY_HOME)) {
    log(`legacy runtime not found: ${tilde(LEGACY_HOME)}`);
    return;
  }
  if (!existsSync(ARES_HOME)) {
    copyDir(LEGACY_HOME, ARES_HOME);
    log(`migrated legacy runtime ${tilde(LEGACY_HOME)} -> ${tilde(ARES_HOME)}`);
    log("legacy runtime was preserved; remove it later with `ares uninstall --legacy-mishkan`.");
    return;
  }
  const result = copyDirNoClobber(LEGACY_HOME, ARES_HOME);
  log(`merged legacy runtime ${tilde(LEGACY_HOME)} -> ${tilde(ARES_HOME)} without overwriting existing files.`);
  log(`legacy migration copied=${result.copied}, skipped=${result.skipped}; legacy runtime was preserved.`);
}

function uninstallLegacyMishkan({ force = false } = {}) {
  if (!existsSync(LEGACY_HOME)) {
    log(`legacy runtime already absent: ${tilde(LEGACY_HOME)}`);
    return;
  }
  if (!existsSync(ARES_HOME) && !force) {
    console.error(c.red(`refusing to remove ${tilde(LEGACY_HOME)} because ${tilde(ARES_HOME)} does not exist.`));
    console.error(c.dim("Run `ares migrate legacy-mishkan` first, or pass --force if you intentionally want to delete only the legacy runtime."));
    process.exit(1);
  }
  rmSync(LEGACY_HOME, { recursive: true, force: true });
  log(`removed legacy runtime ${tilde(LEGACY_HOME)}.`);
}

function migrateCmd(argv = []) {
  const sub = argv[0];
  if (sub === "legacy-mishkan") {
    migrateLegacyMishkan();
    return;
  }
  console.error("usage: ares migrate legacy-mishkan");
  process.exit(1);
}

function uninstall({ purge = false, legacyMishkan = false, force = false } = {}) {
  if (legacyMishkan) {
    uninstallLegacyMishkan({ force });
    return;
  }
  // remove the ~/.local/bin links if we created them.
  for (const [name, bin] of [["ares", "ares.js"], ["mishkan", "mishkan.js"]]) {
    const localLink = join(HOME, ".local", "bin", name);
    if (isSymlink(localLink)) {
      try {
        const t = readlinkSync(localLink);
        if (t.includes(`/bin/${bin}`)) {
          unlinkSync(localLink);
          log(`removed ${tilde(localLink)}`);
        }
      } catch { /* ignore */ }
    }
  }
  // remove symlinks that point into the harness runtime
  for (const [sub, dirEntries] of [["agents", false], ["commands", false], ["skills", true]]) {
    const dir = join(CLAUDE, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (isSymlink(p)) {
        let t; try { t = readlinkSync(p); } catch { continue; }
        if (isHarnessLinkTarget(t)) {
          unlinkSync(p);
        }
      }
    }
  }
  removeHooks();
  if (existsSync(RUNTIME_HOME)) rmSync(RUNTIME_HOME, { recursive: true, force: true });
  log(`removed ${tilde(RUNTIME_HOME)}, its Claude symlinks, and its hooks.`);
  if (purge) {
    // Remove the harness-maintained default; KEEP the user's engineer-standards
    // and CLAUDE.md (their own work).
    const def = join(CLAUDE, "rules", "y4nn-standards.md");
    if (existsSync(def)) rmSync(def);
    log("purged harness default y4nn-standards.md. Kept your engineer-standards.md and CLAUDE.md.");
  } else {
    log("kept user-level CLAUDE.md, y4nn-standards.md, and engineer-standards.md (use --purge to remove the default).");
  }
  uninstallObservabilityHint();
}

function status(argv = []) {
  const target = parseTargetOption(argv, "claude");
  for (const t of expandTargets(target)) {
    if (t === "claude") statusClaudeTarget();
    else if (t === "codex") statusCodexTarget();
    else if (t === "opencode") statusOpenCodeTarget();
    else statusPendingTarget(t);
  }
}

function statusPendingTarget(target) {
  log(`${target} target adapter: pending (no native files are installed yet; planned home ${tilde(targetHome(target))})`);
}

function statusCodexTarget() {
  const codexHome = targetHome("codex");
  const agentsMd = join(codexHome, "AGENTS.md");
  const agentsDir = join(codexHome, "agents");
  const skillsDir = join(HOME, ".agents", "skills");
  const configPath = join(codexHome, "config.toml");
  const hooksPath = join(codexHome, "hooks.json");
  const aresPayload = existsSync(join(ARES_HOME, "agents")) && existsSync(join(ARES_HOME, "scripts"));
  const agentCount = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter(n => n.endsWith(".toml")).length
    : 0;
  const skillCount = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md"))).length
    : 0;
  const mcp = existsSync(configPath) && readFileSync(configPath, "utf8").includes("ARES-HARNESS:BEGIN codex-mcp");
  let codexHooks = 0;
  const codexHookEvents = new Set();
  if (existsSync(hooksPath)) {
    try {
      const hooks = JSON.parse(readFileSync(hooksPath, "utf8")).hooks || {};
      for (const [event, entries] of Object.entries(hooks)) {
        for (const entry of entries || []) {
          for (const hook of entry.hooks || []) {
            if ((hook.command || "").includes("/.ares/hooks/")) {
              codexHooks++;
              codexHookEvents.add(event);
            }
          }
        }
      }
    } catch {}
  }
  const hooksStatus = codexHooks
    ? `managed(${codexHooks}:${[...codexHookEvents].sort().join(",")})`
    : "missing";
  const toolHooks = codexHookEvents.has("PreToolUse") && codexHookEvents.has("PostToolUse") ? "enabled" : "missing";
  log(`codex target: AGENTS=${existsSync(agentsMd) ? "present" : "missing"}, ares-home=${aresPayload ? tilde(ARES_HOME) : "missing"}, agents=${agentCount}, skills=${skillCount}, mcp=${mcp ? "managed" : "missing"}, hooks=${hooksStatus}, pre/post=${toolHooks}`);
}

function statusOpenCodeTarget() {
  const opencodeHome = targetHome("opencode");
  const agentsMd = join(opencodeHome, "AGENTS.md");
  const agentsDir = join(opencodeHome, "agents");
  const commandsDir = join(opencodeHome, "commands");
  const skillsDir = join(HOME, ".agents", "skills");
  const configPath = join(opencodeHome, "opencode.json");
  const aresPayload = existsSync(join(ARES_HOME, "agents")) && existsSync(join(ARES_HOME, "scripts"));
  const agentCount = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter(n => n.endsWith(".md")).length
    : 0;
  const commandCount = existsSync(commandsDir)
    ? readdirSync(commandsDir).filter(n => n.endsWith(".md")).length
    : 0;
  const skillCount = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md"))).length
    : 0;
  let mcp = false;
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      mcp = Boolean(config.mcp?.cognee_memory && config.mcp?.cognee_curated);
    } catch {}
  }
  log(`opencode target: AGENTS=${existsSync(agentsMd) ? "present" : "missing"}, ares-home=${aresPayload ? tilde(ARES_HOME) : "missing"}, agents=${agentCount}, commands=${commandCount}, shared-skills=${skillCount}, mcp=${mcp ? "managed" : "missing"}, session-hook=${existsSync(join(opencodeHome, "plugins", "ares-session.js")) ? "installed" : "missing"}, tool-hooks=${existsSync(join(opencodeHome, "plugins", "ares-tool-hooks.js")) ? "enabled" : "missing"}`);
}

function statusClaudeTarget() {
  const runtimeRoot = existsSync(join(ARES_HOME, ".install-stamp"))
    ? ARES_HOME
    : existsSync(join(LEGACY_HOME, ".install-stamp"))
      ? LEGACY_HOME
      : RUNTIME_HOME;
  const stamp = join(runtimeRoot, ".install-stamp");
  if (!existsSync(stamp)) { log("not installed."); return; }
  const st = JSON.parse(readFileSync(stamp, "utf8"));
  const count = (sub, dirEntries) => {
    const dir = join(CLAUDE, sub); if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter(n => {
      const p = join(dir, n); if (!isSymlink(p)) return false;
      try { return isHarnessLinkTarget(readlinkSync(p)); } catch { return false; }
    }).length;
  };
  const settingsPath = join(CLAUDE, "settings.json");
  let hooks = 0;
  if (existsSync(settingsPath)) { try {
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    for (const ev of Object.values(s.hooks || {})) for (const e of ev) for (const h of (e.hooks||[]))
      if ((h.command||"").includes("/mishkan/hooks/") || (h.command||"").includes("/.ares/hooks/")) hooks++;
  } catch {} }
  log(`installed v${st.version} (${st.installedAt})`);
  log(`runtime: ${tilde(runtimeRoot)}`);
  log(`linked: agents=${count("agents")}, skills=${count("skills")}, commands=${count("commands")}, hooks=${hooks}`);
  log(`runtime profile: ${existsSync(join(runtimeRoot,"profile.md")) ? "present" : "MISSING"}`);
  log(`cognee dir: ${existsSync(join(runtimeRoot,"cognee")) ? "present" : "missing"}`);
  // Fold in live knowledge-stack health so status answers install + infra in
  // one view; knowledge-stack status is the detail.
  if (existsSync(join(runtimeRoot, "cognee")) && commandExists("docker")) printStackHealth();
}

// ─── runtime diagnostics ──────────────────────────────────────────────────

function commandVersion(cmd) {
  const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
  if (r.status !== 0) return "";
  return (r.stdout || r.stderr || "").trim().split("\n")[0] || "present";
}

function checkFile(path, label, checks) {
  const ok = existsSync(path);
  checks.push({ ok, label, detail: tilde(path) });
  return ok;
}

function checkContains(path, needle, label, checks) {
  const ok = existsSync(path) && readFileSync(path, "utf8").includes(needle);
  checks.push({ ok, label, detail: tilde(path) });
  return ok;
}

function printRuntimeChecks(target, checks, strict) {
  const failed = checks.filter(x => !x.ok);
  log(`${target} runtime check: ${failed.length ? c.yellow(`${failed.length} warning(s)`) : c.green("ok")}`);
  for (const check of checks) {
    const mark = check.ok ? c.green("✓") : c.yellow("!");
    console.log(`  ${mark} ${check.label}${check.detail ? c.dim(` — ${check.detail}`) : ""}`);
  }
  if (strict && failed.length) {
    process.exitCode = 1;
  }
}

function runtimeCheckClaude(strict, projectRoot = null) {
  const checks = [];
  const version = commandVersion("claude");
  checks.push({ ok: Boolean(version), label: `Claude Code CLI ${version || "not found"}` });
  checkFile(join(ARES_HOME, "agents"), "ARES payload agents", checks);
  checkFile(join(CLAUDE, "CLAUDE.md"), "Claude global CLAUDE.md", checks);
  checkFile(join(CLAUDE, "commands", "ares-init.md"), "Claude /ares-init command", checks);
  checkFile(join(CLAUDE, "commands", "mishkan-init.md"), "Claude legacy /mishkan-init alias", checks);
  checkContains(join(CLAUDE, "settings.json"), "/.ares/hooks/", "Claude hooks point at ~/.ares", checks);
  if (projectRoot) {
    checkContains(join(projectRoot, "CLAUDE.md"), "ARES-HARNESS:BEGIN project-claude", "Project Claude CLAUDE.md", checks);
    checkContains(join(projectRoot, ".mcp.json"), "cognee-memory", "Project Claude MCP config", checks);
    checkFile(join(projectRoot, ".claude", "settings.json"), "Project Claude settings", checks);
  }
  printRuntimeChecks("claude", checks, strict);
  console.log(c.dim("  Manual runtime proof: start Claude Code in a target repo and run /ares-init or /ares-resume."));
}

function runtimeCheckCodex(strict, projectRoot = null) {
  const checks = [];
  const version = commandVersion("codex");
  checks.push({ ok: Boolean(version), label: `Codex CLI ${version || "not found"}` });
  const codexHome = targetHome("codex");
  checkContains(join(codexHome, "AGENTS.md"), "ARES Harness For Codex", "Codex global AGENTS.md", checks);
  checkContains(join(codexHome, "config.toml"), "ARES-HARNESS:BEGIN codex-mcp", "Codex managed MCP config", checks);
  checkContains(join(codexHome, "hooks.json"), "session-start-skill-index.sh", "Codex SessionStart hook", checks);
  checkContains(join(codexHome, "hooks.json"), "pre-tool-security.sh", "Codex PreToolUse security hook", checks);
  checkContains(join(codexHome, "hooks.json"), "post-tool-observe.sh", "Codex PostToolUse observability hook", checks);
  checkFile(join(HOME, ".agents", "skills", "ares-init", "SKILL.md"), "Codex skill $ares-init", checks);
  if (projectRoot) {
    checkContains(join(projectRoot, "AGENTS.md"), "ARES-HARNESS:BEGIN project-codex", "Project Codex AGENTS.md", checks);
    checkContains(join(projectRoot, ".codex", "config.toml"), "[mcp_servers.cognee_memory]", "Project Codex MCP config", checks);
    checkContains(join(projectRoot, ".codex", "hooks.json"), "session-start-skill-index.sh", "Project Codex SessionStart hook", checks);
  }
  printRuntimeChecks("codex", checks, strict);
  console.log(c.dim("  Manual runtime proof: start Codex in a target repo and run $ares-init or select ares-init through /skills."));
}

function runtimeCheckOpenCode(strict, projectRoot = null) {
  const checks = [];
  const version = commandVersion("opencode");
  checks.push({ ok: Boolean(version), label: `OpenCode CLI ${version || "not found"}` });
  const opencodeHome = targetHome("opencode");
  checkContains(join(opencodeHome, "AGENTS.md"), "ARES Harness For OpenCode", "OpenCode global AGENTS.md", checks);
  checkFile(join(opencodeHome, "opencode.json"), "OpenCode MCP config", checks);
  checkFile(join(opencodeHome, "commands", "ares-init.md"), "OpenCode /ares-init command", checks);
  checkFile(join(HOME, ".agents", "skills", "ares-init", "SKILL.md"), "Shared ARES skill ares-init", checks);
  checkFile(join(opencodeHome, "plugins", "ares-tool-hooks.js"), "OpenCode tool security/observability plugin", checks);
  checkFile(join(opencodeHome, "agents", "nathan.md"), "OpenCode native agent files", checks);
  checkContains(join(opencodeHome, "plugins", "ares-session.js"), "session.created", "OpenCode session-created plugin", checks);
  if (projectRoot) {
    checkContains(join(projectRoot, "AGENTS.md"), "ARES-HARNESS:BEGIN project-opencode", "Project OpenCode AGENTS.md", checks);
    checkContains(join(projectRoot, "opencode.json"), "cognee_memory", "Project OpenCode MCP config", checks);
    checkFile(join(projectRoot, ".opencode", "commands", "ares-init.md"), "Project OpenCode /ares-init command", checks);
    checkFile(join(projectRoot, ".opencode", "agents", "nathan.md"), "Project OpenCode native agent files", checks);
  }
  printRuntimeChecks("opencode", checks, strict);
  console.log(c.dim("  Manual runtime proof: start OpenCode in a target repo and run /ares-init."));
}

function runtimeCmd(argv = []) {
  const sub = argv[0] || "check";
  if (sub !== "check") {
    console.error(`usage: ${displayCommand()} runtime check [--target claude|codex|opencode|all] [--dir <project>] [--strict]`);
    process.exit(1);
  }
  const rest = argv.slice(1);
  const target = parseTargetOption(rest, "all");
  const strict = rest.includes("--strict");
  const dirRequested = rest.some(arg => arg === "--dir" || arg.startsWith("--dir="));
  const dirValue = optionValue(rest, "--dir", null);
  if (dirRequested && !dirValue) {
    console.error(`usage: ${displayCommand()} runtime check [--target claude|codex|opencode|all] [--dir <project>] [--strict]`);
    process.exit(2);
  }
  const projectRoot = dirValue ? resolve(dirValue) : null;
  if (projectRoot && !existsSync(projectRoot)) {
    console.error(c.red(`project directory not found: ${projectRoot}`));
    process.exit(2);
  }
  for (const t of expandTargets(target)) {
    if (t === "claude") runtimeCheckClaude(strict, projectRoot);
    else if (t === "codex") runtimeCheckCodex(strict, projectRoot);
    else if (t === "opencode") runtimeCheckOpenCode(strict, projectRoot);
  }
}

// ─── org reference ─────────────────────────────────────────────────────────
// ─── code-graph (Graphify) inspection ──────────────────────────────────────
function codeGraphCmd(argv) {
  const sub = argv[0] || "status";
  const cwd = process.cwd();
  const outDir = join(cwd, "graphify-out");
  if (!existsSync(outDir)) {
    console.error(c.red("no code-graph found in this project."));
    console.log("run `graphify update .` from the project root, then retry.");
    process.exit(1);
  }
  const graphJson = join(outDir, "graph.json");
  const graphHtml = join(outDir, "graph.html");
  if (sub === "status") {
    let nodes = 0, edges = 0, lastScan = "?";
    if (existsSync(graphJson)) {
      try {
        const g = JSON.parse(readFileSync(graphJson, "utf8"));
        nodes = (g.nodes || []).length;
        edges = (g.links || g.edges || []).length;
        lastScan = statSync(graphJson).mtime.toISOString().replace("T", " ").slice(0, 19) + " UTC";
      } catch {}
    }
    console.log("");
    console.log("  " + c.bold("code-graph") + "  " + c.dim(tilde(cwd)));
    console.log("");
    console.log("    nodes      " + c.cyan(String(nodes)));
    console.log("    edges      " + c.cyan(String(edges)));
    console.log("    last scan  " + c.dim(lastScan));
    console.log("");
    if (existsSync(graphHtml)) {
      console.log("    " + c.dim("open visualisation:  ") + c.bold("npx ares-harness code-graph open"));
    }
    console.log("    " + c.dim("refresh:             ") + c.bold("npx ares-harness code-graph scan"));
    console.log("");
    return;
  }
  if (sub === "open") {
    if (!existsSync(graphHtml)) {
      console.error("graph.html missing. run `npx ares-harness code-graph scan` first.");
      process.exit(1);
    }
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    const r = spawnSync(opener, [graphHtml], { stdio: "ignore" });
    if (r.status !== 0) {
      console.log("could not auto-open. visualisation at:");
      console.log("  file://" + graphHtml);
    } else {
      console.log(c.green("opened:") + " " + tilde(graphHtml));
    }
    return;
  }
  if (sub === "scan") {
    const r = spawnSync("graphify", ["update", "."], { stdio: "inherit", cwd });
    process.exit(r.status || 0);
  }
  console.error("unknown subcommand: " + sub);
  console.log("use one of: status | open | scan");
  process.exit(1);
}

function printOrgRef({ json = false } = {}) {
  const candidates = [
    join(RUNTIME_HOME, "org", "org.json"),
    join(CORE_PAYLOAD, "org", "org.json"),
  ];
  let data = null;
  for (const p of candidates) {
    if (existsSync(p)) {
      try { data = JSON.parse(readFileSync(p, "utf8")); break; } catch {}
    }
  }
  if (!data) { console.error("org.json not found. Run `npx ares-harness install` first."); process.exit(2); }
  if (json) { console.log(JSON.stringify(data, null, 2)); return; }
  console.log(`\n${c.bold("MISHKAN")} — 45 agents across 8 groups\n`);
  for (const grp of data.groups || []) {
    const dom = grp.domain ? c.cyan(` · ${grp.domain}`) : "";
    console.log(c.bold(grp.label) + dom + c.dim(`  (${(grp.agents||[]).length})`));
    if (grp.hebrew) {
      const meaning = grp.hebrew_meaning ? c.dim(` — ${grp.hebrew_meaning}`) : "";
      console.log("  " + c.cyan(grp.hebrew) + meaning);
    }
    if (grp.mission) console.log("  " + c.dim("mission   ") + grp.mission);
    if (grp.charter) console.log("  " + c.dim("charter   ") + grp.charter);
    if (grp.relationships) console.log("  " + c.dim("links     ") + grp.relationships);
    if (grp.mission || grp.charter || grp.relationships) console.log("");
    for (const ag of grp.agents || []) {
      const alias = ag.alias.charAt(0).toUpperCase() + ag.alias.slice(1);
      console.log("  " + c.bold(alias.padEnd(14)) + c.dim("· ") + ag.role);
      if (ag.description) console.log("    " + c.dim(ag.description));
    }
    console.log("");
  }
  console.log(c.dim(`source: ${data.generated_from || "docs/design/MISHKAN_agent_aliases.md"}`));
}

// ─── backend control surface (ADR D-015) ────────────────────────────────────
// One SEMANTIC control surface for the cognee knowledge layer the engineer
// otherwise drives by hand across scattered compose files + scripts. Every
// command is `mishkan <object> <verb>`. The CLI EXECUTES because the HUMAN
// invokes it — rule 5 forbids *agents* from running stateful ops, not the
// engineer's own tool (agents never get this bin; the TUI only surfaces, never
// runs). Destructive ops gate on a confirm. Wraps the real scripts/compose — it
// does not replace them, so the scripts stay the single source of truth.
const COGNEE_DIR = join(RUNTIME_HOME, "cognee");
const SCRIPTS_DIR = join(RUNTIME_HOME, "scripts");
// knowledge-stack overlay order (base → hardening → selfhosted backends).
const STACK_FILES = ["docker-compose.yml", "docker-compose.hardening.yml", "docker-compose.selfhosted.yml"];
const stackComposeArgs = () => STACK_FILES.flatMap(f => ["-f", f]);

function requireCogneeDir() {
  if (!existsSync(COGNEE_DIR)) {
    console.error(c.red("cognee dir not found: ") + tilde(COGNEE_DIR));
    console.log("run the installer first:  " + c.bold(`${displayCommand()} install`));
    process.exit(1);
  }
}

// Derive a project slug from the current dir (matches the scripts' sanitisation).
function slugFromCwd() {
  return (process.cwd().split("/").pop() || "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Live health of every ares-* or legacy mishkan-* container. Used by `knowledge-stack status`
// and folded into status.
function printStackHealth() {
  const r = spawnSync("docker",
    ["ps", "-a", "--format", "{{.Names}}\t{{.Status}}"],
    { encoding: "utf8" });
  if (r.status !== 0) { console.log("  " + c.dim("(docker not available — knowledge-stack health unknown)")); return; }
  const lines = (r.stdout || "").split("\n").filter(line => {
    const name = line.split("\t")[0] || "";
    return /^(ares|mishkan)-(cognee|curated|ollama|work-)/.test(name);
  }).join("\n").trim();
  console.log("");
  console.log("  " + c.bold("knowledge-stack — containers"));
  console.log("");
  if (!lines) { console.log("    " + c.dim("none up — start it:  ") + c.bold(`${displayCommand()} knowledge-stack up`)); console.log(""); return; }
  for (const line of lines.split("\n")) {
    const [name, ...rest] = line.split("\t");
    const status = rest.join(" ");
    const dot = /unhealthy/.test(status) ? c.yellow("⚠")
              : /Exited|Created|Dead|Restarting/.test(status) ? c.red("✗")
              : c.green("●");
    console.log("    " + dot + " " + (name || "").padEnd(28) + c.dim(status));
  }
  console.log("");
}

// Preflight: what's missing before the knowledge-stack can come up. Each gap
// carries a one-line fix, so `up` never dumps a cryptic docker error — it tells
// you what to finish and stops, instead of failing halfway.
function preflightStack() {
  const gaps = [];
  if (!commandExists("docker")) {
    gaps.push(["Docker isn't available on PATH", "install Docker and start the daemon, then re-run"]);
  }
  const env = join(COGNEE_DIR, ".env");
  if (!existsSync(env)) {
    gaps.push(["cognee .env not configured (LLM provider + local secrets)",
               "run " + c.bold(`${displayCommand()} knowledge configure`)]);
  } else {
    let txt = ""; try { txt = readFileSync(env, "utf8"); } catch {}
    if (!/^\s*COGNEE_MCP_REF=\S/m.test(txt)) {
      gaps.push(["COGNEE_MCP_REF (pinned cognee image tag) not set in cognee/.env",
                 "run " + c.bold(`${displayCommand()} knowledge configure`)]);
    }
  }
  return gaps;
}

function guideGaps(gaps, retryCmd) {
  console.log(c.yellow("\n  Not ready yet — finish setup first:\n"));
  gaps.forEach(([problem, fix], i) => {
    console.log("  " + c.bold(`${i + 1}. ${problem}`));
    console.log("     " + c.dim("→ ") + fix + "\n");
  });
  console.log("  Then re-run " + c.bold(retryCmd) + ".\n");
}

async function stackUp(opts) {
  requireCogneeDir();
  const gaps = preflightStack();
  if (gaps.length) { guideGaps(gaps, `${displayCommand()} knowledge-stack up`); process.exit(1); }
  const build = opts.has("--build");
  const args = ["compose", ...stackComposeArgs(), "up", "-d"];
  if (build) args.push("--build");
  log("starting the knowledge-stack" + (build ? " (rebuilding image — first build only)…" : "…"));
  const r = spawnSync("docker", args, { stdio: "inherit", cwd: COGNEE_DIR, env: knowledgeEnv() });
  if (r.status !== 0) { warn("knowledge-stack up failed"); process.exit(r.status || 1); }
  log("ensuring the curated reference box…");
  spawnSync("bash", [join(SCRIPTS_DIR, "ensure-curated-box.sh")], { stdio: "inherit", cwd: COGNEE_DIR, env: knowledgeEnv() });
  const cmd = displayCommand();
  console.log(c.green("\n✓ knowledge-stack up.") + c.dim("  First boot is slow (~4-5 min) — check with ") + c.bold(`${cmd} status`) + c.dim("."));
  console.log("  Then you can:");
  console.log("    " + c.bold(`${cmd} project-work-store up`)   + c.dim("   provision this project's private store"));
  console.log("    " + c.bold(`${cmd} knowledge ingest docs/…`) + c.dim("   add documents to memory"));
  console.log("    " + c.bold(`${cmd} observability open`)      + c.dim("       watch it live\n"));
}

async function stackDown({ confirm = true } = {}) {
  requireCogneeDir();
  if (confirm) {
    const ok = await promptYN("Stop the knowledge-stack? Containers stop; volumes/data survive.", false);
    if (!ok) { console.log("aborted."); return; }
  }
  spawnSync("docker", ["compose", ...stackComposeArgs(), "down"], { stdio: "inherit", cwd: COGNEE_DIR, env: knowledgeEnv() });
  // The curated box is its own compose project — bring it down too.
  if (existsSync(join(COGNEE_DIR, ".env.curated"))) {
    spawnSync("docker", ["compose", "--env-file", ".env.curated", "-f", "docker-compose.curated.yml", "down"],
              { stdio: "inherit", cwd: COGNEE_DIR, env: knowledgeEnv() });
  }
  console.log(c.green("✓ knowledge-stack stopped.") + c.dim(`  (project work stores are separate — \`${displayCommand()} project-work-store down\`)`));
}

async function knowledgeStackCmd(argv) {
  const sub = argv[0] || "status";
  const opts = new Set(argv.slice(1));
  if (sub === "status") { requireCogneeDir(); printStackHealth(); return; }
  if (sub === "up") { await stackUp(opts); return; }
  if (sub === "down") { await stackDown({ confirm: true }); return; }
  if (sub === "restart") { await stackDown({ confirm: false }); await stackUp(opts); return; }
  console.error("unknown subcommand: " + sub);
  console.log("use one of: up [--build] | down | restart | status");
  process.exit(1);
}

function knowledgeIngest(argv) {
  const script = join(SCRIPTS_DIR, "mishkan-ingest.sh");
  if (!existsSync(script)) { console.error(c.red(`mishkan-ingest.sh not found — run \`${displayCommand()} install\` first.`)); process.exit(1); }
  // Run in the user's CWD: the script derives the project store from basename($PWD).
  const r = spawnSync("bash", [script, ...argv], { stdio: "inherit", cwd: process.cwd(), env: knowledgeEnv() });
  process.exit(r.status || 0);
}

// D-016 — engineer-gated promotion of research-found resources into the shared
// curated library. Baruch queues candidates (one JSON object per line) into
// ~/.ares/curated-candidates.jsonl; this walks them, asks per candidate,
// and on approval runs the ADDITIVE promote-curated.sh (no prune, dedup by url).
// Stateful by design — a human runs this CLI; agents never get the bin (rule 5).
async function knowledgeCurate() {
  const queue = join(RUNTIME_HOME, "curated-candidates.jsonl");
  if (!existsSync(queue)) {
    console.log("No pending curated-library candidates.");
    console.log(c.dim("  Baruch queues them here when a resolved research run finds a reusable,"));
    console.log(c.dim("  not-yet-curated resource: " + tilde(queue)));
    return;
  }
  const lines = readFileSync(queue, "utf8").split("\n").map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) { console.log("No pending curated-library candidates."); return; }
  const script = join(SCRIPTS_DIR, "promote-curated.sh");
  if (!existsSync(script)) { console.error(c.red(`promote-curated.sh not found — run \`${displayCommand()} install\` first.`)); process.exit(1); }

  const tmp = join(COGNEE_DIR, ".curate-candidate.json");
  const remaining = [];                 // kept for retry (e.g. container down)
  let approved = 0, rejected = 0;
  const processedOut = [];
  for (const line of lines) {
    let cand;
    try { cand = JSON.parse(line); }
    catch { console.error(c.red("skipping malformed queue line: ") + line.slice(0, 80)); continue; }
    console.log();
    console.log(c.bold(cand.name || "(unnamed)") + c.dim("   [" + (cand.team || "?") + " · " + (cand.problem_class || "?") + "]"));
    console.log("  " + (cand.url || c.red("(no url)")));
    if (cand.why) console.log(c.dim("  why: " + cand.why));
    const ok = await promptYN("Promote this into the shared curated library?", false);
    if (!ok) { rejected++; processedOut.push(JSON.stringify({ ...cand, decision: "rejected" })); console.log(c.dim("  rejected — nothing written.")); continue; }
    writeFileSync(tmp, JSON.stringify(cand) + "\n");
    const r = spawnSync("bash", [script, tmp], { stdio: "inherit", env: knowledgeEnv() });
    if (r.status === 0) { approved++; processedOut.push(JSON.stringify({ ...cand, decision: "approved" })); }
    else { console.error(c.red("  promotion failed (see above) — kept in the queue for retry.")); remaining.push(line); }
  }
  try { if (existsSync(tmp)) rmSync(tmp); } catch { /* best-effort cleanup */ }
  // Rewrite the queue with only the lines kept for retry; record decisions durably.
  writeFileSync(queue, remaining.length ? remaining.join("\n") + "\n" : "");
  if (processedOut.length) {
    const log = join(RUNTIME_HOME, "curated-candidates.processed.jsonl");
    const prev = existsSync(log) ? readFileSync(log, "utf8") : "";
    writeFileSync(log, prev + processedOut.join("\n") + "\n");
  }
  console.log();
  console.log(c.green(`curate: ${approved} approved, ${rejected} rejected`) + (remaining.length ? c.dim(`, ${remaining.length} kept for retry`) : ""));
}

// D-017 cleanup — full reset of the knowledge layer to the stable baseline.
// Wipes all work stores, prunes cognee-memory, re-seeds curated. Stateful
// (docker rm / docker exec): the human runs it; the script type-to-confirms.
function knowledgeReset(argv) {
  const script = join(SCRIPTS_DIR, "reset-knowledge-data.sh");
  if (!existsSync(script)) { console.error(c.red(`reset-knowledge-data.sh not found — run \`${displayCommand()} install\` first.`)); process.exit(1); }
  warn("FULL knowledge-data reset — wipes all work stores, prunes memory, re-seeds curated to baseline.");
  const r = spawnSync("bash", [script, ...argv], { stdio: "inherit", env: knowledgeEnv() });
  process.exit(r.status || 0);
}

async function knowledgeCmd(argv) {
  const sub = argv[0];
  if (sub === "configure") { await configureKnowledge(); return; }
  if (sub === "ingest") { knowledgeIngest(argv.slice(1)); return; }
  if (sub === "curate") { await knowledgeCurate(); return; }
  if (sub === "reset") { knowledgeReset(argv.slice(1)); return; }
  console.error(`usage: ${displayCommand()} knowledge <configure | ingest [paths…] | curate | reset>`);
  console.log("  configure          wizard: LLM provider + cognee secrets");
  console.log("  ingest [paths…]    add docs to THIS project's store");
  console.log("  curate             review + approve research-found resources into the shared curated library (D-016)");
  console.log("  reset              wipe all stores → re-seed curated to the stable baseline (destructive; confirms)");
  process.exit(1);
}

async function projectWorkStoreCmd(argv) {
  requireCogneeDir();
  const VERBS = new Set(["up", "down", "reset"]);
  let slug, sub;
  if (argv.length >= 2 && VERBS.has(argv[1])) { slug = argv[0]; sub = argv[1]; }
  else if (argv.length === 1 && VERBS.has(argv[0])) { slug = slugFromCwd(); sub = argv[0]; }
  else { console.error(`usage: ${displayCommand()} project-work-store [<slug>] <up|down|reset>`); process.exit(1); }
  if (!slug) { console.error("could not derive a project slug from the current directory; pass one explicitly."); process.exit(1); }
  const preferredContainer = `ares-work-${slug}`;
  const legacyContainer = `mishkan-work-${slug}`;
  const container = preferExistingDockerName(preferredContainer, legacyContainer);
  const volume = `${container}_work_data`;
  if (sub === "up") {
    const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
    if (ps.status === 0 && !/(ares|mishkan)-(ollama|cognee-mcp)/.test(ps.stdout || "")) {
      warn("the knowledge-stack looks down — start it first:  " + c.bold(`${displayCommand()} knowledge-stack up`));
    }
    const r = spawnSync("bash", [join(SCRIPTS_DIR, "ensure-work-store.sh"), slug], { stdio: "inherit", cwd: COGNEE_DIR, env: knowledgeEnv() });
    if (r.status === 0) console.log(c.green(`✓ work store '${slug}' up.`) + c.dim("  add docs: ") + c.bold(`${displayCommand()} knowledge ingest docs/…`));
    process.exit(r.status || 0);
  }
  if (sub === "down") {
    log(`removing ${container} (data volume ${volume} kept)…`);
    const r = spawnSync("docker", ["rm", "-f", container], { stdio: "inherit" });
    process.exit(r.status || 0);
  }
  if (sub === "reset") {
    const ok = await promptYN(`RESET ${slug}? Removes ${container} AND wipes its data volume ${volume}.`, false);
    if (!ok) { console.log("aborted."); return; }
    spawnSync("docker", ["rm", "-f", container], { stdio: "inherit" });
    const vr = spawnSync("docker", ["volume", "rm", volume], { stdio: "inherit" });
    if (vr.status !== 0) warn(`volume ${volume} not removed (already gone?)`);
    console.log(c.green(`✓ ${slug} reset.`) + c.dim("  re-provision: ") + c.bold(`${displayCommand()} project-work-store ${slug} up`));
    return;
  }
  // unreachable given the VERBS guard above — explicit so a future verb can't fall through silently
  console.error("internal error: unexpected project-work-store verb: " + sub);
  process.exit(1);
}

function openWatchTui(argv) {
  const watchBin = commandExists("ares-watch") ? "ares-watch" :
    (commandExists("mishkan-watch") ? "mishkan-watch" : null);
  if (!watchBin) {
    console.error(c.red("ares-watch not on PATH."));
    console.log("install it:  " + c.bold("ares observability install"));
    process.exit(1);
  }
  const r = spawnSync(watchBin, argv, { stdio: "inherit" });
  process.exit(r.status || 0);
}

function observabilityCmd(argv) {
  const sub = argv[0] || "install";
  if (sub === "install") { installObservabilityStack(); return; }
  if (sub === "open") { openWatchTui(argv.slice(1)); return; }
  console.error(`usage: ${displayCommand()} observability <install | open>`);
  process.exit(1);
}

function orgCmd(argv) {
  const sub = argv[0] || "show";
  if (sub === "show") { printOrgRef({ json: argv.includes("--json") }); return; }
  console.error(`usage: ${displayCommand()} org show [--json]`);
  process.exit(1);
}

// D-017 — user-editable model-tier routing. The hook (hooks/model-route.py) reads
// the shipped default (config/model-routing.yaml) then overlays the engineer's
// overrides (config/model-routing.local.yaml, preserved across installs). This
// command edits ONLY the overlay — never the shipped default, never the 45
// agent frontmatter files. So defaults keep flowing on update while your deltas persist.
const ROUTING_DEFAULT_RUNTIME = join(RUNTIME_HOME, "config", "model-routing.yaml");
const ROUTING_DEFAULT_PAYLOAD = join(CORE_PAYLOAD, "config", "model-routing.yaml");
const ROUTING_DEFAULT = existsSync(ROUTING_DEFAULT_RUNTIME) ? ROUTING_DEFAULT_RUNTIME : ROUTING_DEFAULT_PAYLOAD;
const ROUTING_LOCAL = join(RUNTIME_HOME, "config", "model-routing.local.yaml");
const ORG_JSON_RUNTIME = join(RUNTIME_HOME, "org", "org.json");
const ORG_JSON_PAYLOAD = join(CORE_PAYLOAD, "org", "org.json");
const ORG_JSON = existsSync(ORG_JSON_RUNTIME) ? ORG_JSON_RUNTIME : ORG_JSON_PAYLOAD;
const TIERS = new Set(["opus", "sonnet", "haiku", "fable"]);
const DORMANT_TIERS = new Set(["fable"]); // valid but currently unavailable (Fable 5 suspended 2026-06-12)

// Minimal reader matching hooks/model-route.py parse_routing: agents map + default tier.
function readRouting(path) {
  const agents = {};
  let dflt = "sonnet", section = null;
  if (!existsSync(path)) return { agents, dflt };
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.split("#")[0].replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (!/^[ \t]/.test(line)) { section = line.trim().replace(/:$/, ""); continue; }
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!val) continue;
    if (section === "defaults" && key === "unlisted_agent" && TIERS.has(val)) dflt = val;
    else if (section === "agents" && TIERS.has(val)) agents[key] = val;
  }
  return { agents, dflt };
}

function writeOverlay(map) {
  const keys = Object.keys(map).sort();
  let out =
    "# ARES model-routing OVERLAY (D-017) — your per-agent tier overrides.\n" +
    "# Preserved across `ares install`. Managed by `ares model set/reset`\n" +
    "# (hand-edits are fine). Same shape as model-routing.yaml; entries here WIN\n" +
    "# over the shipped default. Empty = no overrides. Tiers: opus, sonnet, haiku, fable.\n\n";
  out += keys.length ? "agents:\n" + keys.map(k => `  ${k}: ${map[k]}`).join("\n") + "\n" : "agents: {}\n";
  ensureDir(dirname(ROUTING_LOCAL));
  writeFileSync(ROUTING_LOCAL, out);
}

function allMishkanAgents() { return Object.keys(readRouting(ROUTING_DEFAULT).agents).sort(); }

function teamAgents(teamId) {
  if (!existsSync(ORG_JSON)) return null;
  let org; try { org = JSON.parse(readFileSync(ORG_JSON, "utf8")); } catch { return null; }
  const t = teamId.toLowerCase();
  for (const g of (org.groups || [])) {
    if ((g.id || "").toLowerCase() === t || (g.label || "").toLowerCase() === t) {
      return (g.agents || []).map(a => (typeof a === "string" ? a : a.alias)).filter(Boolean);
    }
  }
  return null;
}

// Resolve <agent|team|all> to a list of known MISHKAN agent aliases.
function resolveTargets(target, all) {
  if (target === "all") return all;
  if (all.includes(target)) return [target];
  const team = teamAgents(target);
  if (team && team.length) return team.filter(a => all.includes(a));
  return null;
}

async function modelCmd(argv) {
  const sub = argv[0] || "show";
  const def = readRouting(ROUTING_DEFAULT);
  const overlay = readRouting(ROUTING_LOCAL).agents;

  if (sub === "show") {
    const cmd = displayCommand();
    const names = allMishkanAgents();
    if (names.length === 0) { console.error(c.red(`no model-routing.yaml found — run \`${cmd} install\` first.`)); process.exit(1); }
    const nOver = Object.keys(overlay).length;
    console.log(c.bold("ARES model-tier routing") + c.dim("   " + (nOver ? nOver + " override(s)" : "no overrides — shipped defaults")));
    let dormantSeen = false;
    for (const n of names) {
      const eff = overlay[n] || def.agents[n];
      const overridden = overlay[n] && overlay[n] !== def.agents[n];
      const dormant = DORMANT_TIERS.has(eff);
      if (dormant) dormantSeen = true;
      const mark = overridden ? c.bold("  ←override (was " + def.agents[n] + ")") : "";
      const warnTxt = dormant ? c.red("  ⚠ DORMANT — " + eff + " unavailable, will fail to spawn") : "";
      console.log("  " + n.padEnd(12) + " " + eff.padEnd(7) + mark + warnTxt);
    }
    console.log(c.dim(`\n  set:  ${cmd} model set <agent|team|all> <tier>   ·   revert:  ${cmd} model reset [target]`));
    if (dormantSeen) console.log(c.red(`  ⚠ agent(s) route to a dormant tier — re-tier them (${cmd} model set …) or restore access.`));
    return;
  }

  if (!existsSync(ROUTING_DEFAULT_RUNTIME)) {
    console.error(c.red(`model overrides require an installed runtime — run \`${displayCommand()} install\` first.`));
    process.exit(1);
  }

  if (sub === "set") {
    const target = argv[1], tier = argv[2];
    if (!target || !tier) { console.error(`usage: ${displayCommand()} model set <agent|team|all> <tier>`); process.exit(1); }
    if (!TIERS.has(tier)) { console.error(c.red(`invalid tier '${tier}' — valid: opus, sonnet, haiku, fable`)); process.exit(1); }
    const all = allMishkanAgents();
    const targets = resolveTargets(target, all);
    if (!targets) { console.error(c.red(`unknown agent or team '${target}'.`) + c.dim(`  see: ${displayCommand()} model show / ${displayCommand()} org show`)); process.exit(1); }
    if (DORMANT_TIERS.has(tier)) {
      warn(`'${tier}' is DORMANT — Claude Fable 5 was suspended 2026-06-12; agents routed here will fail to spawn.`);
      const ok = await promptYN(`Route ${targets.length} agent(s) to '${tier}' anyway?`, false);
      if (!ok) { console.log("aborted."); return; }
    }
    for (const a of targets) overlay[a] = tier;
    writeOverlay(overlay);
    console.log(c.green(`✓ set ${targets.length} agent(s) → ${tier}`) + c.dim("   overlay: " + tilde(ROUTING_LOCAL)));
    console.log(c.dim("  live on the next delegation (hook reads the overlay) · survives `ares install`."));
    return;
  }

  if (sub === "reset") {
    const target = argv[1];
    if (!target) {
      const n = Object.keys(overlay).length;
      if (n === 0) { console.log("no overrides to reset."); return; }
      const ok = await promptYN(`Clear ALL ${n} routing override(s) — revert the whole fleet to shipped defaults?`, false);
      if (!ok) { console.log("aborted."); return; }
      writeOverlay({});
      console.log(c.green(`✓ cleared ${n} override(s) — fleet back to shipped defaults.`));
      return;
    }
    const all = allMishkanAgents();
    const targets = target === "all" ? Object.keys(overlay) : (resolveTargets(target, all) || []);
    let removed = 0;
    for (const a of targets) if (overlay[a]) { delete overlay[a]; removed++; }
    writeOverlay(overlay);
    console.log(removed ? c.green(`✓ reset ${removed} override(s) → shipped default.`) : `no overrides on '${target}'.`);
    return;
  }

  console.error(`usage: ${displayCommand()} model <show | set <agent|team|all> <tier> | reset [agent|team|all]>`);
  console.log("  show                  effective tier per agent (shipped default + your overrides)");
  console.log("  set <target> <tier>   override a tier — target is an agent alias, a team id, or 'all'");
  console.log("  reset [target]        drop override(s); no target = clear them all");
  console.log("  tiers: opus · sonnet · haiku · fable" + c.dim(" (fable dormant — suspended 2026-06-12)"));
  process.exit(1);
}

const cmd = process.argv[2];
const flags = new Set(process.argv.slice(3));
switch (cmd) {
  // self-management — object is the harness itself (bare verbs; `npx ares-harness <verb>`)
  case "install": await install(process.argv.slice(3)); break;
  case "uninstall": uninstall({ purge: flags.has("--purge"), legacyMishkan: flags.has("--legacy-mishkan"), force: flags.has("--force") }); break;
  case "migrate": migrateCmd(process.argv.slice(3)); break;
  case "status": status(process.argv.slice(3)); break;
  // subsystems — mishkan <object> <verb>
  case "knowledge": await knowledgeCmd(process.argv.slice(3)); break;
  case "knowledge-stack": await knowledgeStackCmd(process.argv.slice(3)); break;
  case "project": await projectCmd(process.argv.slice(3)); break;
  case "project-work-store": await projectWorkStoreCmd(process.argv.slice(3)); break;
  case "code-graph": codeGraphCmd(process.argv.slice(3)); break;
  case "observability": observabilityCmd(process.argv.slice(3)); break;
  case "runtime": runtimeCmd(process.argv.slice(3)); break;
  case "org": orgCmd(process.argv.slice(3)); break;
  case "model": await modelCmd(process.argv.slice(3)); break;
  // deprecated flat aliases — kept working (not advertised) so nothing breaks mid-migration
  case "configure-knowledge": await knowledgeCmd(["configure"]); break;
  case "ingest": knowledgeIngest(process.argv.slice(3)); break;
  case "watch": openWatchTui(process.argv.slice(3)); break;
  case "org-ref": orgCmd(["show", ...(flags.has("--json") ? ["--json"] : [])]); break;
  case "help": case "--help": case "-h":
    printHelp(); break;
  default:
    printHelp(); break;
}

// Help / usage — always shows. The command examples follow the entrypoint used
// by the engineer: `ares` for the new namespace, `mishkan` only as legacy.
function printHelp() {
  const command = displayCommand();
  const link = join(HOME, ".local", "bin", command);
  let direct = false;
  if (isSymlink(link)) {
    try {
      const t = readlinkSync(link);
      direct = t === join(PKG, "bin", `${command}.js`) || t === join(PKG, "bin", "mishkan.js");
    } catch { direct = false; }
  }
  const prefix = command;
  const pkgVersion = (() => {
    try { return JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version; } catch { return "?"; }
  })();
  console.log("");
  console.log(c.bold(`${command === BRAND ? "ARES" : "MISHKAN"} harness  v${pkgVersion}`));
  console.log("");
  if (isLegacyInvocation()) {
    console.log(c.yellow(`  ${legacyWarning()}.`));
    console.log(c.dim(`  Published package: ${PACKAGE_NAME}. Legacy package name was ${LEGACY_PACKAGE_NAME}.`));
  } else if (direct) {
    console.log(c.dim(`  Direct access detected: ~/.local/bin/${command} -> bin/${command}.js`));
  } else {
    console.log(c.dim(`  npm package: ${PACKAGE_NAME}. Use: npx ${PACKAGE_NAME} <command>`));
  }
  console.log("");
  console.log(c.bold("Manage the harness"));
  console.log("  " + c.bold(`${prefix} install [--target claude|codex|opencode|all]`) + "  Install / refresh target files");
  console.log("  " + c.bold(`${prefix} project init [--target claude|codex|opencode|all]`) + "  Scaffold target-native project wiring");
  console.log("  " + c.bold(`${prefix} uninstall [--purge]`) + "                         Remove Claude target files");
  console.log("  " + c.bold(`${prefix} migrate legacy-mishkan`) + "                    Copy ~/.claude/mishkan into ~/.ares without deleting it");
  console.log("  " + c.bold(`${prefix} uninstall --legacy-mishkan`) + "              Remove only the old ~/.claude/mishkan runtime after migration");
  console.log("  " + c.bold(`${prefix} status [--target claude|codex|opencode|all]`)  + "   Install state + target health");
  console.log("  " + c.bold(`${prefix} runtime check [--target ...] [--dir <project>]`) + "  Non-destructive global/project readiness checklist");
  console.log("  " + c.dim("Target note: Claude, Codex, and OpenCode are active with their safe target-native hook adapters."));
  console.log("");
  console.log(c.bold("Knowledge") + c.dim("   (you run these — agents never do)"));
  console.log("  " + c.bold(`${prefix} knowledge configure`)       + "        Wizard: LLM provider + cognee secrets");
  console.log("  " + c.bold(`${prefix} knowledge ingest [paths…]`) + "  Add docs to THIS project's store");
  console.log("  " + c.bold(`${prefix} knowledge-stack up|down|restart|status`) + "  The shared running infra (up = guided)");
  console.log("  " + c.bold(`${prefix} knowledge reset`)             + "  Wipe all stores → re-seed curated baseline (destructive)");
  console.log("  " + c.bold(`${prefix} project-work-store [<slug>] up|down|reset`) + "  A project's own store");
  console.log("");
  console.log(c.bold("Inspect / observe"));
  console.log("  " + c.bold(`${prefix} code-graph status|open|scan`)  + "      The project's code graph (Graphify)");
  console.log("  " + c.bold(`${prefix} observability install|open`)   + "      The live monitor (daemon + TUI)");
  console.log("  " + c.bold(`${prefix} org show [--json]`)            + "           The 45-agent reference");
  console.log("  " + c.bold(`${prefix} model show|set|reset`)          + "        Re-tier agents (per-agent/team/all) — survives updates");
  console.log("  " + c.dim("(the TUI binary is ") + c.bold("ares-watch") + c.dim("; `ares-watchd start|stop|status` for manual daemon control)"));
  console.log("");
  console.log(c.bold("Inside a Claude Code session"));
  console.log("  " + c.dim("Talk to Nehemiah (PM) in plain language — exploration mode is the default."));
  console.log("  " + c.dim("Slash commands available after install:"));
  console.log("    " + c.bold("/ares-init")              + "                               Spec chain on a new project (PRD → SRS → CONTRACT → …)");
  console.log("    " + c.bold("/ares-resume")            + "                             Resume sprint state + open blockers");
  console.log("    " + c.bold("/sprint-close")           + "                            Reporters → aggregate → docs pull → graph promote");
  console.log("    " + c.bold("/code-graph") + " status|open|scan" + "         Inspect / open / refresh the Graphify graph");
  console.log("    " + c.bold("/skills")                 + " <task description>          Skill-discovery router — 3-bucket result");
  console.log("    " + c.bold("/ares-skills-reindex") + "                     Rebuild the universal skill index");
  console.log("    " + c.bold("/ares-skills-misses")  + "                      Aggregate miss-log signal for skill-discovery tuning");
  console.log("    " + c.bold("/ares-org-reference")  + "                      Print the 45-agent reference inline");
  console.log("    " + c.bold("/eval-baruch")            + "                             Run the Baruch contract eval (schema + golden case)");
  console.log("    " + c.bold("/dependency-audit")        + "                        Cross-project dependency + supply-chain audit");
  console.log("    " + c.bold("/promote")                + "                                 Promote a learning into Cognee by blast radius");
  console.log("    " + c.bold("/sefer-pull")             + "                              Trigger a documentation pull");
  console.log("  " + c.dim("Legacy aliases remain available for now: /mishkan-init, /mishkan-resume, /dep-audit."));
  console.log("");
  console.log(c.dim("  Docs: docs/usage/  ·  Decisions: docs/design/MISHKAN_decisions.md"));
  console.log(c.dim("  Repo: https://github.com/Y4NN777/mishkan-cc-harness"));
  console.log("");
}
