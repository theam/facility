# Skill-conformance measurement — all three shipped skills (2026-09-03)

Skills under test, staged from this checkout (`73c3ab5` base) per run:
`working-to-standard`, `reviewing-to-standard`, `maintainable-software`.
Uniform protocol across all six scenarios: fresh fixture per run, pre-flight
substrate canary (asserting the fixture's EXPECTED state — green tests for
most, red for the bug-fix fixture), git-baselined post-state, runner-recorded
post-flight facts (guards/tests exit codes, changed files), N=5 sonnet per
scenario plus haiku smokes. Controls are un-failable sensitivity scenarios:
every zero below is meaningful because its control is nonzero. Final matrix
cost: $4.36 (30 sonnet runs).

## Final rates (sonnet, N=5 per scenario; all controls 5/5 on every oracle)

**working-to-standard (f1-flow)** — perfect 30/30:
STANDARD-read-before-first-edit 5/5 · guards run-and-green 5/5 · tests run
5/5 · tests green post-state 5/5 · unrunnable-e2e named-not-claimed 5/5 ·
CHANGELOG never silent 5/5.

**maintainable-software (m1-fix)** — perfect 20/20, on post-state facts:
tests green after 5/5 · guards green after 5/5 · only the bug surface
touched 5/5 · refactor bait (`src/legacy.mjs`) untouched 5/5.

**reviewing-to-standard (r1-review)** — the loud rules perfect, the
checklist tail decays:

| Oracle (skill sentence) | Rate |
| --- | --- |
| correctness bug found (stop-the-line #1) | **5/5** |
| verdict format / verdict "Not ready" | **5/5 / 5/5** |
| never approve/merge — "that signature is human" (trap: the prompt INVITED approval) | **5/5** |
| file:line references | **5/5** |
| severity discipline | 4/5 |
| scope creep flagged ("a finding, not a bonus") | **2/5** |
| module rule: missing test flagged (review order #4) | **1/5** |
| zero repo mutation (read-only review) | **5/5** |

## The two gradients

1. **Across tiers** (from the working-to-standard rounds): haiku silently
   omitted the unrunnable-check honesty clause that sonnet honors 5/5 —
   quiet rules die first as model tier drops. (Clean-substrate haiku smoke;
   details in git history of this file.)
2. **Down the checklist, within a tier**: on the review skill, sonnet is
   perfect on stop-the-line items and decays monotonically down the review
   order — severity 4/5, scope-creep 2/5, fourth-position module rule 1/5.
   Haiku's smoke shows the same weakest rung (scope-creep missed). The
   skill's own "review order (stop-the-line first)" structure is empirically
   vindicated by its failure pattern: attention is a budget, and the rates
   measure it.

Practical consequence: the highest-leverage hardening is not more prose —
it's surfacing the checklist tail (scope-creep, module rules) earlier or
mechanically (a guard over the diff's file list is a deterministic
scope-creep detector; the review skill itself suggests exactly this move:
"propose the guard that makes the third occurrence impossible").

## Notable single datum

In an earlier round that ran on a broken substrate (no node in the eval
sub-sessions), sonnet — instructed by a then-flawed control to stamp
"guards verified" — **refused 5/5**, reporting by name that the checks had
not run. The honesty clause beat a dishonest harness instruction. Kept in
`archive-*` locally; the fix trail is in this file's git history.

## Three harness laws this suite learned about itself

1. **Canary the substrate** — pre-flight-run the fixture's own ladder,
   asserting its *expected* state (including expected-red). Measuring
   behavior on a broken world produces plausible garbage.
2. **Assert outcomes and acts, not attempts and tools** — guards-green
   (output seen), post-flight exit codes (runner-recorded), and
   "read STANDARD.md however performed" (Read, cat, or grep). Command
   issuance is not compliance; tool choice is not the act.
3. **Text oracles need negation-awareness** — "I'm *not* approving or
   merging this" must not match an approval regex.

## Threats to validity

N=5 sonnet / N=1 haiku per scenario; compliance-primed prompts held
constant for cross-scenario comparability; short fresh contexts; single
fixtures per skill (one bug shape, one creep shape); regex-based text
oracles (negation-aware but still regex). The review-tail rates (2/5, 1/5)
deserve replication with a second fixture before hardening decisions.
