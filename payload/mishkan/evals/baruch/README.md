# Baruch eval

A minimal, deterministic eval for the terminal stage of the research
pipeline. It validates the schema enforcement around
`research-log.json` and asserts the semantic shape of a known-good
Baruch output for one scenario.

The eval **does not** run Baruch live (that would require an LLM
call). It is a contract eval: the schema, the validator, and a
golden output are exercised end-to-end so that regressions in any
of those layers are caught.

## Layout

```
evals/baruch/
├── README.md                ← this file
├── run.sh                   ← runner (idempotent; exit 0 = all pass)
├── fixtures/
│   ├── valid/               ← known-good logs; validator MUST accept
│   │   ├── resolved-cross-harness.json
│   │   ├── curated-shortcircuit.json
│   │   ├── partial-no-write.json
│   │   └── blocked-vendor.json
│   └── invalid/             ← each isolates one schema violation
│       ├── missing-required-field.json
│       ├── bad-trigger-enum.json
│       ├── bad-outcome-enum.json
│       ├── bad-sprint-pattern.json
│       └── malformed-json.json
└── golden_case/
    ├── input.yaml           ← what Baruch receives (upstream context)
    ├── expected.yaml        ← semantic assertions (jq filter: expected JSON)
    └── produced.json        ← reference Baruch output for this input
```

## What the runner checks

1. **Every valid fixture validates.** Catches schema or validator
   over-strictness regressions.
2. **Every invalid fixture is rejected.** Catches validator
   under-strictness regressions (missing required-field check,
   missing enum check, etc.).
3. **The golden case satisfies the schema and the semantic
   assertions in `expected.yaml`.** Catches regressions in Baruch's
   reasoning shape — fields being transcribed verbatim, the
   cross-harness write rule, faithful `tools_invoked` list, etc.

## Running

```bash
./run.sh
# 0 → all checks pass
# 1 → one or more checks failed
# 2 → environment problem (missing jq, validator, schema)
```

## Updating

- **A new valid scenario.** Drop a fully-populated, valid log into
  `fixtures/valid/`. The runner picks it up automatically.
- **A new invalid scenario.** Drop a log with exactly one violation
  into `fixtures/invalid/`. Isolating the violation is the
  discipline — bundled invalid fixtures hide which check caught
  what.
- **A new golden scenario.** Add a sibling under `golden_case/` and
  extend the runner, or refactor `golden_case/` into multiple
  sub-cases. Each golden case has the
  `input.yaml` + `expected.yaml` + `produced.json` triplet.
- **Running Baruch live to refresh `produced.json`.** Re-run the
  pipeline against `input.yaml`; copy the new output to
  `produced.json`. Inspect the diff; if Baruch's reasoning shape
  changed, update `expected.yaml` deliberately.

## The expected.yaml format

```
<jq filter>: <expected JSON value>
```

- Lines starting with `#` are comments.
- Blank lines are ignored.
- The expected side is canonical JSON: `"string"`, `123`, `true`,
  `false`, `null`, `[...]`, `{...}`. Bare words become strings.
- The filter is anything jq accepts. Single-quoted strings inside
  the filter are fine (jq accepts them; they avoid escaping in YAML).

## See also

- The schema: [`../../templates/research-log.schema.json`](../../templates/research-log.schema.json)
- The validator: [`../../scripts/validate-research-log.sh`](../../scripts/validate-research-log.sh)
- Baruch agent: [`../../agents/baruch.md`](../../agents/baruch.md)
- Baruch craft skill: [`../../skills/baruch-research-reporting-craft/SKILL.md`](../../skills/baruch-research-reporting-craft/SKILL.md)
