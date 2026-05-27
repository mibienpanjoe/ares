#!/usr/bin/env node
// MISHKAN installer — dependency-free (Node >=18, built-ins only).
// Commands: install | uninstall | status
//
// Portability by design: every path is resolved from os.homedir() at runtime.
// No machine-specific paths are baked in. Idempotent: re-running install updates
// in place. Never clobbers user-edited files (CLAUDE.md, rules, real agents).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
         copyFileSync, lstatSync, readlinkSync, symlinkSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const HOME = homedir();
const CLAUDE = join(HOME, ".claude");
const MISHKAN = join(CLAUDE, "mishkan");
const STAMP = join(MISHKAN, ".install-stamp");

const log = (...a) => console.log("mishkan:", ...a);
const warn = (...a) => console.warn("mishkan: WARN", ...a);

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

function install() {
  log(`installing into ${tilde(CLAUDE)} (home resolved at runtime)`);
  ensureDir(CLAUDE);
  // 1. payload/mishkan -> ~/.claude/mishkan
  copyDir(join(PKG, "payload", "mishkan"), MISHKAN);
  ensureDir(join(MISHKAN, "logs"));
  ensureDir(join(MISHKAN, "cognee"));
  // 2. engineer profile -> runtime. Prefer a real (gitignored) profile.md if the
  // engineer made one; otherwise ship the sanitized example. Never overwrite an
  // existing runtime profile the engineer may have edited in place.
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
  // 3. user-level files
  ensureDir(join(CLAUDE, "rules"));
  // y4nn-standards.md is the harness-maintained DEFAULT — always refreshed so
  // updates flow. Customisation lives in engineer-standards.md instead.
  copyFileSync(join(PKG, "payload", "user", "rules", "y4nn-standards.md"),
               join(CLAUDE, "rules", "y4nn-standards.md"));
  log("refreshed harness default ~/.claude/rules/y4nn-standards.md");
  // engineer-standards.md is the USER's layer — placed once, never overwritten.
  const engRule = join(CLAUDE, "rules", "engineer-standards.md");
  if (!existsSync(engRule)) copyFileSync(join(PKG, "payload", "user", "rules", "engineer-standards.md"), engRule);
  else log("preserved your ~/.claude/rules/engineer-standards.md");
  // user CLAUDE.md — placed once, never overwritten.
  const userClaude = join(CLAUDE, "CLAUDE.md");
  if (!existsSync(userClaude)) copyFileSync(join(PKG, "payload", "user", "CLAUDE.md"), userClaude);
  else log("preserved existing ~/.claude/CLAUDE.md");
  // 4. symlinks for discovery
  const a = linkInto("agents", join(CLAUDE, "agents"), false);
  const s = linkInto("skills", join(CLAUDE, "skills"), true);
  const c = linkInto("commands", join(CLAUDE, "commands"), false);
  log(`linked agents=${a.linked} (skipped ${a.skipped}), skills=${s.linked}, commands=${c.linked}`);
  // 5. hooks
  mergeHooks();
  log("hooks merged into settings.json (existing hooks preserved)");
  // 6. stamp
  const version = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version;
  writeFileSync(STAMP, JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2) + "\n");
  log(`installed v${version}. Run a Claude session and talk to Nehemiah, or /mishkan-init in a project.`);
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
  case "install": install(); break;
  case "uninstall": uninstall({ purge: flags.has("--purge") }); break;
  case "status": status(); break;
  default:
    console.log(`MISHKAN harness installer
Usage:
  npx mishkan-harness install      Install/refresh into ~/.claude (idempotent)
  npx mishkan-harness status       Show install state
  npx mishkan-harness uninstall    Remove harness (keeps your CLAUDE.md & rules)
  npx mishkan-harness uninstall --purge   Also remove user-level rule`);
}
