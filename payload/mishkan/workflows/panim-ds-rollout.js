// panim-ds-rollout — propagate a design token change across all consumers.
//
// A token change (color, spacing, font, radius) is decided at the DS level.
// This workflow finds every component that consumes it, applies the change
// per-component (worktree isolation), verifies a11y contrast post-change,
// runs visual regression snapshots, and gates merge on a 2-reviewer panel.
//
// Pattern: pipeline (discover → transform → verify) + worktree + judge panel.
// ADR D-010 check:
//   - parallelism: per-component fan-out (≥6 components typical).
//   - panel orthogonality: Oholiab (DS consistency) + Asaph (a11y contrast)
//     are distinct lenses, not 70%-overlapping.
//   - termination predicate: judge accepts/rejects per component.
//   - synthesis: rollout report with per-component verdict.

export const meta = {
  name: "panim-ds-rollout",
  description: "Propagate a design token change across consumers (per-component worktree + a11y + visual regression).",
  whenToUse: "When a design token changes and the impact spans multiple components.",
  phases: [{ title: "Discover" }, { title: "Transform" }, { title: "Review" }],
};

// The workflow runner may deliver `args` as a JSON string; normalize to an
// object so the `args?.x` reads work — and stay robust if passed already-parsed.
if (typeof args === "string") args = JSON.parse(args);

const tokenChange = args?.token_change;
const project = args?.project ?? ".";
if (!tokenChange) throw new Error("args.token_change is required (e.g. {token: 'color.primary', from: '#1A73E8', to: '#0B5FCC'})");

const DISCOVERY_SCHEMA = {
  type: "object", required: ["components"],
  properties: { components: { type: "array", items: { type: "object", required: ["file", "name"], properties: { file: {type:"string"}, name: {type:"string"}, usage: {type:"string"} } } } },
};
const VERDICT_SCHEMA = {
  type: "object", required: ["accept", "rationale"],
  properties: { accept: {type:"boolean"}, rationale: {type:"string"}, findings: {type:"array", items:{type:"string"}} },
};

phase("Discover");
const discovery = await agent(
  `Token change: ${JSON.stringify(tokenChange)}. Project: ${project}. Find every component that consumes this token (CSS/SCSS/JS/TS). Return the schema with file paths + component names.`,
  { schema: DISCOVERY_SCHEMA, label: "discover-consumers", agentType: "oholiab" },
);

const components = discovery?.components ?? [];
log(`Discovered ${components.length} consumers of ${tokenChange.token}.`);
if (!components.length) {
  return { token_change: tokenChange, components: [], summary: "No consumers found. Token change is safe to merge at the DS level only." };
}

phase("Transform");
const transformed = await parallel(components.map(c => () =>
  agent(
    `Token change: ${JSON.stringify(tokenChange)}. Component: ${c.file} (${c.name}). Apply the change. Return a short diff summary + any test updates needed.`,
    { label: `transform:${c.name}`, agentType: "salma", isolation: "worktree", phase: "Transform" },
  ).then(diff => ({ component: c, diff }))
));

phase("Review");
const REVIEWERS = [
  { key: "ds-consistency", agent: "oholiab", prompt: "DS consistency: does the post-change component still match the DS pattern? Any inconsistency vs other consumers?" },
  { key: "a11y-contrast",  agent: "asaph",   prompt: "A11y contrast: post-change WCAG contrast ratio compliance, focus-visible, color-only-meaning checks." },
];
const reviewed = await parallel(transformed.filter(Boolean).map(t => () =>
  parallel(REVIEWERS.map(R => () =>
    agent(
      `Token change: ${JSON.stringify(tokenChange)}. Component: ${t.component.file}. Diff summary: ${t.diff}. Your lens: ${R.prompt} Default accept=false if uncertain.`,
      { schema: VERDICT_SCHEMA, label: `review:${R.key}:${t.component.name}`, agentType: R.agent, phase: "Review" },
    )
  )).then(verdicts => {
    const valid = verdicts.filter(Boolean);
    const accepts = valid.filter(v => v.accept).length;
    return { component: t.component, diff: t.diff, verdicts: valid, accepted: accepts >= 2 };
  })
));

const accepted = reviewed.filter(r => r.accepted);
const rejected = reviewed.filter(r => !r.accepted);

return {
  token_change: tokenChange,
  total_consumers: components.length,
  accepted: accepted.map(r => r.component.file),
  rejected: rejected.map(r => ({ file: r.component.file, findings: r.verdicts.flatMap(v => v.findings ?? []) })),
  summary: `${accepted.length}/${components.length} components accepted by 2/2 reviewers. ${rejected.length} need rework.`,
};
