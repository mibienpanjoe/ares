// sefer-release-notes — assemble release notes from git log per category.
//
// Given a tag range (or commit range), categorise commits, summarise per
// category in parallel by Sefer specialists, then Jehoshaphat (lead) applies
// the doc style guide and produces RELEASE_NOTES.md.
//
// Pattern: pipeline (collect → per-category fan-out → style synthesis).
// ADR D-010 check:
//   - parallelism: 4 categories in parallel (feat/fix/breaking/security).
//   - panel orthogonality: each specialist handles a distinct content layer
//     (Seraiah org-wide, Joah project-level, Shevna team-level,
//     Jehonathan publication style).
//   - synthesis: final markdown produced by Jehoshaphat.

export const meta = {
  name: "sefer-release-notes",
  description: "Assemble release notes from git log: per-category summaries, style-guide application, ready-to-publish markdown.",
  whenToUse: "Every release tag, before publishing to GitHub Releases or npm.",
  phases: [{ title: "Collect" }, { title: "Summarise" }, { title: "Publish" }],
};

// The workflow runner may deliver `args` as a JSON string; normalize to an
// object so the `args?.x` reads work — and stay robust if passed already-parsed.
if (typeof args === "string") args = JSON.parse(args);

const fromRef = args?.from_ref;
const toRef = args?.to_ref ?? "HEAD";
const project = args?.project ?? ".";
const releaseTag = args?.release_tag;
if (!fromRef) throw new Error("args.from_ref is required (previous tag e.g. 'v0.2.0')");
if (!releaseTag) throw new Error("args.release_tag is required (e.g. 'v0.2.3')");

const COMMITS_SCHEMA = {
  type: "object", required: ["commits"],
  properties: { commits: { type: "array", items: { type: "object", required: ["sha", "type", "subject"], properties: { sha:{type:"string"}, type:{type:"string"}, scope:{type:"string"}, subject:{type:"string"}, breaking:{type:"boolean"} } } } },
};
const CATEGORY_SCHEMA = {
  type: "object", required: ["entries"],
  properties: { entries: { type: "array", items: { type: "object", required: ["title", "description"], properties: { title:{type:"string"}, description:{type:"string"}, references:{type:"array", items:{type:"string"}} } } } },
};

phase("Collect");
const collected = await agent(
  `Project: ${project}. Run \`git log ${fromRef}..${toRef} --pretty=format:'%H|%s'\` and parse commits using conventional-commit format (type(scope) subject). Detect breaking changes (subject contains '!' or body has BREAKING CHANGE). Return the schema.`,
  { schema: COMMITS_SCHEMA, label: "collect-commits", agentType: "joah" },
);

const commits = collected?.commits ?? [];
log(`${commits.length} commits between ${fromRef} and ${toRef}.`);

const byCategory = {
  feat:     commits.filter(c => c.type === "feat" && !c.breaking),
  fix:      commits.filter(c => c.type === "fix"),
  breaking: commits.filter(c => c.breaking),
  security: commits.filter(c => c.type === "fix" && (c.scope === "security" || /CVE|secur/i.test(c.subject))),
};

phase("Summarise");
const CATEGORIES = [
  { key: "feat",     label: "Features",            agent: "seraiah",    items: byCategory.feat },
  { key: "fix",      label: "Fixes",               agent: "joah",       items: byCategory.fix },
  { key: "breaking", label: "Breaking changes",    agent: "shevna",     items: byCategory.breaking },
  { key: "security", label: "Security",            agent: "jehonathan", items: byCategory.security },
];

const summaries = await parallel(CATEGORIES.map(C => () =>
  C.items.length === 0
    ? Promise.resolve({ category: C.key, label: C.label, entries: [] })
    : agent(
        `Release ${releaseTag}. Category: ${C.label}. Commits: ${JSON.stringify(C.items.map(c => ({sha: c.sha.slice(0,7), subject: c.subject})))}. Summarise each into a user-facing entry: title (action verb), description (1-2 sentences, why it matters), commit refs. Return the schema.`,
        { schema: CATEGORY_SCHEMA, label: `summarise:${C.key}`, agentType: C.agent, phase: "Summarise" },
      ).then(s => ({ category: C.key, label: C.label, entries: s.entries ?? [] }))
));

phase("Publish");
const releaseNotes = await agent(
  `Release ${releaseTag}. Apply the project's documentation style guide. Summaries by category: ${JSON.stringify(summaries.filter(Boolean))}. Produce RELEASE_NOTES.md with: title line, date, intro paragraph (1-3 sentences), sections per non-empty category (## Features / ## Fixes / ## Breaking changes / ## Security), each entry as a bullet with link to commit. Markdown only — no preamble.`,
  { label: "publish-notes", agentType: "jehoshaphat", phase: "Publish" },
);

return {
  release_tag: releaseTag,
  from_ref: fromRef,
  to_ref: toRef,
  commit_count: commits.length,
  category_counts: Object.fromEntries(CATEGORIES.map(C => [C.key, C.items.length])),
  release_notes: releaseNotes,
  summary: `Release notes for ${releaseTag} assembled: ${commits.length} commits across ${CATEGORIES.filter(C => C.items.length > 0).length} non-empty categories.`,
};
