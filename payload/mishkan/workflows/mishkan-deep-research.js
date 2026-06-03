// mishkan-deep-research — pipelined research with adversarial verification.
//
// Same shape as Anthropic's bundled /deep-research but using MISHKAN's
// six research-pipeline stages (Jakin, Ezra, Caleb, Shaphan, Shemaiah,
// Baruch). The Anthropic version fans web searches across angles and
// cross-checks; this one threads them through MISHKAN's roles so the
// research-log.json contract is honoured at the end.
//
// Patterns: pipeline (Ezra brief → per-sub-question fan-out) +
// adversarial verification (3-vote refute per finding) + barrier
// (Shemaiah needs all summarised findings to evaluate coverage).
//
// Args: { intent: "raw research query", agent: "calling agent alias",
//         team: "calling agent team", sprint: "S2",
//         applied_to_task: "T-12" | "exploration" }

export const meta = {
  name: 'mishkan-deep-research',
  description: 'Run the MISHKAN research pipeline as a workflow: Jakin clarifies, Ezra formulates, Caleb fans out across sub-questions, 3-vote adversarial verify per finding, Shaphan compresses, Shemaiah evaluates, Baruch reports.',
  whenToUse: 'Any unknown that needs the web and where false-confident answers are costly. Cheaper alternative for routine lookups: the sequential research-pipeline skill via Task delegation.',
  phases: [
    { title: 'Clarify',   detail: 'Jakin sharpens intent' },
    { title: 'Formulate', detail: 'Ezra writes brief, checks curated library' },
    { title: 'Research',  detail: 'Caleb fans out per sub-question; 3-vote verify per claim' },
    { title: 'Compress',  detail: 'Shaphan summarises surviving findings' },
    { title: 'Evaluate',  detail: 'Shemaiah judges; curated cross-reference' },
    { title: 'Report',    detail: 'Baruch emits research-log.json' },
  ],
}

if (!args?.intent || !args?.agent || !args?.team || !args?.sprint) {
  throw new Error('mishkan-deep-research requires args: { intent, agent, team, sprint, applied_to_task? }')
}

const INTENT_SCHEMA = {
  type: 'object',
  required: ['clarified_intent', 'open_questions', 'ready_for_formulation'],
  properties: {
    clarified_intent:      { type: ['string', 'null'] },
    open_questions:        { type: 'array', items: { type: 'string' } },
    ready_for_formulation: { type: 'boolean' },
  },
}

const BRIEF_SCHEMA = {
  type: 'object',
  required: ['research_brief', 'curated_library_match'],
  properties: {
    research_brief: {
      type: 'object',
      required: ['sub_questions', 'priority_sources', 'acceptance_criteria'],
      properties: {
        sub_questions:       { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 7 },
        priority_sources:    { type: 'array', items: { type: 'string' } },
        acceptance_criteria: { type: 'string' },
      },
    },
    curated_library_match:   { type: 'boolean' },
    curated_library_extract: { type: ['string', 'null'] },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings', 'coverage'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'source', 'confidence'],
        properties: {
          claim:      { type: 'string' },
          source:     { type: 'string' },
          confidence: { enum: ['high', 'medium', 'low', 'unverified'] },
        },
      },
    },
    coverage: {
      type: 'object',
      required: ['answered', 'unanswered'],
      properties: {
        answered:          { type: 'array' },
        unanswered:        { type: 'array' },
        unanswered_reason: { type: 'string' },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: {
    refuted: { type: 'boolean' },
    reason:  { type: 'string' },
  },
}

const EVAL_SCHEMA = {
  type: 'object',
  required: ['verdict', 'confidence', 'gaps', 'curated_library_agreement', 'notes'],
  properties: {
    verdict:                    { enum: ['resolved', 'partial', 'blocked'] },
    confidence:                 { enum: ['high', 'medium', 'low'] },
    gaps:                       { type: 'array', items: { type: 'string' } },
    curated_library_agreement:  { enum: ['agrees', 'conflicts', 'not_covered'] },
    notes:                      { type: 'string' },
  },
}

// --- Stage 1: Jakin clarifies ------------------------------------------
phase('Clarify')
const intent = await agent(
  `Act as Jakin. Apply jakin-intent-clarification-craft. The raw query: ${JSON.stringify(args.intent)}. ` +
  `Return clarified intent + open questions. No fabricated readiness.`,
  { label: 'jakin:clarify', phase: 'Clarify', agentType: 'jakin', schema: INTENT_SCHEMA }
)

if (!intent.ready_for_formulation) {
  log(`Jakin returned ready_for_formulation=false; ${intent.open_questions.length} open questions.`)
  return {
    outcome: 'blocked',
    stage_blocked: 'jakin',
    open_questions: intent.open_questions,
    research_log: null,
  }
}

// --- Stage 2: Ezra formulates ------------------------------------------
phase('Formulate')
const brief = await agent(
  `Act as Ezra. Apply ezra-research-formulation-craft. Clarified intent: ${JSON.stringify(intent.clarified_intent)}. ` +
  `Check curated library first via mcp__cognee-curated__search. If match, set curated_library_match=true and include curated_library_extract.`,
  { label: 'ezra:formulate', phase: 'Formulate', agentType: 'ezra', schema: BRIEF_SCHEMA }
)

// Curated short-circuit: skip Caleb/Shaphan, go straight to Shemaiah evaluating the curated extract.
if (brief.curated_library_match) {
  log('Ezra short-circuit — curated library match. Skipping web research.')

  phase('Evaluate')
  const verdict = await agent(
    `Act as Shemaiah. Apply shemaiah-evaluation-craft. Evaluate the curated extract against the original ` +
    `sub-questions. The brief: ${JSON.stringify(brief)}. The extract is the only source.`,
    { label: 'shemaiah:evaluate-curated', phase: 'Evaluate', agentType: 'shemaiah', schema: EVAL_SCHEMA }
  )

  phase('Report')
  const log_short = {
    agent: args.agent, team: args.team, sprint: args.sprint,
    trigger: 'faced_problem',
    query_intent: intent.clarified_intent,
    tools_invoked: ['jakin', 'ezra', 'shemaiah', 'baruch'],
    research_output_summary: brief.curated_library_extract,
    applied_to_task: args.applied_to_task || 'exploration',
    outcome: verdict.verdict,
    knowledge_graph_write: false,
    curated_library_match: true,
    cognee_node_id: null,
  }
  return { outcome: verdict.verdict, research_log: log_short, source: 'curated' }
}

// --- Stage 3: Caleb pipelines across sub-questions ---------------------
// Pipeline: each sub-question runs through (research → 3-vote adversarial verify)
// independently. Faster wall-clock than barrier(research) → barrier(verify).
phase('Research')
const verified = await pipeline(
  brief.research_brief.sub_questions,

  // Stage A: Caleb researches one sub-question.
  (q, _, i) => agent(
    `Act as Caleb. Apply caleb-web-research-craft. Sub-question: ${JSON.stringify(q)}. ` +
    `Priority sources: ${JSON.stringify(brief.research_brief.priority_sources)}. ` +
    `Acceptance: ${brief.research_brief.acceptance_criteria}. Return findings + coverage.`,
    { label: `caleb:Q${i + 1}`, phase: 'Research', agentType: 'caleb', schema: FINDINGS_SCHEMA }
  ),

  // Stage B: for each finding from stage A, 3-vote adversarial verify.
  // 2/3 refute → drop the finding.
  async (researchResult, q, i) => {
    if (!researchResult?.findings?.length) return { sub_question: q, findings: [], coverage: researchResult?.coverage }
    const survived = await parallel(researchResult.findings.map((f) => async () => {
      const votes = await parallel([0, 1, 2].map((v) => () => agent(
        `Adversarial verifier ${v + 1}/3. Try to REFUTE this finding. Default to refuted=true if uncertain. ` +
        `Finding: ${JSON.stringify(f)}. Source: ${f.source}.`,
        { label: `verify:Q${i + 1}:f${f.claim.slice(0, 24)}:v${v + 1}`, phase: 'Research',
          agentType: 'shemaiah', schema: VERDICT_SCHEMA }
      )))
      const refuted = votes.filter(Boolean).filter(v => v.refuted).length
      return refuted >= 2 ? null : f
    }))
    return {
      sub_question: q,
      findings: survived.filter(Boolean),
      coverage: researchResult.coverage,
      killed_by_verify: researchResult.findings.length - survived.filter(Boolean).length,
    }
  }
)

const allFindings = verified.filter(Boolean).flatMap(v => v.findings)
const totalKilled = verified.filter(Boolean).reduce((n, v) => n + (v.killed_by_verify || 0), 0)
log(`Research+verify done: ${allFindings.length} findings survived; ${totalKilled} refuted by adversarial vote.`)

// --- Stage 4: Shaphan compresses ---------------------------------------
phase('Compress')
const summary = await agent(
  `Act as Shaphan. Apply shaphan-summarisation-craft. Findings from ${verified.length} sub-questions: ` +
  `${JSON.stringify(allFindings)}. Coverage per sub-question: ` +
  `${JSON.stringify(verified.filter(Boolean).map(v => ({ q: v.sub_question, coverage: v.coverage })))}. ` +
  `Preserve every source and confidence. Surface contradictions explicitly.`,
  { label: 'shaphan:compress', phase: 'Compress', agentType: 'shaphan' }
)

// --- Stage 5: Shemaiah evaluates ---------------------------------------
phase('Evaluate')
const verdict = await agent(
  `Act as Shemaiah. Apply shemaiah-evaluation-craft. Brief: ${JSON.stringify(brief.research_brief)}. ` +
  `Summary: ${JSON.stringify(summary)}. Cross-reference the curated library via mcp__cognee-curated__search. ` +
  `Return verdict + confidence + gaps + curated_library_agreement.`,
  { label: 'shemaiah:evaluate', phase: 'Evaluate', agentType: 'shemaiah', schema: EVAL_SCHEMA }
)

// --- Stage 6: Baruch reports -------------------------------------------
phase('Report')
const research_log = {
  agent: args.agent, team: args.team, sprint: args.sprint,
  trigger: 'faced_problem',
  query_intent: intent.clarified_intent,
  tools_invoked: ['jakin', 'ezra', 'caleb', 'shaphan', 'shemaiah', 'baruch'],
  research_output_summary: typeof summary === 'string' ? summary : JSON.stringify(summary),
  applied_to_task: args.applied_to_task || 'exploration',
  outcome: verdict.verdict,
  knowledge_graph_write: false,            // Baruch sets to true if writing a node downstream
  curated_library_match: false,
  cognee_node_id: null,
}

return {
  outcome: verdict.verdict,
  confidence: verdict.confidence,
  gaps: verdict.gaps,
  research_log,
  stats: {
    sub_questions: brief.research_brief.sub_questions.length,
    findings_surviving: allFindings.length,
    findings_refuted: totalKilled,
  },
}
