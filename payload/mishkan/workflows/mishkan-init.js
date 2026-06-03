// mishkan-init — pipelined project bootstrap.
//
// The sequence-before-implementation chain (PRD → SRS → CONTRACT →
// ARCHITECTURE → THREAT_MODEL → C4) currently runs as a sequential skill.
// As a workflow with overlapping stages, downstream agents start as soon
// as their upstream dependency lands — cutting init from hours to
// minutes without violating the sequence rule (each artefact still has
// its prerequisite, just no idle gap between them).
//
// Patterns: pipeline with explicit dependencies (PRD → SRS, SRS → both
// CONTRACT and ARCHITECTURE in parallel, ARCHITECTURE → C4, ARCHITECTURE
// → THREAT_MODEL) + fan-out where dependencies allow.
//
// Args: {
//   project_name: "aiobi-forms",
//   project_root: "/path/to/project",
//   raw_intent: "<paragraph: what is being built, for whom, with what constraints>",
//   stack_hint: "Laravel 11 + Nuxt 3" | "FastAPI + React" | ...
// }

export const meta = {
  name: 'mishkan-init',
  description: 'Pipelined PRD → SRS → CONTRACT → ARCHITECTURE → THREAT_MODEL → C4. Downstream stages start as soon as their upstream dependency lands; sequence rule preserved.',
  whenToUse: 'Once per project at /mishkan-init. Brownfield mode uses the same shape with read-existing instead of write-new at each stage.',
  phases: [
    { title: 'PRD',          detail: 'Nehemiah writes the product requirement document' },
    { title: 'SRS',          detail: 'Nathan turns PRD into a testable system requirement spec' },
    { title: 'CONTRACT+ARCH',detail: 'Zadok writes CONTRACT; Nathan writes ARCHITECTURE — in parallel' },
    { title: 'THREAT+C4',    detail: 'Benaiah writes THREAT_MODEL; Meshullam writes C4 diagrams — in parallel' },
    { title: 'Settle',       detail: 'Bezalel signs off on the artefact set; Jehoshaphat scaffolds docs/' },
  ],
}

if (!args?.project_name || !args?.project_root || !args?.raw_intent) {
  throw new Error('mishkan-init requires: { project_name, project_root, raw_intent, stack_hint? }')
}

const ARTEFACT_SCHEMA = {
  type: 'object',
  required: ['artefact', 'path', 'summary'],
  properties: {
    artefact: { type: 'string' },
    path:     { type: 'string', description: 'relative path under project_root' },
    summary:  { type: 'string' },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
}

const STACK = args.stack_hint || 'undetermined'

// --- Stage 1: PRD ------------------------------------------------------
phase('PRD')
const prd = await agent(
  `Act as Nehemiah. Apply nehemiah-pm-craft. Write PRD.md for ${args.project_name} from the raw intent: ` +
  `${args.raw_intent}. Stack hint (informational only): ${STACK}. ` +
  `Write to ${args.project_root}/docs/PRD.md. Include: problem, who-for, success criteria (numeric where possible), ` +
  `explicitly-out-of-scope (three items minimum), constraints.`,
  { label: 'nehemiah:prd', phase: 'PRD', agentType: 'nehemiah', schema: ARTEFACT_SCHEMA }
)

// --- Stage 2: SRS depends on PRD --------------------------------------
phase('SRS')
const srs = await agent(
  `Act as Nathan. Apply nathan-architecture-craft. Write SRS.md for ${args.project_name}. ` +
  `Read the PRD at ${prd.path}. Produce testable requirements: every F-N requirement has an acceptance test ` +
  `shape; every NF-N requirement is numeric; constraints called out explicitly; assumptions named. ` +
  `Write to ${args.project_root}/docs/SRS.md.`,
  { label: 'nathan:srs', phase: 'SRS', agentType: 'nathan', schema: ARTEFACT_SCHEMA }
)

// --- Stage 3: CONTRACT + ARCHITECTURE in parallel ---------------------
// Both depend on SRS only; they can run concurrently.
phase('CONTRACT+ARCH')
const [contract, architecture] = await parallel([
  () => agent(
    `Act as Zadok. Apply zadok-contract-craft. Write CONTRACT.md for ${args.project_name}. ` +
    `Read the SRS at ${srs.path}. Author invariants + guarantees: error envelope (code/message/request_id), ` +
    `pagination shape (cursor only), naming conventions, idempotency clauses where applicable, versioning ` +
    `policy. Three things explicitly out of scope. Write to ${args.project_root}/docs/CONTRACT.md.`,
    { label: 'zadok:contract', phase: 'CONTRACT+ARCH', agentType: 'zadok', schema: ARTEFACT_SCHEMA }
  ),
  () => agent(
    `Act as Nathan. Apply nathan-architecture-craft. Write ARCHITECTURE.md for ${args.project_name}. ` +
    `Read the SRS at ${srs.path}. Produce: system-in-one-diagram (C4 L1 to be drawn by Meshullam), ` +
    `system-in-one-paragraph, bounded contexts named with ownership rules, data flow on the golden path, ` +
    `consistency map per data store, failure modes with fallbacks, links to ADRs (none yet, structure ready). ` +
    `Write to ${args.project_root}/docs/ARCHITECTURE.md.`,
    { label: 'nathan:architecture', phase: 'CONTRACT+ARCH', agentType: 'nathan', schema: ARTEFACT_SCHEMA }
  ),
])

// --- Stage 4: THREAT_MODEL + C4 in parallel ---------------------------
// THREAT_MODEL needs ARCHITECTURE (trust boundaries derived from it).
// C4 needs ARCHITECTURE (containers drawn from the named bounded contexts).
// Neither needs CONTRACT, so the parallelism is real.
phase('THREAT+C4')
const [threat, c4] = await parallel([
  () => agent(
    `Act as Benaiah. Apply benaiah-devsecops-craft. Write THREAT_MODEL.md for ${args.project_name}. ` +
    `Read ARCHITECTURE.md at ${architecture.path}. Walk STRIDE per asset and trust boundary. Mitigations are ` +
    `concrete (not "use TLS" but "mTLS at Traefik with cert rotation every 90 days via cert-manager"). ` +
    `Open items routed to specialists named. Write to ${args.project_root}/docs/THREAT_MODEL.md.`,
    { label: 'benaiah:threat-model', phase: 'THREAT+C4', agentType: 'benaiah', schema: ARTEFACT_SCHEMA }
  ),
  () => agent(
    `Act as Meshullam. Apply meshullam-infra-design-craft. Produce C4 diagrams for ${args.project_name}. ` +
    `Read ARCHITECTURE.md at ${architecture.path}. Generate at least L1 (Context) and L2 (Containers). ` +
    `Source format Mermaid or PlantUML committed alongside rendered output. Write to ` +
    `${args.project_root}/docs/diagrams/C4/.`,
    { label: 'meshullam:c4', phase: 'THREAT+C4', agentType: 'meshullam', schema: ARTEFACT_SCHEMA }
  ),
])

// --- Stage 5: Settle — Bezalel signs off, Jehoshaphat scaffolds docs --
phase('Settle')
const [signoff, docsScaffold] = await parallel([
  () => agent(
    `Act as Bezalel. Apply bezalel-cto-craft. Review the six artefacts produced for ${args.project_name}: ` +
    `${JSON.stringify({ prd, srs, contract, architecture, threat, c4 })}. ` +
    `Apply the quality bar: every artefact dated; every requirement testable; every contract clause sourceable; ` +
    `every threat anchored. Return a sign-off { status: 'accepted' | 'changes_requested', notes }.`,
    {
      label: 'bezalel:signoff',
      phase: 'Settle',
      agentType: 'bezalel',
      schema: {
        type: 'object',
        required: ['status', 'notes'],
        properties: {
          status: { enum: ['accepted', 'changes_requested'] },
          notes:  { type: 'string' },
          changes_requested: { type: 'array', items: { type: 'string' } },
        },
      },
    }
  ),
  () => agent(
    `Act as Jehoshaphat. Apply documentation-craft. Scaffold the docs/ tree for ${args.project_name} ` +
    `at ${args.project_root}/docs/: ADR index, runbooks/, changelog stub, README, Diátaxis quadrant ` +
    `placeholders. Do not author content; create the scaffold and the index.`,
    { label: 'jehoshaphat:scaffold', phase: 'Settle', agentType: 'jehoshaphat', schema: ARTEFACT_SCHEMA }
  ),
])

return {
  project_name: args.project_name,
  project_root: args.project_root,
  artefacts: {
    prd, srs, contract, architecture, threat, c4,
    docs_scaffold: docsScaffold,
  },
  bezalel_signoff: signoff,
  next: signoff?.status === 'accepted'
    ? `Init complete. Begin Sprint S0; Nehemiah leads. Hand the directory state to Y4NN for git init + first commit.`
    : `Init blocked on changes_requested. Address Bezalel's notes; re-run mishkan-init or run targeted skill invocations.`,
}
