---
name: eval-baruch
description: Run the Baruch contract eval — validates research-log schema enforcement (valid fixtures pass, invalid fixtures fail) and asserts the golden case's semantic shape. Use BEFORE committing any change to research-log.schema.json, validate-research-log.sh, agents/baruch.md, or the Baruch craft skill. Does NOT call an LLM — it's a fast deterministic contract test (typically < 5s).
---

# /eval-baruch

Exercise Baruch's contract end-to-end without calling an LLM:

1. Every fixture under `evals/baruch/fixtures/valid/` MUST validate (catches over-strictness).
2. Every fixture under `evals/baruch/fixtures/invalid/` MUST be rejected (catches under-strictness).
3. The golden case `evals/baruch/golden_case/produced.json` MUST validate AND satisfy every jq assertion in `expected.yaml`.

## How to invoke

```bash
cd payload/mishkan/evals/baruch && ./run.sh
echo "exit: $?"
```

Or from anywhere in the harness checkout:

```bash
bash payload/mishkan/evals/baruch/run.sh
```

Exit codes:
- `0` → all checks passed
- `1` → one or more checks failed
- `2` → environment problem (missing `jq`, validator, or schema)

## When to run

- **Before any edit** to: `research-log.schema.json`, `validate-research-log.sh`, `agents/baruch.md`, the Baruch craft skill, or the eval itself.
- **After any such edit**, before opening a PR (the GitHub workflow `.github/workflows/eval-baruch.yml` also runs on PR — local run catches regressions faster).
- **As a sanity check** when investigating any Baruch output drift.

## When NOT to run

- Day-to-day code changes that don't touch the contract surface.
- Live LLM testing — this eval doesn't run Baruch through an LLM. To do that, run the actual research pipeline against `golden_case/input.yaml`, compare the live output to `produced.json`, and update both `produced.json` and `expected.yaml` deliberately if the change is intentional.

## What to do on failure

| Symptom | Likely cause | Action |
|---|---|---|
| valid fixture rejected | schema/validator too strict OR fixture broken | compare schema vs fixture; fix whichever is wrong |
| invalid fixture accepted | validator missing a check | add the missing check; re-run |
| golden case fails expected.yaml | Baruch output drift (intentional or regression) | inspect diff; update `produced.json` + `expected.yaml` together if intentional |

## See also

- Eval README: `payload/mishkan/evals/baruch/README.md`
- Schema: `payload/mishkan/templates/research-log.schema.json`
- Validator: `payload/mishkan/scripts/validate-research-log.sh`
- Baruch agent: `payload/mishkan/agents/baruch.md`
- CI workflow: `.github/workflows/eval-baruch.yml`
