#!/usr/bin/env node
// MISHKAN installer — dependency-free (Node >=18, built-ins only).
// Commands: install | uninstall | status | observability
//
// Portability by design: every path is resolved from os.homedir() at runtime.
// No machine-specific paths are baked in. Idempotent: re-running install updates
// in place. Never clobbers user-edited files (CLAUDE.md, rules, real agents).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
         copyFileSync, lstatSync, readlinkSync, symlinkSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const HOME = homedir();
const CLAUDE = join(HOME, ".claude");
const MISHKAN = join(CLAUDE, "mishkan");
const STAMP = join(MISHKAN, ".install-stamp");

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

const log = (...a) => console.log("mishkan:", ...a);
const warn = (...a) => console.warn("mishkan: " + c.yellow("WARN"), ...a);

// Print a phase header with a one-line "why" subtitle. Helps the engineer
// see what each step does and why, instead of an unstructured wall of logs.
function phase(n, total, title, why) {
  console.log();
  console.log(c.bold(c.cyan(`[${n}/${total}] ${title}`)));
  if (why) console.log(c.dim(`        ${why}`));
}

function ensureDir(d) { mkdirSync(d, { recursive: true }); }

function copyDir(src, dst, skip = new Set()) {
  ensureDir(dst);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const s = join(src, entry.name), d = join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d, skip);
    else if (entry.isFile()) copyFileSync(s, d);
  }
}

// Symlink every entry of mishkanSub into claudeSub as a relative link.
// Skip names that already exist as a NON-symlink real file (preserve user's).
function linkInto(mishkanSub, claudeSub, dirEntries = false) {
  ensureDir(claudeSub);
  const srcDir = join(MISHKAN, mishkanSub);
  if (!existsSync(srcDir)) return { linked: 0, skipped: 0 };
  let linked = 0, skipped = 0;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const isDir = entry.isDirectory();
    if (dirEntries !== isDir) continue;           // dirs for skills, files for agents/commands
    if (!dirEntries && !entry.name.endsWith(".md")) continue;
    const linkPath = join(claudeSub, entry.name);
    const target = relative(claudeSub, join(srcDir, entry.name));
    if (existsSync(linkPath) || isSymlink(linkPath)) {
      if (isSymlink(linkPath)) { rmSync(linkPath); }
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
function mergeHooks() {
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
  const resolve = (s) => s.replaceAll("{{MISHKAN}}", MISHKAN);
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
  const isMishkan = (h) => (h.command || "").includes("/mishkan/hooks/");
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = settings.hooks[event]
      .map(e => ({ ...e, hooks: (e.hooks || []).filter(h => !isMishkan(h)) }))
      .filter(e => (e.hooks || []).length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

// ─── tool availability + interactive prompt ────────────────────────────────

function commandExists(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which",
                      [cmd], { stdio: "ignore" });
  return r.status === 0;
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

// ─── observability opt-in (Phase 1.5 of the install contract, §10 of doc) ──

function installObservabilityStack() {
  console.log();
  console.log(c.bold(c.cyan("Observability stack")));
  console.log(c.dim(
    "  Optional cross-session daemon + TUI client that aggregates the event\n" +
    "  bus into a live snapshot. Read docs/design/MISHKAN_observability.md.\n" +
    "  Requires `uv` (https://astral.sh/uv) and Python 3.11+."));

  if (!commandExists("uv")) {
    console.log(c.yellow("  uv not found — skipping observability install."));
    console.log(c.dim(
      "  Install uv with:\n" +
      "    curl -LsSf https://astral.sh/uv/install.sh | sh\n" +
      "  Then re-run:  npx mishkan-harness observability"));
    return { installed: false, reason: "uv-missing" };
  }

  const watchdSrc = join(PKG, "payload", "mishkan", "observability", "watchd");
  const watchSrc  = join(PKG, "payload", "mishkan", "observability", "watch");
  for (const dir of [watchdSrc, watchSrc]) {
    if (!existsSync(dir)) {
      warn(`observability source missing: ${tilde(dir)}`);
      return { installed: false, reason: "payload-missing" };
    }
  }

  console.log(c.dim("  Installing mishkan-watchd (daemon)…"));
  const r1 = spawnSync("uv", ["tool", "install", "--from", watchdSrc, "mishkan-watchd"],
                       { stdio: "inherit" });
  if (r1.status !== 0) { warn("mishkan-watchd install failed"); return { installed: false, reason: "install-failed" }; }

  console.log(c.dim("  Installing mishkan-watch (TUI client)…"));
  const r2 = spawnSync("uv", ["tool", "install", "--from", watchSrc, "mishkan-watch"],
                       { stdio: "inherit" });
  if (r2.status !== 0) { warn("mishkan-watch install failed"); return { installed: false, reason: "install-failed" }; }

  console.log(c.green("  ✓ observability stack installed"));
  console.log(c.dim(
    "  Start the daemon:  " + c.bold("mishkan-watchd start") + "\n" +
    "  Open the TUI:      " + c.bold("mishkan-watch") + "\n" +
    "  Auto-start unit:   mishkan-watchd install-service"));
  return { installed: true };
}

async function install() {
  const totalPhases = 7;
  log(`installing into ${tilde(CLAUDE)} (home resolved at runtime)`);
  ensureDir(CLAUDE);

  phase(1, totalPhases, "Payload",
        "copy agents, skills, commands, hooks, rules, cognee compose, observability sources");
  // 1. payload/mishkan -> ~/.claude/mishkan
  copyDir(join(PKG, "payload", "mishkan"), MISHKAN);
  ensureDir(join(MISHKAN, "logs"));
  ensureDir(join(MISHKAN, "cognee"));
  phase(2, totalPhases, "Engineer profile",
        "place runtime profile — never overwrites an existing edited one");
  const realProfile = join(PKG, "docs", "engineer", "profile.md");
  const exampleProfile = join(PKG, "docs", "engineer", "profile.example.md");
  const runtimeProfile = join(MISHKAN, "profile.md");
  if (!existsSync(runtimeProfile)) {
    const src = existsSync(realProfile) ? realProfile : exampleProfile;
    if (existsSync(src)) copyFileSync(src, runtimeProfile);
    if (src === exampleProfile) log("placed example profile — edit ~/.claude/mishkan/profile.md with your details");
  } else {
    log("preserved existing ~/.claude/mishkan/profile.md");
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
  if (!existsSync(userClaude)) copyFileSync(join(PKG, "payload", "user", "CLAUDE.md"), userClaude);
  else log("preserved existing ~/.claude/CLAUDE.md");

  phase(4, totalPhases, "Discovery symlinks",
        "make agents, skills, commands visible to Claude Code");
  const a = linkInto("agents", join(CLAUDE, "agents"), false);
  const s = linkInto("skills", join(CLAUDE, "skills"), true);
  const cm = linkInto("commands", join(CLAUDE, "commands"), false);
  log(`linked agents=${a.linked} (skipped ${a.skipped}), skills=${s.linked}, commands=${cm.linked}`);

  phase(5, totalPhases, "Hooks",
        "merge MISHKAN hooks into ~/.claude/settings.json (preserves existing)");
  mergeHooks();
  log("hooks merged into settings.json");

  phase(6, totalPhases, "Stamp",
        "record install version + timestamp for status / uninstall");
  const version = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version;
  writeFileSync(STAMP, JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2) + "\n");

  phase(7, totalPhases, "Observability (opt-in)",
        "Python daemon + Textual TUI for live cross-session monitoring");
  if (await promptYN("        Install observability stack now?", true)) {
    installObservabilityStack();
  } else {
    console.log(c.dim("        Skipped. Re-run later:  npx mishkan-harness observability"));
  }

  console.log();
  console.log(c.green(`✓ MISHKAN v${version} installed.`));
  console.log(c.dim(
    "  Run a Claude session and talk to Nehemiah, or /mishkan-init in a project.\n" +
    "  Status:           npx mishkan-harness status\n" +
    "  Re-add obs stack: npx mishkan-harness observability"));
}

function uninstallObservabilityHint() {
  if (commandExists("uv")) {
    console.log(c.dim(
      "  Observability stack installed via uv tool — remove manually if desired:\n" +
      "    uv tool uninstall mishkan-watch mishkan-watchd"));
  }
}

function uninstall({ purge = false } = {}) {
  // remove symlinks that point into mishkan
  for (const [sub, dirEntries] of [["agents", false], ["commands", false], ["skills", true]]) {
    const dir = join(CLAUDE, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (isSymlink(p)) {
        let t; try { t = readlinkSync(p); } catch { continue; }
        if (t.includes("mishkan/")) rmSync(p);
      }
    }
  }
  removeHooks();
  if (existsSync(MISHKAN)) rmSync(MISHKAN, { recursive: true, force: true });
  log("removed ~/.claude/mishkan, its symlinks, and its hooks.");
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

function status() {
  if (!existsSync(STAMP)) { log("not installed."); return; }
  const st = JSON.parse(readFileSync(STAMP, "utf8"));
  const count = (sub, dirEntries) => {
    const dir = join(CLAUDE, sub); if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter(n => {
      const p = join(dir, n); if (!isSymlink(p)) return false;
      try { return readlinkSync(p).includes("mishkan/"); } catch { return false; }
    }).length;
  };
  const settingsPath = join(CLAUDE, "settings.json");
  let hooks = 0;
  if (existsSync(settingsPath)) { try {
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    for (const ev of Object.values(s.hooks || {})) for (const e of ev) for (const h of (e.hooks||[]))
      if ((h.command||"").includes("/mishkan/hooks/")) hooks++;
  } catch {} }
  log(`installed v${st.version} (${st.installedAt})`);
  log(`linked: agents=${count("agents")}, skills=${count("skills")}, commands=${count("commands")}, mishkan hooks=${hooks}`);
  log(`runtime profile: ${existsSync(join(MISHKAN,"profile.md")) ? "present" : "MISSING"}`);
  log(`cognee dir: ${existsSync(join(MISHKAN,"cognee")) ? "present (deploy the container to activate the graph)" : "missing"}`);
}

const cmd = process.argv[2];
const flags = new Set(process.argv.slice(3));
switch (cmd) {
  case "install": await install(); break;
  case "uninstall": uninstall({ purge: flags.has("--purge") }); break;
  case "status": status(); break;
  case "observability": installObservabilityStack(); break;
  default:
    console.log(`MISHKAN harness installer
Usage:
  npx mishkan-harness install          Install/refresh into ~/.claude (idempotent)
  npx mishkan-harness observability    Install only the observability stack (daemon + TUI, needs uv)
  npx mishkan-harness status           Show install state
  npx mishkan-harness uninstall        Remove harness (keeps your CLAUDE.md & rules)
  npx mishkan-harness uninstall --purge   Also remove user-level rule`);
}
