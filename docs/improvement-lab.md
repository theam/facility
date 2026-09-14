# Facility Improvement Lab

**Status:** proposed  
**Tracking issue:** [#188](https://github.com/theam/facility/issues/188)

## Summary

Facility already turns repeated delivery failures into evidence-backed learning
proposals. A human can approve a proposed skill or rule, publish an immutable
registry version, and later learning packets compare recurrence before and
after activation. That closes the governance loop, but the comparison remains
observational: task difficulty, repository mix, model changes, provisioning,
and team behavior can all move at the same time.

The Improvement Lab adds a governed experiment lifecycle between proposal and
adoption. It compares an immutable control version with an immutable variant,
assigns eligible issues deterministically, records actual exposure in run
receipts, evaluates independent delivery outcomes and cost guardrails, and
produces a human-gated adoption decision. It does not let an agent activate its
own proposal, weaken a safety invariant, or merge repository code.

The first vertical slice is intentionally narrow:

- targets are published skill and agent-contract registry versions;
- the assignment unit is one GitHub issue and its delivery chain;
- one control and one variant run concurrently;
- exactly one primary outcome is declared: assessed acceptance rate;
- one-shot delivery, review rounds, human fixup commits, lead time, and cost
  remain secondary metrics or guardrails;
- the complete analysis contract is immutable and digest-bound before the first
  issue is assigned;
- a deterministic evaluator decides evidence sufficiency and guardrail status;
- separate human decisions start the experiment and adopt the candidate;
- rollback restores the previous active registry reference.

Shadow reviewers, shadow guards, model routing, and arbitrary agent workflow
composition are follow-up work, not part of the first contract.

## Problem

The current learning loop can answer whether a tracked failure recurred less
often after an improvement was activated. It cannot isolate the improvement
from other changes during the same before/after window. A lower recurrence rate
may be caused by easier work, a different repository mix, a model upgrade, a
better provision command, or simple sampling noise.

Activation also makes the eligible project the first validation cohort. Human
approval protects accountability, but approval alone does not establish that a
change improves delivery or that its additional cost is justified.

Facility already owns the required evidence surfaces:

- immutable registry versions identify the exact control and variant content;
- run receipts prove which agent, model, checks, and costs were observed;
- the gateway attributes model usage and enforces budgets;
- GitHub-derived outcomes supply acceptance, one-shot delivery, review rounds,
  human fixups, and lead time independently of agent self-report;
- HITL provides separation between proposal, experiment start, and adoption;
- Watchtower can detect guardrail breaches and open deduplicated issues;
- the audit ledger records every state transition.

The missing capability is a deterministic coordinator that joins those
surfaces into a controlled test.

## Goals

1. Determine whether one immutable registry variant improves a declared
   delivery outcome relative to an immutable control.
2. Preserve Facility's human gates and separation of duties.
3. Make assignment, exposure, evaluation, adoption, and rollback independently
   auditable.
4. Prevent cost, security, reliability, or human-friction regressions from being
   hidden behind an improved headline metric.
5. Reuse Registry, runs, receipts, outcomes, budgets, Watchtower, HITL, and
   audit rather than create parallel evidence systems.
6. Produce honest `inconclusive` results when the evidence is insufficient.

## Non-goals

- Experimenting with authentication, authorization, tenant isolation, secrets,
  branch protection, human merge gates, or receipt integrity.
- Letting the learning agent select a winner or publish its own proposal.
- Automatically merging repository changes.
- Treating unassessed outcomes as failed outcomes.
- Supporting multi-arm bandits or adaptive allocation in the first version.
- General workflow composition or arbitrary multi-agent graphs.
- Claiming that one project's result is a universal model or prompt benchmark.

## Invariants

1. **Published content remains immutable.** An experiment references exact
   registry version IDs; it never edits a published version.
2. **Assignment is persisted before execution.** The same issue cannot change
   arms midway through architect, builder, review, or CI repair.
3. **Assignment is not exposure.** Results include a run only when the receipt
   proves the assigned versions were actually used.
4. **The evaluator is deterministic.** An LLM may propose a hypothesis but does
   not calculate evidence sufficiency, guardrail breaches, or winner status.
5. **Safety boundaries are not variables.** An arm cannot weaken guards, human
   gates, permissions, protected-branch rules, secrets policy, sandbox
   isolation, or receipt verification.
6. **Every denominator is explicit.** Assessed and unassessed outcomes remain
   distinguishable.
7. **Start and adoption are separate decisions.** Approval to collect evidence
   is not approval to activate the variant globally.
8. **Rollback is designed before start.** An experiment without a valid
   rollback target cannot run.
9. **Concurrent experiments cannot silently overlap.** Experiments that mutate
   the same effective target for the same cohort are rejected unless a future
   composition contract explicitly permits them.
10. **Budgets remain authoritative.** Experiment allocation never overrides a
    hard organization, project, agent, or run budget.
11. **The analysis is preregistered.** Primary outcome, cohort, assignment
    algorithm, allocation, sample, duration, missing-evidence treatment, and
    uncertainty rule cannot change after start.
12. **Interim monitoring cannot select a winner.** Watchtower evaluates safety
    guardrails while an experiment runs, but candidate selection occurs only at
    the terminal analysis point declared in the analysis contract.

## Terminology

- **Target:** the part of the governed system being changed, initially a skill
  or agent-contract registry item.
- **Arm:** an immutable configuration participating in an experiment. The first
  release supports `control` and `variant`.
- **Assignment unit:** the durable unit bucketed into one arm, initially a
  GitHub issue.
- **Eligibility:** the immutable cohort predicate captured when the experiment
  starts.
- **Assignment:** the persisted arm selection for one eligible unit.
- **Exposure:** proof that a run actually used the assigned arm.
- **Primary outcome:** the single outcome the hypothesis expects to improve.
- **Guardrail:** a metric whose regression pauses or invalidates the experiment.
- **Candidate:** a variant with sufficient evidence for a human adoption
  decision. Candidate status does not publish anything.

## Why the issue is the first assignment unit

Randomizing each model request or run would contaminate the treatment. An
architect could plan with the variant while the builder uses the control, or a
CI repair run could silently switch behavior after the pull request exists.

The first release therefore assigns the originating issue and carries that arm
through every linked Facility run. This preserves a coherent delivery chain and
matches the existing issue-to-pull-request outcome model.

Experiments that cannot identify a stable originating issue are ineligible in
the first release. Later target adapters may define other stable units, such as
a pull request for a shadow reviewer.

## Deterministic assignment

For an eligible issue, the platform computes a bucket from stable identifiers:

```text
encoded = length_prefix(experiment_id) || length_prefix(repo_id) || length_prefix(issue_number)
bucket = uint64_be(sha256(encoded)[0:8]) % 10_000
```

The configured allocation maps that bucket to control or variant. The result is
inserted with a uniqueness constraint before the first affected run is queued.
Retries return the existing assignment.

The first slice names this algorithm
`facility.issue-assignment.sha256.v1`. Its input is the UTF-8 encoding of the
length-prefixed tuple `(experiment_id, repo_id, issue_number)`. Length prefixes
avoid ambiguous concatenation; the algorithm name fixes tuple order and
encoding. The first eight digest bytes are interpreted as an unsigned
big-endian integer and reduced modulo 10,000.

The first slice uses a fixed 5,000/5,000 control/variant boundary. Hash inputs,
algorithm version, and allocation are part of the preregistered analysis
contract and cannot change after start. A different allocation or hash version
requires a new experiment rather than mutating an active cohort.

## Preregistered analysis contract

Before start approval, Facility canonicalizes and digest-binds one complete
analysis contract. Start approval covers that exact digest. The first
assignment stores the same digest, and every exposure receipt refers to it.

Conceptually:

```json
{
  "schema": "facility.experiment.analysis.v1",
  "primaryOutcome": {
    "name": "assessed_acceptance_rate",
    "numerator": "outcomes where accepted = true",
    "denominator": "terminal outcomes where accepted is not null",
    "direction": "increase",
    "minimumEffectBasisPoints": 500
  },
  "assignment": {
    "algorithm": "facility.issue-assignment.sha256.v1",
    "inputs": ["experiment_id", "repo_id", "issue_number"],
    "controlBasisPoints": 5000,
    "variantBasisPoints": 5000
  },
  "cohort": {
    "snapshotDigest": "sha256:...",
    "projectId": "proj_...",
    "repoIds": ["repo_..."],
    "targetAgentDefId": "agd_...",
    "eligibleAfter": "2026-09-01T00:00:00Z",
    "predicate": {},
    "exclusions": ["synthetic_canary", "learning", "security_sweep"]
  },
  "enrollment": {
    "minimumAssessedPerArm": 60,
    "minimumDurationDays": 14,
    "maximumDurationDays": 30,
    "outcomeMaturationDays": 7
  },
  "missingEvidence": {
    "unassessedTreatment": "exclude_from_primary_denominator",
    "minimumAssessmentCoverage": 0.8,
    "maximumCoverageDifference": 0.1
  },
  "uncertainty": {
    "method": "newcombe_score_interval_for_risk_difference",
    "confidenceLevel": 0.95,
    "candidateRule": "lower_bound_above_zero_and_minimum_effect_met"
  }
}
```

The numeric sample and duration values above are illustrative defaults, not a
universal claim that 60 outcomes can detect every useful effect. Creation must
record the chosen values before start, and validation must show the baseline,
minimum detectable effect, and power assumptions used to justify them. Once
approved, none of these fields can be amended; a changed hypothesis or analysis
plan is a new experiment.

The cohort snapshot contains the exact normalized eligibility predicate and
scope available at start, plus its digest. For future issues, Facility also
records the issue metadata used to evaluate eligibility at assignment time.
Later label or project changes do not rewrite eligibility or arm assignment.

## Exposure proof

An assignment says which arm should run. It does not prove that Registry
resolution, runner startup, or a fallback path used that arm.

At run start, Registry resolution produces an immutable exposure manifest:

```json
{
  "experimentId": "exp_...",
  "assignmentId": "exa_...",
  "analysisContractDigest": "sha256:...",
  "arm": "variant",
  "unit": {
    "type": "github_issue",
    "repoId": "repo_...",
    "issueNumber": 842
  },
  "registryVersions": {
    "architect-contract": "regv_...",
    "migration-analysis": "regv_..."
  }
}
```

The Facility-owned runner includes the manifest digest in the terminal receipt.
The control plane records an exposure only after receipt schema and digest
verification succeed. Runs without valid exposure proof remain visible as
assignment failures but do not enter the outcome comparison.

Repository-lane support must preserve the same property using the existing
GitHub OIDC provenance boundary. If exact exposure cannot be proven in that
lane, the first implementation may support platform-lane experiments only
rather than silently lower the evidence bar.

## Experiment lifecycle

```text
draft
  -> pending_start_approval
  -> approved
  -> running
  -> paused
  -> running
  -> inconclusive | rejected | candidate
  -> adopted
  -> rolled_back
```

`canceled` is terminal from any state before adoption.

### Draft

The creator specifies the hypothesis, target, arms, and complete analysis
contract: one primary outcome, cohort snapshot, assignment algorithm and
allocation, minimum sample and duration, maturation window, missing-evidence
treatment, uncertainty rule, secondary metrics, guardrails, budget, and
rollback reference. Validation resolves all referenced versions, canonicalizes
the contract, and records its digest.

### Pending start approval

Starting is a typed HITL action. The approver sees the exact version diff,
eligible cohort, allocation, maximum spend, primary outcome, analysis contract
digest, guardrails, and rollback target. Four-eyes rules apply.

### Running

New eligible issues receive assignments. Existing delivery chains keep their
previous assignment. Safety and integrity indicators are recomputed from
verified exposures and independent outcomes, but interim results cannot assign
candidate status.

### Paused

No new units are assigned. Existing runs may finish so their evidence is not
discarded. Automatic pause occurs on hard guardrail breach, integrity failure,
or invalid target resolution. Watchtower opens a deduplicated platform issue.

### Inconclusive

The experiment reached its maximum duration or operator stop without satisfying
the evidence contract. No arm wins and no registry reference changes.

### Candidate

The deterministic evaluator found sufficient evidence, improvement in the
primary metric, and no guardrail breach. Candidate status creates a separate
adoption proposal; it does not publish the variant.

### Adopted

A separate human approves adoption. The Registry changes the active reference
to the already-published variant and records the previous active version as the
rollback target.

### Rolled back

The prior active reference is restored. For this first slice, rollback changes
only Registry activation state; it never edits repository code.

## Metric contract

The first slice has exactly one primary outcome: **assessed acceptance rate**.
Its numerator is terminal outcomes for which independent GitHub evidence
establishes `accepted = true`; its denominator is terminal outcomes for which
`accepted IS NOT NULL`. Neither the learning agent nor an experiment operator
may substitute another primary outcome after start.

### Secondary outcome metrics

- one-shot delivery rate;
- review rounds per assessed pull request;
- human fixup commits per assessed pull request;
- issue-to-merge lead time;
- terminal delivery success rate.

### Economic metrics

- cost per exposed run;
- cost per terminal pull request;
- cost per assessed accepted outcome;
- input and output tokens per accepted outcome.

Cost per accepted outcome is preferred over average run cost: a cheaper arm
that requires more retries or produces fewer accepted pull requests may be more
expensive in practice.

### Mandatory guardrails

- no increase in verified security or deterministic guard failures;
- no acceptance regression beyond the declared tolerance;
- no cost-per-accepted-outcome increase beyond the declared tolerance;
- no receipt-integrity regression;
- no platform failure-rate regression beyond the declared tolerance;
- assessment coverage in each arm meets the preregistered minimum;
- the difference in assessment coverage between arms stays within the
  preregistered maximum.

Metric definitions include numerator, denominator, eligibility window, terminal
window, missing-evidence behavior, and direction of improvement. Unassessed
outcomes never enter the assessed denominator. However, insufficient or
materially different assessment coverage makes the result `inconclusive`
rather than allowing selective missingness to favor an arm.

## Evidence sufficiency

The evaluator must refuse to select a candidate until all configured conditions
hold:

- minimum exposed units per arm;
- minimum assessed outcomes per arm;
- minimum wall-clock duration;
- complete terminal window for included assignments;
- no active hard guardrail breach;
- configured minimum effect;
- the two-sided 95% Newcombe score interval for the variant-minus-control risk
  difference has a lower bound above zero.

The primary estimate must also meet the preregistered minimum practical effect;
statistical separation alone is insufficient. Facility publishes each arm's
raw numerator, assessed denominator, eligible/exposed count, assessment
coverage, point estimate, interval, and exclusions.

Watchtower may inspect interim data to pause enrollment for a safety, integrity,
budget, or missingness breach. The primary analysis runs once, after enrollment
closes and the preregistered outcome-maturation window ends. It cannot select a
winner through repeated peeking. A future sequential design would require a new
versioned analysis schema with its own stopping and error-spending rules.

## Data model

Names are provisional; the contract matters more than prefixes.

### `experiments`

```text
id, org_id, project_id, name, hypothesis
target_kind, target_item_id, unit_type
status
analysis_contract, analysis_contract_digest, safety_contract
rollback_version_id
created_by, start_approved_by, adoption_approved_by
started_at, finished_at, created_at, updated_at
```

### `experiment_arms`

```text
id, org_id, experiment_id, name
registry_version_ids, configuration_snapshot
created_at
```

Exactly one `control` and one `variant` arm exist in the first release.

### `experiment_assignments`

```text
id, org_id, project_id, experiment_id, arm_id
unit_type, unit_key, eligibility_input, assignment_digest
analysis_contract_digest, assigned_at
```

Required uniqueness:

```text
UNIQUE(experiment_id, unit_type, unit_key)
```

### `experiment_exposures`

```text
id, org_id, project_id, experiment_id, assignment_id, arm_id
run_id, manifest, manifest_digest, receipt_digest, exposed_at
```

Required uniqueness:

```text
UNIQUE(experiment_id, run_id)
```

### `experiment_events`

Append-only state ledger:

```text
experiment_id, seq, type, actor, data, ts
```

Events include creation, validation, approval, start, pause, guardrail breach,
candidate selection, adoption, rejection, cancellation, and rollback.

Results should initially be computed from source evidence or rebuildable
rollups. A cached results table must never become the only evidence path.

## Overlap prevention

Two simultaneous experiments can make each other's results uninterpretable.
The API rejects a new running experiment when all of the following overlap:

- organization and project;
- effective target item;
- assignment unit;
- eligible cohort.

The first release should fail closed on ambiguous overlap. A future composition
model may allow explicitly declared factorial experiments, but implicit overlap
is never acceptable.

## Safety contract

The validator rejects arms that attempt to vary:

- permission grants or role bindings;
- HITL separation of duties;
- branch protection or human Gate 2;
- webhook, OAuth, or MCP authentication;
- secret handling or sandbox isolation;
- receipt schema, integrity, or provenance enforcement;
- required deterministic checks or guards;
- hard budget enforcement.

An experiment may select only published registry versions in the same
organization/project scope available to the target agent. Start revalidates all
references and target scope after human approval.

## Budget behavior

The draft declares a maximum experiment spend and inherits every existing
budget. Allocation stops when the experiment budget is exhausted; it never
overrides the gateway. Cost attribution uses verified exposures, while total
experiment spend also reports assignment and infrastructure failures so they
cannot disappear from economics.

Changing allocation or maximum spend is a new audited action. Increasing spend
requires human approval.

## Watchtower integration

Watchtower gains experiment health signals:

- assignment without a queued run;
- run without valid exposure proof;
- arm resolution drift;
- receipt integrity failure;
- guardrail breach;
- experiment stuck beyond its evaluation schedule;
- adoption or rollback failure.

Each condition produces one fingerprinted platform issue and resolves on
recovery where appropriate. Health evidence is independent from the learning
agent's narrative.

## Learning integration

The learning agent may propose an experiment hypothesis but receives no
permission to approve, start, adopt, or roll back. A valid proposal includes:

- specific evidence references;
- target and immutable control/variant versions;
- eligible cohort;
- expected effect;
- assessed acceptance rate as the primary outcome;
- assignment algorithm and allocation;
- minimum sample, duration, and maturation window;
- unassessed-outcome treatment and uncertainty rule;
- cost and safety guardrails;
- rollback target.

The maximum of five nightly proposals still applies. A proposal that cannot
state how evidence will distinguish the arms does not meet the proposal bar.

## API surface

The first slice needs these conceptual operations:

```text
POST /v1/experiments
GET  /v1/experiments
GET  /v1/experiments/:id
POST /v1/experiments/:id/request-start
POST /v1/experiments/:id/pause
POST /v1/experiments/:id/resume
POST /v1/experiments/:id/stop
GET  /v1/experiments/:id/results
GET  /v1/experiments/:id/assignments
GET  /v1/experiments/:id/exposures
POST /v1/experiments/:id/request-adoption
POST /v1/experiments/:id/request-rollback
```

Start, adoption, rollback, allocation increase, and spend increase use durable
HITL proposals. Exact route names should follow the existing route conventions
when implementation begins.

Suggested permissions:

```text
experiments:read
experiments:create
experiments:operate
experiments:approve
experiments:adopt
experiments:rollback
```

Project-scoped machine keys may report exposure but cannot approve lifecycle
transitions.

## User experience

The experiment detail view must show the exact change and the evidence, not only
a winner badge:

- hypothesis, frozen cohort, analysis schema, and contract digest;
- control/variant Registry version diff;
- allocation, assignments, valid exposures, and assessment coverage;
- raw numerator and denominator for every rate;
- primary, secondary, economic, and guardrail metrics by arm;
- duration and sample requirements still outstanding;
- integrity or delivery exclusions with reasons;
- complete lifecycle ledger;
- pause, stop, adopt, reject, and rollback actions permitted to the viewer.

Facility should label observational summaries and controlled experiment results
differently so users do not infer causality from ordinary before/after reports.

## Verification strategy

This surface affects authorization, tenant scope, money, Registry activation,
and outcome interpretation. It requires unit and integration coverage under the
repository's critical-change rules.

### Unit coverage

- deterministic bucketing and stable encoding;
- eligibility snapshots;
- canonical analysis-contract encoding and digest stability;
- metric numerator/denominator definitions;
- evidence sufficiency and inconclusive results;
- guardrail direction and thresholds;
- forbidden target validation;
- overlap detection;
- receipt exposure validation.

### Integration coverage

- concurrent assignment creates one durable arm;
- duplicate delivery does not duplicate exposure;
- one issue's architect/builder/repair chain keeps one arm;
- cross-project and cross-organization access is denied;
- an assignment without a verified receipt is excluded from comparison;
- unassessed outcomes do not lower acceptance;
- insufficient or differential assessment coverage is inconclusive;
- interim recomputation cannot select a candidate;
- changing the primary outcome, cohort, allocation, sample, duration,
  missing-evidence rule, or uncertainty rule after start is rejected;
- hard budget exhaustion stops new assignment;
- guardrail breach pauses and opens one deduplicated platform issue;
- the proposing principal cannot approve start or adoption;
- adoption changes only the active reference and preserves rollback;
- rollback restores the exact previous active version;
- registry drift between approval and start fails closed.

External systems use deterministic fakes or local servers; the default suite
requires no live credentials.

## Delivery plan

### Milestone 1 — Contract and evidence path

- schemas and migrations;
- draft validation and overlap prevention;
- deterministic issue assignment;
- platform-lane Registry resolution by arm;
- receipt exposure manifest;
- read-only results from existing outcomes and gateway usage.

No adoption automation is required to validate the evidence path.

### Milestone 2 — Governed lifecycle

- typed start/adoption/rollback actions;
- four-eyes enforcement;
- experiment budget;
- pause and inconclusive states;
- active Registry reference adoption and rollback;
- audit and Watchtower integration.

### Milestone 3 — Operator experience

- web views;
- REST, CLI, SDK, and MCP read surfaces;
- proposal diff and evidence views;
- self-host and operational documentation;
- reference experiment in a disposable project.

### Follow-up milestones

- golden-set evaluation before live allocation;
- reviewers in shadow mode;
- guards in non-blocking shadow mode;
- model-routing targets within existing allowlists;
- explicitly modeled agent-composition experiments.

## Acceptance target

A disposable project proves this journey:

1. Two published architect contract versions become control and variant.
2. A human different from the creator approves experiment start.
3. Eligible issues receive stable persisted assignments.
4. Linked platform runs resolve the assigned version and emit valid exposure
   receipts.
5. GitHub outcomes and gateway cost produce arm-level results with explicit
   assessed denominators.
6. The evaluator uses the immutable analysis contract approved before the first
   assignment; interim results cannot select a candidate.
7. Insufficient or materially asymmetric assessment remains inconclusive.
8. A forced guardrail breach pauses allocation and opens one platform issue.
9. A qualifying variant becomes a candidate but is not automatically active.
10. A separate human approves adoption.
11. Rollback restores the previous active version and leaves a complete audit
    trail.
12. Cross-project credentials cannot read or operate the experiment.

## Open questions

1. Should the first implementation support repository-lane exposure, or fail
   closed to platform-lane runs until exact registry-version provenance is
   available there?
2. Which baseline and minimum detectable effect assumptions should the first
   project use to justify its preregistered sample requirement?
3. Does Registry need an explicit active-version history table, or can the
   experiment ledger plus existing registry state provide a sufficient rollback
   proof?
4. Which issue metadata is stable and general enough for first-release cohort
   eligibility without embedding product-specific classification?

These questions should be resolved on the tracking issue before runtime work
begins.
