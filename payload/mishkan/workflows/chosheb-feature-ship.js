// chosheb-feature-ship — design → handoff package complete to Panim.
//
// A Figma / design intent + feature context goes in; a complete handoff
// package comes out: design system fit, a11y/SEO audit, asset exports,
// QA visual matrix. Replaces the back-and-forth ping-pong that currently
// burns 2-3 days per feature.
//
// Pattern: barrier `parallel()` per dimension + synthesis.
// Per ADR D-010 anti-pattern check:
//   - skill-in-workflow-clothing: no — 4 dimensions in parallel, panel.
//   - workflow-calling-workflow-without-contract: no — no nesting.
//   - non-orthogonal panel: no — DS-fit / a11y / assets / QA are distinct
//     evaluation domains.
//   - workflow-as-status-page: no — synthesis stage produces handoff doc.

export const meta = {
  name: "chosheb-feature-ship",
  description: "Design → complete handoff package for Panim (DS fit + a11y + assets + QA).",
  whenToUse: "When Chosheb has a converged design and Huram needs to start implementation.",
  phases: [{ title: "Audit" }, { title: "Package" }],
};

const design = args?.design_ref;
const feature = args?.feature_context;
if (!design) throw new Error("args.design_ref is required (Figma URL / asset path)");
if (!feature) throw new Error("args.feature_context is required (1-paragraph feature description)");

const AUDIT_SCHEMA = {
  type: "object",
  required: ["ready", "blockers"],
  properties: {
    ready: { type: "boolean" },
    blockers: { type: "array", items: { type: "string" } },
    deliverables: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
};

phase("Audit");
const LENSES = [
  { key: "ds-fit",   agent: "aholiab",  prompt: "Design system fit: does this design reuse existing tokens / components / patterns? List net-new additions to the DS." },
  { key: "a11y",     agent: "asaph",    prompt: "Accessibility + SEO audit: contrast ratios, keyboard flow, ARIA needs, semantic structure, meta requirements." },
  { key: "assets",   agent: "obed",     prompt: "Asset preparation: list required exports (svg/png/webp per breakpoint), sizes, naming, optimisation notes." },
  { key: "qa",       agent: "jahaziel", prompt: "Visual QA matrix: states (default/hover/active/disabled/error), breakpoints, edge cases, browser/device coverage." },
];

const audits = await parallel(LENSES.map(L => () =>
  agent(
    `Feature: ${feature}\nDesign: ${design}\nYour lens: ${L.prompt}\nReturn the schema.`,
    { schema: AUDIT_SCHEMA, label: `audit:${L.key}`, agentType: L.agent, phase: "Audit" },
  ).then(a => ({ ...L, ...a }))
));

const valid = audits.filter(Boolean);
const allBlockers = valid.flatMap(a => a.blockers ?? []);
const allReady = valid.every(a => a.ready);

phase("Package");
const handoff = await agent(
  `Chosheb → Panim handoff package. Feature: ${feature}. Audits: ${JSON.stringify(valid.map(a => ({lens: a.key, ready: a.ready, deliverables: a.deliverables, notes: a.notes})))}. ` +
  `Produce a structured handoff document: design summary, DS additions list, a11y checklist, asset manifest, QA matrix, open questions. Markdown.`,
  { label: "package-handoff", agentType: "aholiab", phase: "Package" },
);

return {
  feature_context: feature,
  design_ref: design,
  audits: valid,
  ready_to_ship: allReady,
  blockers: allBlockers,
  handoff_document: handoff,
  summary: allReady
    ? `Handoff package ready. ${valid.length}/4 lenses passed. Hand to Huram (Panim).`
    : `Handoff BLOCKED. ${allBlockers.length} blockers across ${valid.length} lenses. Resolve before handoff.`,
};
