// mishkan-migration-wave — pipeline + worktree-isolated transformation
// across many files.
//
// The MISHKAN-shaped equivalent of the canonical migration workflow
// (Bun Zig→Rust port: hundreds of files in parallel, two reviewers each,
// fix-loop until tests green). Adapted to MISHKAN's roles: the transformer
// is the team's implementer (Hizkiah for backend, Salma for frontend, etc.)
// and the reviewers are QA + the relevant Lead's specialist.
//
// Patterns: pipeline (find → transform → review → verify, each file
// independent) + worktree isolation per agent (parallel writes don't
// conflict) + judge panel on review (2 independent reviewers must agree).
//
// Args: {
//   project_root: "/path/to/project",
//   target_glob: "src/**/*.tsx",
//   transformation: "<one-paragraph description of what to do to each file>",
//   transformer_agent: "salma" | "hizkiah" | "oholiab" | ...
//   reviewers: ["jahaziel", "asaph"]   // 2+ specialists who verify
//   verify_command: "pnpm test --filter=changed"  // optional; runs after each file
//   max_files: 200
// }

export const meta = {
  name: 'mishkan-migration-wave',
  description: 'Apply a defined transformation to N files in parallel with 2 reviewers each, optional per-file verify. The MISHKAN shape of the canonical large-migration workflow.',
  whenToUse: 'Refactors, framework swaps, contract renames, API deprecations, language ports. Anywhere the transformation is per-file and the test suite (or a typecheck/build) can verify each.',
  phases: [
    { title: 'Discover',  detail: 'enumerate target files' },
    { title: 'Transform', detail: 'per-file transformer in an isolated worktree' },
    { title: 'Review',    detail: 'two reviewers per file (judge panel; both must accept)' },
    { title: 'Verify',    detail: 'optional per-file test/typecheck/build' },
    { title: 'Report',    detail: 'per-file status; the wave summary' },
  ],
}

// The workflow runner may deliver `args` as a JSON string; normalize to an
// object so the `args?.x` reads work — and stay robust if passed already-parsed.
if (typeof args === "string") args = JSON.parse(args);

if (!args?.project_root || !args?.target_glob || !args?.transformation || !args?.transformer_agent) {
  throw new Error('mishkan-migration-wave requires: { project_root, target_glob, transformation, transformer_agent, reviewers?, verify_command?, max_files? }')
}

const REVIEWERS = (args.reviewers && args.reviewers.length >= 2)
  ? args.reviewers.slice(0, 4)
  : ['uriah', 'jahaziel']     // sensible default; QA-style
const MAX_FILES = args.max_files || 200

const TRANSFORM_RESULT_SCHEMA = {
  type: 'object',
  required: ['file', 'changed', 'rationale'],
  properties: {
    file:      { type: 'string' },
    changed:   { type: 'boolean' },
    rationale: { type: 'string' },
    notes:     { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['accept', 'reason'],
  properties: {
    accept:    { type: 'boolean' },
    reason:    { type: 'string' },
    blockers:  { type: 'array', items: { type: 'string' } },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['passed', 'detail'],
  properties: {
    passed: { type: 'boolean' },
    detail: { type: 'string' },
  },
}

// --- Stage 1: Discover -------------------------------------------------
phase('Discover')
const discovery = await agent(
  `List files under ${args.project_root} matching glob ${JSON.stringify(args.target_glob)}. ` +
  `Cap at ${MAX_FILES}. Return JSON object { files: [...] }.`,
  {
    label: 'discover:targets',
    phase: 'Discover',
    agentType: 'Explore',
    schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
  }
)
const files = (discovery?.files || []).slice(0, MAX_FILES)
log(`${files.length} files match for migration; ${REVIEWERS.length} reviewers per file`)

if (files.length === 0) {
  return { wave_status: 'no-op', files_changed: [], files_rejected: [], files_failed_verify: [] }
}

// --- Stage 2-4: per-file pipeline -------------------------------------
// Each file runs through (transform → review → verify) independently.
// Transformer runs in an isolated worktree so parallel writes don't
// conflict; if both reviewers accept and verify passes, we keep it.
const wave = await pipeline(
  files,

  // Stage 2: Transform in an isolated worktree.
  (file, _, i) => agent(
    `Act as ${args.transformer_agent}. Apply the transformation to ${args.project_root}/${file}. ` +
    `Transformation: ${args.transformation}. ` +
    `Read the file first, then Edit it in-place. Do not refactor surrounding code. ` +
    `Return { file: "${file}", changed: true|false, rationale, notes? }.`,
    {
      label: `transform:${file.slice(-40)}`,
      phase: 'Transform',
      agentType: args.transformer_agent,
      isolation: 'worktree',
      schema: TRANSFORM_RESULT_SCHEMA,
    }
  ),

  // Stage 3: Two reviewers in parallel; both must accept.
  async (transformResult, file) => {
    if (!transformResult || !transformResult.changed) {
      return { file, transform: transformResult, review: { accept: false, reason: 'no change emitted' }, verify: null }
    }
    const reviews = await parallel(REVIEWERS.map((reviewer) => () => agent(
      `Act as ${reviewer}. Review the transformed ${args.project_root}/${file}. ` +
      `The transformation was: ${args.transformation}. The transformer's rationale: ` +
      `${transformResult.rationale}. Accept only if (a) the transformation is correctly applied at every site ` +
      `in the file, (b) no unrelated changes were introduced, and (c) the file still type-checks at the local ` +
      `level. Block on any finding.`,
      { label: `review:${reviewer}:${file.slice(-32)}`, phase: 'Review',
        agentType: reviewer, schema: REVIEW_SCHEMA }
    )))
    const accepts = reviews.filter(Boolean).filter(r => r.accept).length
    const allAccept = accepts === REVIEWERS.length
    return {
      file,
      transform: transformResult,
      review: { accept: allAccept, reviews: reviews.filter(Boolean), accepts, required: REVIEWERS.length },
      verify: null,
    }
  },

  // Stage 4: Optional verify (run the test/typecheck on the changed file scope).
  async (stage3) => {
    if (!stage3 || !stage3.review.accept) return { ...stage3, verify: { passed: false, detail: 'skipped — review did not accept' } }
    if (!args.verify_command) return { ...stage3, verify: { passed: true, detail: 'no verify_command configured; accepted on review alone' } }
    const v = await agent(
      `Run the verify command for the changes to ${stage3.file}: ${args.verify_command}. ` +
      `Cd to ${args.project_root} before running. Return { passed, detail }.`,
      { label: `verify:${stage3.file.slice(-40)}`, phase: 'Verify',
        agentType: 'uriah', schema: VERIFY_SCHEMA }
    )
    return { ...stage3, verify: v || { passed: false, detail: 'verifier returned null' } }
  }
)

// --- Stage 5: Report --------------------------------------------------
phase('Report')
const safe = wave.filter(Boolean)
const changed = safe.filter(w => w.transform?.changed)
const accepted_by_review = changed.filter(w => w.review.accept)
const verify_pass = accepted_by_review.filter(w => w.verify?.passed)
const verify_fail = accepted_by_review.filter(w => w.verify?.passed === false)
const rejected_by_review = changed.filter(w => !w.review.accept)

log(`Migration wave: ${changed.length} transformed, ${accepted_by_review.length} review-accepted, ` +
    `${verify_pass.length} verify-passed, ${verify_fail.length} verify-failed, ${rejected_by_review.length} rejected.`)

return {
  wave_status: verify_fail.length === 0 && rejected_by_review.length === 0 ? 'clean' : 'partial',
  files_changed_verified:        verify_pass.map(w => w.file),
  files_changed_review_rejected: rejected_by_review.map(w => ({ file: w.file, reasons: w.review.reviews.filter(r => !r.accept).map(r => r.reason) })),
  files_changed_verify_failed:   verify_fail.map(w => ({ file: w.file, detail: w.verify.detail })),
  files_no_change:               safe.filter(w => !w.transform?.changed).map(w => w.file),
  totals: {
    files_in_scope: files.length,
    transformed: changed.length,
    review_accepted: accepted_by_review.length,
    verify_passed: verify_pass.length,
    final_clean: verify_pass.length,
  },
}
