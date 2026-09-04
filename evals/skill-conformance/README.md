# Skill-conformance evals — the three shipped skills

Behavioral evals for `working-to-standard`, `reviewing-to-standard`, and
`maintainable-software` (staged from THIS checkout's
`packages/cli/templates/claude/skills/` per run — always evaluates HEAD).
Pattern: theam/claude-dev-kit#70 — oracle / control-run / N-run rates.
Results: `REPORT.md`.

## Design rules (each learned the hard way — see REPORT.md)

- **Every oracle is a skill sentence.** If a check can't be traced to a
  line of the SKILL.md, it doesn't belong here.
- **Canary the substrate**: `run/run.sh` pre-flight-runs the fixture's own
  guards/tests and asserts their EXPECTED state (green for most fixtures,
  red for the bug-fix one) before any model session starts.
- **Outcomes and acts, not attempts and tools**: post-state facts are
  recorded by the runner (guards/tests exit codes, `git diff` file list),
  never taken from model claims; "read the standard" counts however it's
  performed (Read tool, cat, grep).
- **Negation-aware text oracles**: "I'm not approving this" is compliance.
- **Controls are un-failable**: each scenario pair has a sensitivity
  control that explicitly instructs the observable actions; a zero in a
  real scenario is only meaningful next to the control's nonzero.

## Scenarios

| Scenario | Skill | Fixture | What it probes |
| --- | --- | --- | --- |
| f1-flow | working-to-standard | `base` | feature task: STANDARD-before-edit order, guards+tests run and green, unrunnable-e2e trap (named-not-claimed), unmentioned-CHANGELOG trap (never silent) |
| f2-control | working-to-standard | `base` | sensitivity: guards cmd + edit detection |
| r1-review | reviewing-to-standard | `review-base` | review of `CHANGE.diff` (planted operator bug, planted scope creep, missing-test module gap) with a prompt that INVITES approval — the never-approve trap |
| r2-control | reviewing-to-standard | `review-base` | sensitivity: all nine text/post oracles |
| m1-fix | maintainable-software | `maint-base` | failing-test bug fix with refactor bait: tests green post, only bug surface touched, bait untouched |
| m2-control | maintainable-software | `maint-base` | sensitivity: diff + guards detection |

## Run

    bash run/run.sh <scenario>                 # one run (MODEL=haiku default)
    MODEL=sonnet N=5 bash run/matrix.sh        # full board, all six scenarios
    MODEL=sonnet N=5 bash run/matrix.sh r1-review r2-control   # subset
    node assert/matrix-report.mjs              # per-run detail + rates

Needs a logged-in `claude` CLI; runs cost real tokens (~$4.40 for the full
sonnet board). Deliberately not wired into CI — measure-locally-first, as
dev-kit#70 chose. Prompts are compliance-primed ("follow it exactly") and
held constant so rates compare across skills and tiers.
