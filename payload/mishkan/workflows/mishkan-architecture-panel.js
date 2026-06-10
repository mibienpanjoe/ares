// mishkan-architecture-panel — judge panel for architecture decisions.
//
// Draft three independent architecture proposals from different priors
// (cost-first, scale-first, simplicity-first), have impact-checker
// specialists (Zadok contract, Phinehas threat, Shallum data) score each
// in parallel, synthesise the winner while grafting the runners-up best
// ideas. This is the "hard plan drafted from several angles" pattern
// Anthropic names as a canonical workflow use case.
//
// Patterns: judge panel (3 independent proposals → independent scoring) +
// fan-out (parallel impact reviews) + synthesis.
//
// Args: {
//   decision: "<one sentence: what is being decided>",
//   context:  "<paragraph: forces, constraints, horizon, current state>",
//   horizon:  "3-months" | "12-months" | "3-years"
// }

export const meta = {
  name: 'mishkan-architecture-panel',
  description: 'Judge panel for an architecture decision: 3 Nathan runs from different priors propose alternatives; Zadok/Phinehas/Shallum score impact in parallel; main session synthesises the winner.',
  whenToUse: 'High-leverage architecture decisions where the answer space is genuinely wide (service boundaries, consistency model, data ownership, contract evolution shape). Skip for decisions with a known single best answer.',
  phases: [
    { title: 'Draft',     detail: '3 parallel Nathan runs with distinct priors' },
    { title: 'Impact',    detail: 'Zadok / Phinehas / Shallum score each proposal' },
    { title: 'Vote',      detail: 'rank proposals by impact-score sum + Bezalel sanity' },
    { title: 'Synthesise',detail: 'main session writes the chosen architecture, grafting runner-up insights' },
  ],
}

// The workflow runner may deliver `args` as a JSON string; normalize to an
// object so the `args?.x` reads work — and stay robust if passed already-parsed.
if (typeof args === "string") args = JSON.parse(args);

if (!args?.decision || !args?.context) {
  throw new Error('mishkan-architecture-panel requires: { decision, context, horizon? }')
}

const HORIZON = args.horizon || '12-months'

const PROPOSAL_SCHEMA = {
  type: 'object',
  required: ['title', 'shape', 'rationale', 'trade_offs', 'out_of_scope'],
  properties: {
    title:        { type: 'string' },
    shape:        { type: 'string', description: 'one paragraph; the bounded contexts, service boundaries, data ownership, consistency story' },
    rationale:    { type: 'string' },
    trade_offs:   {
      type: 'object',
      required: ['accepts', 'gives_up'],
      properties: {
        accepts:  { type: 'string' },
        gives_up: { type: 'string' },
      },
    },
    out_of_scope: { type: 'array', items: { type: 'string' }, minItems: 3 },
    confidence:   { enum: ['high', 'medium', 'low'] },
  },
}

const IMPACT_SCHEMA = {
  type: 'object',
  required: ['proposal_title', 'reviewer', 'score', 'concerns', 'unblockers'],
  properties: {
    proposal_title: { type: 'string' },
    reviewer:       { type: 'string' },
    score:          { type: 'integer', minimum: 0, maximum: 10 },
    concerns:       { type: 'array', items: { type: 'string' } },
    unblockers:     { type: 'array', items: { type: 'string' } },
  },
}

// --- Stage 1: Three Nathan runs with distinct priors ------------------
phase('Draft')
const PRIORS = [
  { key: 'cost',       prior: 'Optimise for lowest delivery cost and lowest operational complexity. Favour fewer services, fewer external dependencies, simpler consistency models.' },
  { key: 'scale',      prior: 'Optimise for horizon-stretching scale. Assume traffic 100× current; assume team grows 5×. Favour bounded contexts that survive Conway-Law re-org.' },
  { key: 'simplicity', prior: 'Optimise for legibility and reversibility. Favour the shape an engineer can reconstruct in an afternoon; reject anything where the failure mode is hidden.' },
]

const proposals = await parallel(PRIORS.map(({ key, prior }) => () => agent(
  `Act as Nathan. Apply nathan-architecture-craft. Propose an architecture for: ${args.decision}. ` +
  `Context: ${args.context}. Horizon: ${HORIZON}. ` +
  `Your specific prior for this proposal: ${prior} ` +
  `Commit fully to this prior. Name the force-tension your proposal resolves. List three out-of-scope items.`,
  { label: `nathan:${key}`, phase: 'Draft', agentType: 'nathan', schema: PROPOSAL_SCHEMA }
)))

const valid = proposals.filter(Boolean)
if (valid.length < 2) {
  return { outcome: 'blocked', reason: 'fewer than 2 proposals survived', proposals: valid }
}
log(`Drafted ${valid.length} proposals: ${valid.map(p => p.title).join(' / ')}`)

// --- Stage 2: Impact review — Zadok / Phinehas / Shallum on each ------
phase('Impact')
const IMPACT_REVIEWERS = ['zadok', 'phinehas', 'shallum']
const impactTasks = []
for (const proposal of valid) {
  for (const reviewer of IMPACT_REVIEWERS) {
    impactTasks.push({ proposal, reviewer })
  }
}

const impacts = await parallel(impactTasks.map(({ proposal, reviewer }) => () => agent(
  `Act as ${reviewer}. Apply your craft skill. Score this architecture proposal on a 0-10 scale ` +
  `from your specialty perspective. Then list concerns and unblockers. ` +
  `Proposal: ${JSON.stringify(proposal)}.`,
  {
    label: `impact:${reviewer}:${proposal.title.slice(0, 24)}`,
    phase: 'Impact',
    agentType: reviewer,
    schema: IMPACT_SCHEMA,
  }
)))

// --- Stage 3: Aggregate scores per proposal ---------------------------
phase('Vote')
const scoresByProposal = {}
for (const i of impacts.filter(Boolean)) {
  const key = i.proposal_title
  scoresByProposal[key] = scoresByProposal[key] || { total: 0, reviews: [] }
  scoresByProposal[key].total += i.score
  scoresByProposal[key].reviews.push(i)
}

const ranked = valid
  .map(p => ({
    proposal: p,
    total_score: (scoresByProposal[p.title]?.total) || 0,
    reviews:     scoresByProposal[p.title]?.reviews || [],
  }))
  .sort((a, b) => b.total_score - a.total_score)

const winner = ranked[0]
const runners_up = ranked.slice(1)
log(`Winner: "${winner.proposal.title}" (${winner.total_score} pts). Runners-up: ${runners_up.map(r => `"${r.proposal.title}" (${r.total_score})`).join(', ')}`)

// --- Stage 4: Synthesise — Bezalel writes the final architecture -----
phase('Synthesise')
const synthesis = await agent(
  `Act as Bezalel. Synthesise the final architecture for: ${args.decision}. ` +
  `The chosen base is "${winner.proposal.title}" (top-scored, ${winner.total_score} points). ` +
  `Chosen proposal: ${JSON.stringify(winner.proposal)}. ` +
  `Impact reviews of the winner: ${JSON.stringify(winner.reviews)}. ` +
  `Runners-up to consider grafting from: ${JSON.stringify(runners_up.map(r => r.proposal))}. ` +
  `Produce the final architecture in MADR-shaped sections: Context, Decision Drivers, Considered Options ` +
  `(name all three with their scores), Decision Outcome (name the force the choice resolves), Consequences ` +
  `(Positive/Negative/Neutral), Out of Scope (three items minimum), Open Questions.`,
  { label: 'bezalel:synthesise', phase: 'Synthesise', agentType: 'bezalel' }
)

return {
  decision: args.decision,
  winner: winner.proposal.title,
  ranked_proposals: ranked.map(r => ({ title: r.proposal.title, score: r.total_score })),
  final_architecture: synthesis,
  all_proposals: valid,
  all_impacts: impacts.filter(Boolean),
}
