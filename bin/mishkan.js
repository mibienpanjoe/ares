#!/usr/bin/env node
// MISHKAN installer — dependency-free (Node >=18, built-ins only).
// Commands: install | uninstall | status | observability
//
// Portability by design: every path is resolved from os.homedir() at runtime.
// No machine-specific paths are baked in. Idempotent: re-running install updates
// in place. Never clobbers user-edited files (CLAUDE.md, rules, real agents).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
         copyFileSync, lstatSync, readlinkSync, symlinkSync, rmSync, statSync,
         chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { randomBytes } from "node:crypto";

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

// ─── tool availability + interactive prompts ──────────────────────────────

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
  const targetDir = join(MISHKAN, "cognee");
  const exampleEnv = join(targetDir, ".env.example");
  const targetEnv = join(targetDir, ".env");

  console.log();
  console.log(c.bold(c.cyan("Configure the knowledge stack")));
  console.log(c.dim(
    "  Writes ~/.claude/mishkan/cognee/.env (0600, gitignored).\n" +
    "  Sets the LLM provider + keys, generates neo4j + postgres + admin\n" +
    "  passwords on a fresh install, preserves them on a re-run so an\n" +
    "  initialised neo4j volume keeps working."));

  if (!existsSync(targetDir)) {
    warn("cognee dir missing. Run `mishkan-harness install` first.");
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

  const final = `# Generated by 'mishkan knowledge configure' on ${new Date().toISOString()}
# Profile: ${profile.name}
# Re-run \`mishkan knowledge configure\` to switch providers (secrets preserved).

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
  console.log(`  Per-project work   ${c.dim("provisioned per project at /mishkan-init (own port, embedded Ladybug) — ADR D-012")}`);
  console.log(`  Curated · MCP      ${c.cyan("http://127.0.0.1:7730/mcp")}`);
  console.log(`  Curated · Graph    ${c.cyan("http://127.0.0.1:7734")}`);
  console.log(`  Curated · Neo4j    ${c.cyan("http://127.0.0.1:7731")}`);
  console.log(`  Curated · REST     ${c.cyan("http://127.0.0.1:7733")}`);
  if (profile.name.includes("Ollama")) {
    console.log(`  Ollama             ${c.cyan("http://127.0.0.1:11434")}   ${c.dim("local LLM / embeddings")}`);
  }
  console.log();
  console.log(c.bold("Bring up the knowledge stack:"));
  console.log(c.dim("  mishkan knowledge-stack up") + c.dim("   (guided: preflights config, then memory :7777 + curated :7730)"));
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

  return `MISHKAN — Cognee access guide
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
/mishkan-init — ADR D-012. This box is no longer the project work store.

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
default (set by 'mishkan knowledge configure'). The compose stack reads .env.curated
for the curated containers — re-run 'mishkan knowledge configure' to sync both.
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

Container  : mishkan-cognee-pg
Database   : cognee
Password   : ${secrets.DB_PASSWORD}
Reachable  : from inside the docker network only.

To open psql for debugging:
  docker exec -it mishkan-cognee-pg psql -U cognee -d cognee
  (use the password above)

${sep}
Re-running this wizard
${sep}

  mishkan knowledge configure     (or: npx mishkan-harness knowledge configure)

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
      "  Then re-run:  npx mishkan-harness observability install"));
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

  console.log("   " + c.green("✓ observability installed") + c.dim("   ·   1 executable: mishkan-watch"));
  console.log(c.dim(
    "       Open the TUI       mishkan-watch   (auto-starts the daemon)\n" +
    "       Two-terminal       mishkan-watchd start, then  mishkan-watch --no-autostart\n" +
    "       Stop the daemon    mishkan-watchd stop\n" +
    "       Start at login     mishkan-watchd install-service"));
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

  // D-017: place the model-routing overlay once (the engineer's tier overrides).
  // copyDir ships no such file, so it is never clobbered on refresh — place-once,
  // then preserve (same philosophy as engineer-standards.md). `mishkan model` edits it.
  const overlayPath = join(MISHKAN, "config", "model-routing.local.yaml");
  if (!existsSync(overlayPath)) {
    ensureDir(join(MISHKAN, "config"));
    writeFileSync(overlayPath,
      "# MISHKAN model-routing OVERLAY (D-017) — your per-agent tier overrides.\n" +
      "# Preserved across `mishkan install`. Managed by `mishkan model set/reset`\n" +
      "# (hand-edits are fine). Entries here WIN over config/model-routing.yaml.\n" +
      "# Empty = no overrides (shipped defaults apply). Tiers: opus, sonnet, haiku, fable.\n\n" +
      "agents: {}\n");
    log("placed model-routing overlay ~/.claude/mishkan/config/model-routing.local.yaml");
  } else {
    log("preserved your ~/.claude/mishkan/config/model-routing.local.yaml");
  }

  // D-011 Phase 2: rebuild the universal skill-discovery index at install
  // time so the router has a live index.json before the first session boots.
  // The SessionStart hook keeps it fresh thereafter; this seeds it.
  // Fail-open: a missing python3 or an indexer error is logged and the
  // install continues — the router will surface `index_missing_or_unreadable`
  // on its next call and /mishkan-skills-reindex is the recovery path.
  const indexerPath = join(MISHKAN, "scripts", "skill-discovery-indexer.py");
  if (existsSync(indexerPath) && commandExists("python3")) {
    const r = spawnSync("python3", [indexerPath, "--rebuild", "--quiet"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    if (r.status === 0) {
      log("seeded skill-discovery index at ~/.claude/mishkan/skill-discovery/index.json");
    } else {
      warn(`skill-discovery indexer exited ${r.status ?? "with error"}; install continues. ` +
           `Run /mishkan-skills-reindex once the harness is available.`);
    }
  } else if (!commandExists("python3")) {
    warn("python3 not found; skipping skill-discovery index seed. " +
         "Install python3 then run /mishkan-skills-reindex.");
  }

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
    console.log(c.dim("        Skipped. Re-run later:  npx mishkan-harness observability install"));
  }

  // Auto-symlink ~/.local/bin/mishkan -> this package's bin/mishkan.js so
  // the user gets `mishkan <subcommand>` directly without `npx` or a
  // global npm install. Skipped (silently) when:
  //   - ~/.local/bin doesn't exist (user didn't opt into local bins)
  //   - the link already exists pointing to a different mishkan install
  //     (don't clobber another version)
  //   - the link exists pointing to us (idempotent re-run)
  const localBin = join(HOME, ".local", "bin");
  const linkTarget = join(PKG, "bin", "mishkan.js");
  const linkPath = join(localBin, "mishkan");
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
      } catch (e) {
        directAccess = "failed";
        warn(`could not symlink ${tilde(linkPath)}: ${e.message}`);
      }
    }
  }
  const pathHasLocalBin = (process.env.PATH || "").split(":").includes(localBin);

  printBanner(version);

  // Whether the bare `mishkan` command works yet (symlinked AND on PATH) decides
  // how we spell the commands below — bare, or via `npx mishkan-harness`.
  const onPath = directAccess === "linked" && pathHasLocalBin;
  const m = onPath ? "mishkan" : "npx mishkan-harness";

  console.log();
  console.log("   " + c.green("✓") + c.dim("  It's in place — every agent, rule, skill and command is"));
  console.log(c.dim("      wired into ~/.claude and ready to work."));

  console.log();
  console.log("   " + c.bold(c.cyan("▸ Start here")));
  console.log(c.dim("       Open a Claude session and talk to ") + "Nehemiah" + c.dim(" — your PM —"));
  console.log(c.dim("       or run ") + "/mishkan-init" + c.dim(" inside a project to scaffold it."));

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
    console.log(c.dim("       (add ~/.local/bin to PATH for the bare `mishkan` command)"));
  else if (directAccess !== "linked")
    console.log(c.dim(`       (for a bare \`mishkan\`: ln -sf ${linkTarget} ~/.local/bin/mishkan)`));

  // Knowledge stack (Cognee) is opt-in. The three stores answer three different
  // questions (D-008/D-012) — name each one plainly here, then the two bring-up
  // steps. The wizard + ACCESS.txt carry the full URL/cred detail.
  console.log();
  console.log("   " + c.bold(c.cyan("▸ Knowledge")) + c.dim("   three cognee stores + your code graph — optional, opt-in"));
  console.log("       " + "memory".padEnd(9)  + c.cyan(":7777") + c.dim("   what you learn across your sessions — kept and shared"));
  console.log("       " + "curated".padEnd(9) + c.cyan(":7730") + c.dim("   a reference library you mostly read from"));
  console.log("       " + "work".padEnd(9)    + "     "          + c.dim("this project's private notes — never shared with other"));
  console.log(c.dim("                     projects; created the first time you run /mishkan-init"));
  console.log("       " + "graphify".padEnd(9) + "     "         + c.dim("this project's code structure — a separate CLI, no server"));
  console.log(c.dim("                     (refresh with `mishkan code-graph scan`)"));
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
      "    uv tool uninstall mishkan-watch mishkan-watchd"));
  }
}

function uninstall({ purge = false } = {}) {
  // remove the ~/.local/bin/mishkan symlink if we created it (it points
  // at this package's bin/mishkan.js).
  const localLink = join(HOME, ".local", "bin", "mishkan");
  if (isSymlink(localLink)) {
    try {
      const t = readlinkSync(localLink);
      if (t.includes("/bin/mishkan.js")) {
        rmSync(localLink);
        log(`removed ${tilde(localLink)}`);
      }
    } catch { /* ignore */ }
  }
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
  log(`cognee dir: ${existsSync(join(MISHKAN,"cognee")) ? "present" : "missing"}`);
  // Fold in live knowledge-stack health so `mishkan status` answers "how's mishkan"
  // (install + infra) in one view; `mishkan knowledge-stack status` is the detail.
  if (existsSync(join(MISHKAN, "cognee")) && commandExists("docker")) printStackHealth();
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
      console.log("    " + c.dim("open visualisation:  ") + c.bold("npx mishkan-harness code-graph open"));
    }
    console.log("    " + c.dim("refresh:             ") + c.bold("npx mishkan-harness code-graph scan"));
    console.log("");
    return;
  }
  if (sub === "open") {
    if (!existsSync(graphHtml)) {
      console.error("graph.html missing. run `npx mishkan-harness code-graph scan` first.");
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
    join(MISHKAN, "org", "org.json"),
    join(PKG, "payload", "mishkan", "org", "org.json"),
  ];
  let data = null;
  for (const p of candidates) {
    if (existsSync(p)) {
      try { data = JSON.parse(readFileSync(p, "utf8")); break; } catch {}
    }
  }
  if (!data) { console.error("org.json not found. Run `npx mishkan-harness install` first."); process.exit(2); }
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
const COGNEE_DIR = join(MISHKAN, "cognee");
const SCRIPTS_DIR = join(MISHKAN, "scripts");
// knowledge-stack overlay order (base → hardening → selfhosted backends).
const STACK_FILES = ["docker-compose.yml", "docker-compose.hardening.yml", "docker-compose.selfhosted.yml"];
const stackComposeArgs = () => STACK_FILES.flatMap(f => ["-f", f]);

function requireCogneeDir() {
  if (!existsSync(COGNEE_DIR)) {
    console.error(c.red("cognee dir not found: ") + tilde(COGNEE_DIR));
    console.log("run the installer first:  " + c.bold("mishkan install"));
    process.exit(1);
  }
}

// Derive a project slug from the current dir (matches the scripts' sanitisation).
function slugFromCwd() {
  return (process.cwd().split("/").pop() || "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Live health of every mishkan-* container. Used by `knowledge-stack status`
// and folded into `mishkan status`.
function printStackHealth() {
  const r = spawnSync("docker",
    ["ps", "-a", "--filter", "name=mishkan-", "--format", "{{.Names}}\t{{.Status}}"],
    { encoding: "utf8" });
  if (r.status !== 0) { console.log("  " + c.dim("(docker not available — knowledge-stack health unknown)")); return; }
  const lines = (r.stdout || "").trim();
  console.log("");
  console.log("  " + c.bold("knowledge-stack — containers"));
  console.log("");
  if (!lines) { console.log("    " + c.dim("none up — start it:  ") + c.bold("mishkan knowledge-stack up")); console.log(""); return; }
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
               "run " + c.bold("mishkan knowledge configure")]);
  } else {
    let txt = ""; try { txt = readFileSync(env, "utf8"); } catch {}
    if (!/^\s*COGNEE_MCP_REF=\S/m.test(txt)) {
      gaps.push(["COGNEE_MCP_REF (pinned cognee image tag) not set in cognee/.env",
                 "run " + c.bold("mishkan knowledge configure")]);
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
  if (gaps.length) { guideGaps(gaps, "mishkan knowledge-stack up"); process.exit(1); }
  const build = opts.has("--build");
  const args = ["compose", ...stackComposeArgs(), "up", "-d"];
  if (build) args.push("--build");
  log("starting the knowledge-stack" + (build ? " (rebuilding image — first build only)…" : "…"));
  const r = spawnSync("docker", args, { stdio: "inherit", cwd: COGNEE_DIR });
  if (r.status !== 0) { warn("knowledge-stack up failed"); process.exit(r.status || 1); }
  log("ensuring the curated reference box…");
  spawnSync("bash", [join(SCRIPTS_DIR, "ensure-curated-box.sh")], { stdio: "inherit", cwd: COGNEE_DIR });
  console.log(c.green("\n✓ knowledge-stack up.") + c.dim("  First boot is slow (~4-5 min) — check with ") + c.bold("mishkan status") + c.dim("."));
  console.log("  Then you can:");
  console.log("    " + c.bold("mishkan project-work-store up")   + c.dim("   provision this project's private store"));
  console.log("    " + c.bold("mishkan knowledge ingest docs/…") + c.dim("   add documents to memory"));
  console.log("    " + c.bold("mishkan observability open")      + c.dim("       watch it live\n"));
}

async function stackDown({ confirm = true } = {}) {
  requireCogneeDir();
  if (confirm) {
    const ok = await promptYN("Stop the knowledge-stack? Containers stop; volumes/data survive.", false);
    if (!ok) { console.log("aborted."); return; }
  }
  spawnSync("docker", ["compose", ...stackComposeArgs(), "down"], { stdio: "inherit", cwd: COGNEE_DIR });
  // The curated box is its own compose project — bring it down too.
  if (existsSync(join(COGNEE_DIR, ".env.curated"))) {
    spawnSync("docker", ["compose", "--env-file", ".env.curated", "-f", "docker-compose.curated.yml", "down"],
              { stdio: "inherit", cwd: COGNEE_DIR });
  }
  console.log(c.green("✓ knowledge-stack stopped.") + c.dim("  (project work stores are separate — `mishkan project-work-store down`)"));
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
  if (!existsSync(script)) { console.error(c.red("mishkan-ingest.sh not found — run `mishkan install` first.")); process.exit(1); }
  // Run in the user's CWD: the script derives the project store from basename($PWD).
  const r = spawnSync("bash", [script, ...argv], { stdio: "inherit", cwd: process.cwd() });
  process.exit(r.status || 0);
}

// D-016 — engineer-gated promotion of research-found resources into the shared
// curated library. Baruch queues candidates (one JSON object per line) into
// ~/.claude/mishkan/curated-candidates.jsonl; this walks them, asks per candidate,
// and on approval runs the ADDITIVE promote-curated.sh (no prune, dedup by url).
// Stateful by design — a human runs this CLI; agents never get the bin (rule 5).
async function knowledgeCurate() {
  const queue = join(MISHKAN, "curated-candidates.jsonl");
  if (!existsSync(queue)) {
    console.log("No pending curated-library candidates.");
    console.log(c.dim("  Baruch queues them here when a resolved research run finds a reusable,"));
    console.log(c.dim("  not-yet-curated resource: " + tilde(queue)));
    return;
  }
  const lines = readFileSync(queue, "utf8").split("\n").map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) { console.log("No pending curated-library candidates."); return; }
  const script = join(SCRIPTS_DIR, "promote-curated.sh");
  if (!existsSync(script)) { console.error(c.red("promote-curated.sh not found — run `mishkan install` first.")); process.exit(1); }

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
    const r = spawnSync("bash", [script, tmp], { stdio: "inherit" });
    if (r.status === 0) { approved++; processedOut.push(JSON.stringify({ ...cand, decision: "approved" })); }
    else { console.error(c.red("  promotion failed (see above) — kept in the queue for retry.")); remaining.push(line); }
  }
  try { if (existsSync(tmp)) rmSync(tmp); } catch { /* best-effort cleanup */ }
  // Rewrite the queue with only the lines kept for retry; record decisions durably.
  writeFileSync(queue, remaining.length ? remaining.join("\n") + "\n" : "");
  if (processedOut.length) {
    const log = join(MISHKAN, "curated-candidates.processed.jsonl");
    const prev = existsSync(log) ? readFileSync(log, "utf8") : "";
    writeFileSync(log, prev + processedOut.join("\n") + "\n");
  }
  console.log();
  console.log(c.green(`curate: ${approved} approved, ${rejected} rejected`) + (remaining.length ? c.dim(`, ${remaining.length} kept for retry`) : ""));
}

async function knowledgeCmd(argv) {
  const sub = argv[0];
  if (sub === "configure") { await configureKnowledge(); return; }
  if (sub === "ingest") { knowledgeIngest(argv.slice(1)); return; }
  if (sub === "curate") { await knowledgeCurate(); return; }
  console.error("usage: mishkan knowledge <configure | ingest [paths…] | curate>");
  console.log("  configure          wizard: LLM provider + cognee secrets");
  console.log("  ingest [paths…]    add docs to THIS project's store");
  console.log("  curate             review + approve research-found resources into the shared curated library (D-016)");
  process.exit(1);
}

async function projectWorkStoreCmd(argv) {
  requireCogneeDir();
  const VERBS = new Set(["up", "down", "reset"]);
  let slug, sub;
  if (argv.length >= 2 && VERBS.has(argv[1])) { slug = argv[0]; sub = argv[1]; }
  else if (argv.length === 1 && VERBS.has(argv[0])) { slug = slugFromCwd(); sub = argv[0]; }
  else { console.error("usage: mishkan project-work-store [<slug>] <up|down|reset>"); process.exit(1); }
  if (!slug) { console.error("could not derive a project slug from the current directory; pass one explicitly."); process.exit(1); }
  const container = `mishkan-work-${slug}`;
  const volume = `${container}_work_data`;
  if (sub === "up") {
    const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
    if (ps.status === 0 && !/mishkan-ollama|mishkan-cognee-mcp/.test(ps.stdout || "")) {
      warn("the knowledge-stack looks down — start it first:  " + c.bold("mishkan knowledge-stack up"));
    }
    const r = spawnSync("bash", [join(SCRIPTS_DIR, "ensure-work-store.sh"), slug], { stdio: "inherit", cwd: COGNEE_DIR });
    if (r.status === 0) console.log(c.green(`✓ work store '${slug}' up.`) + c.dim("  add docs: ") + c.bold("mishkan knowledge ingest docs/…"));
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
    console.log(c.green(`✓ ${slug} reset.`) + c.dim("  re-provision: ") + c.bold(`mishkan project-work-store ${slug} up`));
    return;
  }
  // unreachable given the VERBS guard above — explicit so a future verb can't fall through silently
  console.error("internal error: unexpected project-work-store verb: " + sub);
  process.exit(1);
}

function openWatchTui(argv) {
  if (!commandExists("mishkan-watch")) {
    console.error(c.red("mishkan-watch not on PATH."));
    console.log("install it:  " + c.bold("mishkan observability install"));
    process.exit(1);
  }
  const r = spawnSync("mishkan-watch", argv, { stdio: "inherit" });
  process.exit(r.status || 0);
}

function observabilityCmd(argv) {
  const sub = argv[0] || "install";
  if (sub === "install") { installObservabilityStack(); return; }
  if (sub === "open") { openWatchTui(argv.slice(1)); return; }
  console.error("usage: mishkan observability <install | open>");
  process.exit(1);
}

function orgCmd(argv) {
  const sub = argv[0] || "show";
  if (sub === "show") { printOrgRef({ json: argv.includes("--json") }); return; }
  console.error("usage: mishkan org show [--json]");
  process.exit(1);
}

// D-017 — user-editable model-tier routing. The hook (hooks/model-route.py) reads
// the shipped default (config/model-routing.yaml) then overlays the engineer's
// overrides (config/model-routing.local.yaml, preserved across installs). This
// command edits ONLY the overlay — never the shipped default, never the 45
// agent frontmatter files. So defaults keep flowing on update while your deltas persist.
const ROUTING_DEFAULT = join(MISHKAN, "config", "model-routing.yaml");
const ROUTING_LOCAL = join(MISHKAN, "config", "model-routing.local.yaml");
const ORG_JSON = join(MISHKAN, "org", "org.json");
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
    "# MISHKAN model-routing OVERLAY (D-017) — your per-agent tier overrides.\n" +
    "# Preserved across `mishkan install`. Managed by `mishkan model set/reset`\n" +
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
    const names = allMishkanAgents();
    if (names.length === 0) { console.error(c.red("no model-routing.yaml found — run `mishkan install` first.")); process.exit(1); }
    const nOver = Object.keys(overlay).length;
    console.log(c.bold("MISHKAN model-tier routing") + c.dim("   " + (nOver ? nOver + " override(s)" : "no overrides — shipped defaults")));
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
    console.log(c.dim("\n  set:  mishkan model set <agent|team|all> <tier>   ·   revert:  mishkan model reset [target]"));
    if (dormantSeen) console.log(c.red("  ⚠ agent(s) route to a dormant tier — re-tier them (mishkan model set …) or restore access."));
    return;
  }

  if (sub === "set") {
    const target = argv[1], tier = argv[2];
    if (!target || !tier) { console.error("usage: mishkan model set <agent|team|all> <tier>"); process.exit(1); }
    if (!TIERS.has(tier)) { console.error(c.red(`invalid tier '${tier}' — valid: opus, sonnet, haiku, fable`)); process.exit(1); }
    const all = allMishkanAgents();
    const targets = resolveTargets(target, all);
    if (!targets) { console.error(c.red(`unknown agent or team '${target}'.`) + c.dim("  see: mishkan model show / mishkan org show")); process.exit(1); }
    if (DORMANT_TIERS.has(tier)) {
      warn(`'${tier}' is DORMANT — Claude Fable 5 was suspended 2026-06-12; agents routed here will fail to spawn.`);
      const ok = await promptYN(`Route ${targets.length} agent(s) to '${tier}' anyway?`, false);
      if (!ok) { console.log("aborted."); return; }
    }
    for (const a of targets) overlay[a] = tier;
    writeOverlay(overlay);
    console.log(c.green(`✓ set ${targets.length} agent(s) → ${tier}`) + c.dim("   overlay: " + tilde(ROUTING_LOCAL)));
    console.log(c.dim("  live on the next delegation (hook reads the overlay) · survives `mishkan install`."));
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

  console.error("usage: mishkan model <show | set <agent|team|all> <tier> | reset [agent|team|all]>");
  console.log("  show                  effective tier per agent (shipped default + your overrides)");
  console.log("  set <target> <tier>   override a tier — target is an agent alias, a team id, or 'all'");
  console.log("  reset [target]        drop override(s); no target = clear them all");
  console.log("  tiers: opus · sonnet · haiku · fable" + c.dim(" (fable dormant — suspended 2026-06-12)"));
  process.exit(1);
}

const cmd = process.argv[2];
const flags = new Set(process.argv.slice(3));
switch (cmd) {
  // self-management — object is the harness itself (bare verbs; `npx mishkan-harness <verb>`)
  case "install": await install(); break;
  case "uninstall": uninstall({ purge: flags.has("--purge") }); break;
  case "status": status(); break;
  // subsystems — mishkan <object> <verb>
  case "knowledge": await knowledgeCmd(process.argv.slice(3)); break;
  case "knowledge-stack": await knowledgeStackCmd(process.argv.slice(3)); break;
  case "project-work-store": await projectWorkStoreCmd(process.argv.slice(3)); break;
  case "code-graph": codeGraphCmd(process.argv.slice(3)); break;
  case "observability": observabilityCmd(process.argv.slice(3)); break;
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

// Help / usage — always shows. Detects whether ~/.local/bin/mishkan
// symlinks back to us; when yes we print the short `mishkan <subcommand>`
// form because that's what the user can actually type. Otherwise we
// print the `npx mishkan-harness <subcommand>` form so copy-paste works
// on a fresh shell without the symlink.
function printHelp() {
  const link = join(HOME, ".local", "bin", "mishkan");
  let direct = false;
  if (isSymlink(link)) {
    try {
      const t = readlinkSync(link);
      direct = t === join(PKG, "bin", "mishkan.js");
    } catch { direct = false; }
  }
  const prefix = direct ? "mishkan" : "npx mishkan-harness";
  const pkgVersion = (() => {
    try { return JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version; } catch { return "?"; }
  })();
  console.log("");
  console.log(c.bold(`MISHKAN harness  v${pkgVersion}`));
  console.log("");
  if (direct) {
    console.log(c.dim("  Direct access detected: ~/.local/bin/mishkan -> bin/mishkan.js"));
    console.log(c.dim("  All commands below run directly without `npx`."));
  } else {
    console.log(c.dim("  No ~/.local/bin/mishkan symlink — commands run via `npx mishkan-harness …`."));
    console.log(c.dim("  After `install` the harness can symlink for direct access automatically."));
  }
  console.log("");
  console.log(c.bold("Manage the harness"));
  console.log("  " + c.bold(`${prefix} install`)             + "                    Install / refresh into ~/.claude (idempotent)");
  console.log("  " + c.bold(`${prefix} uninstall [--purge]`) + "          Remove it (--purge also drops y4nn-standards.md)");
  console.log("  " + c.bold(`${prefix} status`)              + "                     Install state + live knowledge-stack health");
  console.log("");
  console.log(c.bold("Knowledge") + c.dim("   (you run these — agents never do)"));
  console.log("  " + c.bold(`${prefix} knowledge configure`)       + "        Wizard: LLM provider + cognee secrets");
  console.log("  " + c.bold(`${prefix} knowledge ingest [paths…]`) + "  Add docs to THIS project's store");
  console.log("  " + c.bold(`${prefix} knowledge-stack up|down|restart|status`) + "  The shared running infra (up = guided)");
  console.log("  " + c.bold(`${prefix} project-work-store [<slug>] up|down|reset`) + "  A project's own store");
  console.log("");
  console.log(c.bold("Inspect / observe"));
  console.log("  " + c.bold(`${prefix} code-graph status|open|scan`)  + "      The project's code graph (Graphify)");
  console.log("  " + c.bold(`${prefix} observability install|open`)   + "      The live monitor (daemon + TUI)");
  console.log("  " + c.bold(`${prefix} org show [--json]`)            + "           The 45-agent reference");
  console.log("  " + c.bold(`${prefix} model show|set|reset`)          + "        Re-tier agents (per-agent/team/all) — survives updates");
  console.log("  " + c.dim("(the TUI binary is ") + c.bold("mishkan-watch") + c.dim("; `mishkan-watchd start|stop|status` for manual daemon control)"));
  console.log("");
  console.log(c.bold("Inside a Claude Code session"));
  console.log("  " + c.dim("Talk to Nehemiah (PM) in plain language — exploration mode is the default."));
  console.log("  " + c.dim("Slash commands available after install:"));
  console.log("    " + c.bold("/mishkan-init")           + "                            Spec chain on a new project (PRD → SRS → CONTRACT → …)");
  console.log("    " + c.bold("/mishkan-resume")         + "                          Resume sprint state + open blockers");
  console.log("    " + c.bold("/sprint-close")           + "                            Reporters → aggregate → docs pull → graph promote");
  console.log("    " + c.bold("/code-graph") + " status|open|scan" + "         Inspect / open / refresh the Graphify graph");
  console.log("    " + c.bold("/skills")                 + " <task description>          Skill-discovery router — 3-bucket result");
  console.log("    " + c.bold("/mishkan-skills-reindex") + "                  Rebuild the universal skill index");
  console.log("    " + c.bold("/mishkan-skills-misses")  + "                   Aggregate miss-log signal for skill-discovery tuning");
  console.log("    " + c.bold("/mishkan-org-reference")  + "                   Print the 45-agent reference inline");
  console.log("    " + c.bold("/eval-baruch")            + "                             Run the Baruch contract eval (schema + golden case)");
  console.log("    " + c.bold("/dep-audit")              + "                               Cross-project dependency + supply-chain audit");
  console.log("    " + c.bold("/promote")                + "                                 Promote a learning into Cognee by blast radius");
  console.log("    " + c.bold("/sefer-pull")             + "                              Trigger a documentation pull");
  console.log("");
  console.log(c.dim("  Docs: docs/usage/  ·  Decisions: docs/design/MISHKAN_decisions.md"));
  console.log(c.dim("  Repo: https://github.com/Y4NN777/mishkan-cc-harness"));
  console.log("");
}
