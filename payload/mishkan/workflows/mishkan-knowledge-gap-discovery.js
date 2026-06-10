// mishkan-knowledge-gap-discovery — find what we DON'T have in Cognee.
//
// Given an expected concept list (e.g. "what every project should have an
// ADR for"), probe Cognee work for each — when nothing relevant comes back
// for K rounds in a row, declare the concept a gap and dispatch a research
// pipeline run to fill it. Loop-until-dry on the gap discovery side.
//
// Pattern: parallel probe → loop-until-dry per concept → research fan-out
// for confirmed gaps → write findings back to Cognee work.
//
// Args:
//   { concepts: ["authentication ADR", "rate-limit runbook", ...],
//     dry_rounds: 2,
//     research_budget_per_gap: 5000 }

export const meta = {
  name: "mishkan-knowledge-gap-discovery",
  description: "Probe Cognee work for an expected concept list, identify gaps with loop-until-dry, dispatch research to fill confirmed gaps.",
  whenToUse: "Sprint-close audit, onboarding a new project, post-incident knowledge inventory. Anywhere you suspect 'we have less written down than we think'.",
  phases: [
    { title: "Probe" },
    { title: "ConfirmGaps" },
    { title: "Fill" },
  ],
};

// The workflow runner may deliver `args` as a JSON string; normalize to an
// object so the `args?.x` reads work — and stay robust if passed already-parsed.
if (typeof args === "string") args = JSON.parse(args);

const concepts = args?.concepts;
const DRY_ROUNDS = args?.dry_rounds ?? 2;
const RESEARCH_BUDGET = args?.research_budget_per_gap ?? 5000;
if (!Array.isArray(concepts) || !concepts.length) {
  throw new Error("args.concepts must be a non-empty list of expected-concept strings");
}

const PROBE_SCHEMA = {
  type: "object",
  required: ["concept", "matches"],
  properties: {
    concept: { type: "string" },
    matches: {
      type: "array",
      items: {
        type: "object",
        required: ["node_id", "title", "relevance"],
        properties: {
          node_id: { type: "string" },
          title: { type: "string" },
          relevance: { type: "string", enum: ["strong", "weak", "none"] },
        },
      },
    },
  },
};

const RESEARCH_FINDING_SCHEMA = {
  type: "object",
  required: ["concept", "summary", "sources"],
  properties: {
    concept: { type: "string" },
    summary: { type: "string" },
    sources: { type: "array", items: { type: "string" } },
    suggested_cognee_node_type: { type: "string" },
  },
};

phase("Probe");
log(`Probing ${concepts.length} concepts against Cognee work…`);

const initial = await parallel(concepts.map(concept => () =>
  agent(
    `Search Cognee work store for "${concept}". Use the cognee-search MCP tool. Classify each hit's relevance to the literal concept (strong/weak/none). Return strictly the schema.`,
    { schema: PROBE_SCHEMA, label: `probe:${concept.slice(0, 24)}` },
  )
));

const strong = (r) => (r?.matches ?? []).filter(m => m.relevance === "strong").length;

const gaps = initial.filter(Boolean).filter(r => strong(r) === 0).map(r => r.concept);
log(`Initial probe: ${gaps.length}/${concepts.length} concepts have NO strong match in Cognee work.`);

phase("ConfirmGaps");
const confirmedGaps = [];
for (const gap of gaps) {
  let dryRounds = 0;
  let rephraseCount = 0;
  while (dryRounds < DRY_ROUNDS && rephraseCount < 4) {
    rephraseCount++;
    const reprobe = await agent(
      `Search Cognee work for the same concept under a different phrasing (paraphrase ${rephraseCount}/4 of "${gap}"). Different wording, same semantic intent. Return the schema.`,
      { schema: PROBE_SCHEMA, label: `reprobe:${gap.slice(0, 18)}/${rephraseCount}`, phase: "ConfirmGaps" },
    );
    if (reprobe && strong(reprobe) > 0) {
      log(`"${gap}" — found via paraphrase ${rephraseCount}, NOT a gap.`);
      dryRounds = -1;
      break;
    }
    dryRounds++;
  }
  if (dryRounds >= DRY_ROUNDS) {
    confirmedGaps.push(gap);
  }
}
log(`${confirmedGaps.length} confirmed gaps after ${DRY_ROUNDS}-round dry-confirmation.`);

if (!confirmedGaps.length) {
  return { probed: concepts.length, gaps: 0, summary: "No confirmed gaps — every expected concept has at least a paraphrased match in Cognee work." };
}

phase("Fill");
const findings = await parallel(confirmedGaps.map(gap => () =>
  agent(
    `Run the MISHKAN research pipeline (Jakin → Ezra → Caleb → Shaphan → Shemaiah → Baruch) for: "${gap}". Token budget: ${RESEARCH_BUDGET}. Produce a finding suitable for ingestion into Cognee work as a new node. Return the schema.`,
    { schema: RESEARCH_FINDING_SCHEMA, label: `research:${gap.slice(0, 18)}`, phase: "Fill" },
  )
));

return {
  probed: concepts.length,
  gaps_confirmed: confirmedGaps.length,
  findings: findings.filter(Boolean),
  summary: `Probed ${concepts.length} concepts, confirmed ${confirmedGaps.length} gaps, produced ${findings.filter(Boolean).length} research findings ready to cognify.`,
};
