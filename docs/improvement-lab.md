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
- metrics come from Facility receipts, gateway usage, and GitHub-derived
  outcomes;
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
- **Primary metric:** the outcome the hypothesis expects to improve.
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
bucket = uint64(sha256(experiment_id + ":" + repo_id + ":" + issue_number)) % 10_000
```

The configured allocation maps that bucket to control or variant. The result is
inserted with a uniqueness constraint before the first affected run is queued.
Retries return the existing assignment.

The hash function, input encoding, and allocation boundaries become part of the
experiment snapshot. Changing allocation affects only units that have not yet
been assigned; it never rewrites existing assignments.

## Exposure proof

An assignment says which arm should run. It does not prove that Registry
resolution, runner startup, or a fallback path used that arm.

At run start, Registry resolution produces an immutable exposure manifest:

```json
{
  "experimentId": "exp_...",
  "assignmentId": "exa_...",
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

The creator specifies the hypothesis, target, arms, eligibility, assignment
unit, allocation, metric contract, minimum evidence, guardrails, budget, and
rollback reference. Validation resolves and snapshots all referenced versions.

### Pending start approval

Starting is a typed HITL action. The approver sees the exact version diff,
eligible cohort, allocation, maximum spend, primary metric, guardrails, and
rollback target. Four-eyes rules apply.

### Running

New eligible issues receive assignments. Existing delivery chains keep their
previous assignment. Results are recomputed from verified exposures and
independent outcomes.

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

Each experiment declares one primary metric, optional secondary metrics, and
mandatory guardrails. The first release uses metrics already grounded in
Facility evidence.

### Primary and secondary outcome metrics

- assessed acceptance rate;
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
- no platform failure-rate regression beyond the declared tolerance.

Metric definitions include numerator, denominator, eligibility window, terminal
window, missing-evidence behavior, and direction of improvement. Unassessed
outcomes never enter the assessed denominator.

## Evidence sufficiency

The evaluator must refuse to select a candidate until all configured conditions
hold:

- minimum exposed units per arm;
- minimum assessed outcomes per arm;
- minimum wall-clock duration;
- complete terminal window for included assignments;
- no active hard guardrail breach;
- configured minimum effect;
- configured confidence threshold where the metric supports inference.

The initial implementation should use transparent, well-tested statistical
methods appropriate to each metric and publish the raw counts alongside any
interval or test result. Facility must report the method and its limitations;
it must not collapse a low-powered result into a binary loss.

## Data model

Names are provisional; the contract matters more than prefixes.

### `experiments`

```text
id, org_id, project_id, name, hypothesis
target_kind, target_item_id, unit_type
status, allocation_basis_points
eligibility, metric_contract, safety_contract
minimum_samples, minimum_duration_days, maximum_duration_days
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
unit_type, unit_key, assignment_digest, assigned_at
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
- primary metric;
- minimum sample and duration;
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

- hypothesis and cohort;
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
6. Insufficient evidence remains inconclusive.
7. A forced guardrail breach pauses allocation and opens one platform issue.
8. A qualifying variant becomes a candidate but is not automatically active.
9. A separate human approves adoption.
10. Rollback restores the previous active version and leaves a complete audit
    trail.
11. Cross-project credentials cannot read or operate the experiment.

## Open questions

1. Should the first implementation support repository-lane exposure, or fail
   closed to platform-lane runs until exact registry-version provenance is
   available there?
2. Which statistical methods and defaults are understandable enough to expose
   without implying more certainty than the sample supports?
3. Should changing allocation always require approval, or only increases in
   variant exposure and spend?
4. Does Registry need an explicit active-version history table, or can the
   experiment ledger plus existing registry state provide a sufficient rollback
   proof?
5. Which issue metadata is stable and general enough for first-release cohort
   eligibility without embedding product-specific classification?

These questions should be resolved on the tracking issue before runtime work
begins.
