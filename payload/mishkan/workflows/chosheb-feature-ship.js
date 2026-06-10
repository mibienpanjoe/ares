// chosheb-feature-ship — design → handoff package complete to Panim.
//
// A Figma / design intent + feature context goes in; a complete handoff
// package comes out: design system fit, a11y/SEO audit, asset exports,
// QA visual matrix. Replaces the back-and-forth ping-pong that currently
// burns 2-3 days per feature.
//
// The audit panel now LOOPS (team-lead-craft §6.1): if any lens is not ready,
// Hiram revises the design against the blockers and the panel re-audits, up to
// a cycle cap, then escalates to the engineer. The package is only produced
// once the design is ready-to-ship (or the loop escalates).
//
// Pattern: (audit panel → revise → loop-until-ready) + synthesis.
// Per ADR D-010 anti-pattern check:
//   - skill-in-workflow-clothing: no — 4 dimensions in parallel + a termination
//     predicate (all lenses ready) + bounded loop.
//   - workflow-calling-workflow-without-contract: no — no nesting.
//   - non-orthogonal panel: no — DS-fit / a11y / assets / QA are distinct
//     evaluation domains.
//   - workflow-as-status-page: no — synthesis stage produces handoff doc.

export const meta = {
  name: "chosheb-feature-ship",
  description: "Design → complete handoff package for Panim (DS fit + a11y + assets + QA), looping until the design is ready-to-ship.",
  whenToUse: "When Chosheb has a converged design and Huram needs to start implementation.",
  phases: [{ title: "Audit" }, { title: "Revise" }, { title: "Package" }],
};

// The workflow runner may deliver `args` as a JSON string (observed in this
// runtime); normalize to an object so the `args?.x` reads work — and stay robust
// if a caller passes it already-parsed.
if (typeof args === "string") args = JSON.parse(args);

const design = args?.design_ref;
const feature = args?.feature_context;
const MAX_CYCLES = args?.max_cycles ?? 3;
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

const LENSES = [
  { key: "ds-fit",   agent: "aholiab",  prompt: "Design system fit: does this design reuse existing tokens / components / patterns? List net-new additions to the DS." },
  { key: "a11y",     agent: "asaph",    prompt: "Accessibility + SEO audit: contrast ratios, keyboard flow, ARIA needs, semantic structure, meta requirements." },
  { key: "assets",   agent: "obed",     prompt: "Asset preparation: list required exports (svg/png/webp per breakpoint), sizes, naming, optimisation notes." },
  { key: "qa",       agent: "jahaziel", prompt: "Visual QA matrix: states (default/hover/active/disabled/error), breakpoints, edge cases, browser/device coverage." },
];

let cycle = 0;
let valid = [];
let allBlockers = [];
let allReady = false;

while (cycle < MAX_CYCLES) {
  cycle++;

  if (cycle > 1) {
    phase("Revise");
    await agent(
      `You are Hiram. Revise the design for "${feature}" (${design}) to clear these handoff blockers from cycle ${cycle - 1} — address EVERY one, do not expand scope: ${JSON.stringify(allBlockers)}. Return a concise summary of the design revisions.`,
      { agentType: "hiram", label: `revise:${cycle}`, phase: "Revise" },
    );
  }

  phase("Audit");
  const audits = await parallel(LENSES.map(L => () =>
    agent(
      `Feature: ${feature}\nDesign: ${design}\nCycle: ${cycle}\nYour lens: ${L.prompt}\nReturn the schema.`,
      { schema: AUDIT_SCHEMA, label: `audit:${L.key}:${cycle}`, agentType: L.agent, phase: "Audit" },
    ).then(a => ({ ...L, ...a }))
  ));

  valid = audits.filter(Boolean);
  allBlockers = valid.flatMap(a => a.blockers ?? []);
  allReady = valid.every(a => a.ready);
  log(`Cycle ${cycle}/${MAX_CYCLES}: ${valid.length}/${LENSES.length} lenses ready, ${allBlockers.length} blockers.`);

  if (allReady) break;
}

if (!allReady) {
  return {
    feature_context: feature,
    design_ref: design,
    audits: valid,
    ready_to_ship: false,
    escalate_to_engineer: true,
    cycles_run: cycle,
    blockers: allBlockers,
    summary: `Handoff ESCALATED to engineer after ${cycle} cycles — ${allBlockers.length} blockers unresolved across ${valid.length} lenses. Human decision required before handoff.`,
  };
}

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
  ready_to_ship: true,
  escalate_to_engineer: false,
  cycles_run: cycle,
  blockers: allBlockers,
  handoff_document: handoff,
  summary: `Handoff package ready after ${cycle} cycle(s). ${valid.length}/${LENSES.length} lenses passed. Hand to Huram (Panim).`,
};
