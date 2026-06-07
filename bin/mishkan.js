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

  const final = `# Generated by mishkan-harness configure-knowledge on ${new Date().toISOString()}
# Profile: ${profile.name}
# Re-run \`npx mishkan-harness configure-knowledge\` to switch providers (secrets preserved).

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
  console.log(`  Work  · MCP        ${c.cyan("http://127.0.0.1:7777/mcp")}`);
  console.log(`  Work  · Graph UI   ${c.cyan("http://127.0.0.1:7724")}   ${c.dim(`${adminEmail} / DEFAULT_USER_PASSWORD`)}`);
  console.log(`  Work  · Neo4j      ${c.cyan("http://127.0.0.1:7716")}   ${c.dim("neo4j / GRAPH_DATABASE_PASSWORD")}`);
  console.log(`  Work  · REST       ${c.cyan("http://127.0.0.1:7737")}`);
  console.log(`  Curated · MCP      ${c.cyan("http://127.0.0.1:7730/mcp")}`);
  console.log(`  Curated · Graph    ${c.cyan("http://127.0.0.1:7734")}`);
  console.log(`  Curated · Neo4j    ${c.cyan("http://127.0.0.1:7731")}`);
  console.log(`  Curated · REST     ${c.cyan("http://127.0.0.1:7733")}`);
  if (profile.name.includes("Ollama")) {
    console.log(`  Ollama             ${c.cyan("http://127.0.0.1:11434")}   ${c.dim("local LLM / embeddings")}`);
  }
  console.log();
  console.log(c.bold("Bring up the Cognee stack:"));
  console.log(c.dim(`  cd ${tilde(targetDir)}`));
  console.log(c.dim("  docker compose -f docker-compose.yml -f docker-compose.hardening.yml up -d --build"));
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
Cognee WORK store (per-project knowledge graph)
${sep}

MCP endpoint           : http://127.0.0.1:7777/mcp
  - The HTTP transport agents call to query/add knowledge.
  - Health check: \`curl -sf http://127.0.0.1:7777/mcp\` returns 406 = healthy
    (the endpoint requires the MCP handshake; a vanilla GET is rejected).

Cognee Graph Explorer  : http://127.0.0.1:7724
  - Web UI to browse the work graph.
  - Login email    : ${adminEmail}
  - Login password : ${secrets.DEFAULT_USER_PASSWORD}

Cognee Backend REST    : http://127.0.0.1:7737
  - Backend API the Graph Explorer calls. Same creds as above.

Neo4j Browser          : http://127.0.0.1:7716
  - Direct cypher access to the work graph (read-only recommended).
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
default (set by configure-knowledge). The compose stack reads .env.curated
for the curated containers — re-run configure-knowledge to sync both.
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

  npx mishkan-harness configure-knowledge

Re-runs preserve the three local secrets (neo4j, pg, admin) so an
initialised neo4j volume keeps working. Both .env and ACCESS.txt are
regenerated; previous .env is backed up to .env.bak.
`;
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
  case "configure-knowledge": await configureKnowledge(); break;
  default:
    console.log(`MISHKAN harness installer
Usage:
  npx mishkan-harness install                Install/refresh into ~/.claude (idempotent)
  npx mishkan-harness configure-knowledge    Wizard for the Cognee .env (LLM + neo4j/pg/admin secrets)
  npx mishkan-harness observability          Install only the observability stack (daemon + TUI, needs uv)
  npx mishkan-harness status                 Show install state
  npx mishkan-harness uninstall              Remove harness (keeps your CLAUDE.md & rules)
  npx mishkan-harness uninstall --purge      Also remove user-level rule`);
}
