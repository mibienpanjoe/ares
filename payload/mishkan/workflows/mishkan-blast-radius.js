// mishkan-blast-radius — what does this change actually touch?
//
// Given a refactor target (symbol/function/class), walk the Graphify
// reverse-call graph for each impacted call site, then adversarially
// verify each "this is impacted" claim with three load-bearing lenses
// (caller-side / data-contract / runtime-behavior) so false-positive
// impacted sites get filtered out before the engineer schedules work.
//
// Pattern: Graphify discovery → parallel fan-out per call site →
// adversarial verify (3-lens panel) → synthesis.
//
// Per PM+CTO portfolio review (2026-06-07):
//  - Nehemiah: keep — recurrence justified for every non-trivial refactor.
//    Must be gated by /plan approval before invocation. Renamed from
//    `mishkan-graphify-impact-audit` to drop implementation detail from
//    the user-facing name.
//  - Bezalel: keep + rework with three EXPLICIT lenses that are
//    orthogonal (not 70%-overlapping), and a short-circuit when Graphify
//    returns < N nodes so we don't burn tokens on empty fanouts.
//
// Args (passed via Workflow `args`):
//   { target: "process_payment", depth: 3, project: "/path/to/repo",
//     min_sites_to_verify: 2 }   // short-circuit threshold
//
// Pre-req: the project has been scanned (graphify update .). Workflow
// emits a single graphify_query to gather impacted sites; that's the budget.

export const meta = {
  name: "mishkan-blast-radius",
  description: "What does this change actually touch? Graphify discovery + 3-lens orthogonal verify per impacted site.",
  whenToUse: "Before editing a function whose downstream impact you don't fully know. Gated by /plan approval per the harness sequence rule.",
  phases: [
    { title: "Discover" },
    { title: "Verify" },
    { title: "Synthesize" },
  ],
};

// The workflow runner may deliver `args` as a JSON string; normalize to an
// object so the `args?.x` reads work — and stay robust if passed already-parsed.
if (typeof args === "string") args = JSON.parse(args);

const target = args?.target;
const depth = args?.depth ?? 3;
const project = args?.project ?? ".";
const MIN_SITES = args?.min_sites_to_verify ?? 2;
if (!target) throw new Error("args.target is required (the symbol/function/class to audit)");

const IMPACTED_SCHEMA = {
  type: "object",
  required: ["sites"],
  properties: {
    sites: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "symbol", "reason"],
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          symbol: { type: "string" },
          reason: { type: "string" },
          relation: { type: "string" },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: "object",
  required: ["really_impacted", "confidence", "rationale"],
  properties: {
    really_impacted: { type: "boolean" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    rationale: { type: "string" },
    suggested_action: { type: "string" },
  },
};

// Three ORTHOGONAL lenses per Bezalel — each load-bearing, no overlap.
// caller-side    = the SHAPE of the call: signature, types, exception contract.
// data-contract  = the DATA flowing through: invariants, schema, nullability.
// runtime        = the RUNTIME behavior: ordering, side effects, timing, perf.
const LENSES = [
  {
    key: "caller",
    prompt: "Will the SHAPE of THIS call site break? Signature change, type mismatch, new/removed exception, async/sync mismatch — purely the call protocol, not the data semantics.",
  },
  {
    key: "data",
    prompt: "Will the DATA semantics break? Invariants this call site assumes about the target's input/output, nullability, ordering of fields, encoding — purely the data contract, not the call protocol.",
  },
  {
    key: "runtime",
    prompt: "Will the RUNTIME behavior break? Side effects this call site depends on, timing/ordering guarantees, performance characteristics, thread/event-loop assumptions — purely runtime, not data or shape.",
  },
];

phase("Discover");
const discovery = await agent(
  `Run \`graphify affected "${target}" --depth ${depth} --relations calls,imports --graph ${project}/graphify-out/graph.json\` and parse the impacted call sites it returns. Cite file:line per site. Return strictly the schema.`,
  { schema: IMPACTED_SCHEMA, label: `discover:${target}` },
);
const sites = discovery?.sites ?? [];
log(`Discovered ${sites.length} potentially impacted sites.`);

// Short-circuit: empty fan-out is wasted tokens.
if (sites.length < MIN_SITES) {
  return {
    target,
    impacted: sites,
    short_circuited: true,
    summary: `Discovered ${sites.length} sites (< MIN_SITES=${MIN_SITES}). Verification skipped. Either the target has no callers worth verifying, or the graph is stale — run \`graphify update .\` and retry.`,
  };
}

phase("Verify");
const verifiedSites = await parallel(sites.map(site => () =>
  parallel(LENSES.map(L => () =>
    agent(
      `Refactor target: ${target}. Impacted site: ${site.file}:${site.line ?? "?"} (${site.symbol}) — graph reason: "${site.reason}". Lens: ${L.prompt} Default to really_impacted=false if uncertain — we tolerate misses, not false positives.`,
      { schema: VERDICT_SCHEMA, label: `verify:${L.key}:${site.symbol}`, phase: "Verify" },
    )
  ))
  .then(verdicts => {
    const valid = verdicts.filter(Boolean);
    const really = valid.filter(v => v.really_impacted).length;
    return {
      site,
      lens_verdicts: valid,
      lens_really_count: really,
      // Confirmed = majority across the THREE orthogonal lenses.
      confirmed: really >= 2,
    };
  })
));

const confirmed = verifiedSites.filter(v => v.confirmed);
log(`${confirmed.length}/${sites.length} sites confirmed by orthogonal majority (>=2 of 3 lenses).`);

phase("Synthesize");
const summary = await agent(
  `Refactor target: ${target}. Confirmed impacted sites: ${JSON.stringify(confirmed.map(c => ({file: c.site.file, symbol: c.site.symbol, votes: c.lens_really_count, top_lens: c.lens_verdicts.find(v => v.really_impacted)?.rationale})))}. Produce a 6-10 line engineer-action summary: how many sites, the highest-risk one + which lens flagged it, suggested PR sequence (independent first, then coupled). No fluff.`,
  { label: "synthesize", phase: "Synthesize" },
);

return { target, impacted: confirmed, summary };
