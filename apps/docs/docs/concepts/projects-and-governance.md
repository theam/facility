---
title: Projects & governance
---

# Projects & governance

A **project** is the unit of governance: one product, one or more GitHub
repositories, its own agents, budgets, knowledge base, and analytics —
cleanly separated from every other project in the organization.

## Kickstart

Kickstart turns a repository into a working factory. The platform detects
the stack, asks the few questions that matter (default branch, provision
command, check commands, modules), renders the versioned template set —
workflows, guards, skills, the standard, operating contracts — and opens a
pull request. A human merges it: the platform never pushes to your default
branch. Greenfield or brownfield, the defaults are the production-proven
shape; every choice can be changed later.

## Fingerprints

The platform records a manifest — path and SHA-256 — of every file it
manages in your repo, tied to the template-set version. On every push that
touches managed paths, the manifest is re-verified:

- **ok** — files match the installed system version.
- **drifted** — a managed file changed outside an upgrade. Drift is a signal,
  not a police action: review it, then either restore or **adopt** the change
  (re-baseline, on the record).
- **corrupted** — managed files are missing or mangled; the repo's integrity
  is in question and the platform raises an issue.

## Upgrades

The template set is versioned. Upgrading renders the target version against
your recorded answers, three-way-merges it with what's in the repo, and opens
a PR. Files you never touched apply cleanly; conflicts are reported alongside,
never silently overwritten. The fingerprint advances only when the PR merges.

## System versioning

Every project records its system version. Org policy can pin projects,
preview diffs between versions, and roll forward on your schedule — the whole
method is data, not folklore.

## Required Architect plans for Builder

Projects can set `builderPlanPolicy` to `optional` or `required`. The default is
`optional`, including for projects created before this setting existed, so an
upgrade does not silently change their dispatch behavior.

Within the Facility platform lane, `required` makes Gate 1 a runtime invariant. A Builder can only be created by
the internal executor for an approved `plan_acceptance` proposal with trusted
freshness evidence. Run-now,
Story Build, GitHub slash commands, MCP tools, resumes, schedules, and inbound
integrations cannot create an unlinked Builder run. There is no break-glass
route.

Facility accepts `required` only when every connected repository has a recent
`ok` fingerprint from its default branch and routes both `builder` and
`codex-builder` to `platform`. Connecting another repository requires switching
back to `optional`, connecting and verifying its platform configuration, then
re-enabling the gate. The generated repo-lane workflow does not yet call this
policy and must not remain enabled for Builder on a required project.
If the default-branch manifest later removes either platform lane, Facility
marks the repository fingerprint drifted and rejects the synchronized config;
restore and verify the governed files before dispatching again.
Managed pushes mark the fingerprint pending before asynchronous verification,
and approval rechecks the cached lane plus a recent `ok` fingerprint. Approval
also reads the repository's live default-branch SHA and the live GitHub issue
revision; a cached mirror or caller-supplied value is never accepted as
freshness evidence.

Policy activation, run admission, repository mutation, and Builder-relevant
agent mutations share a per-project transaction lock. Admission also persists
an immutable canonical `builder` or `codex-builder` run mode; later edits to an
agent name or command trigger cannot erase the role the run was admitted as.
Enabling `required` conservatively refuses to proceed while any older run is
non-terminal. This covers legacy rows created before immutable admission and
prevents a run that observed `optional` from crossing the activation boundary.

Denials use stable API and audit codes:

- `builder_plan_required` when no acceptance was supplied;
- `builder_plan_expired`, `builder_plan_rejected`, or
  `builder_plan_already_consumed` for proposal lifecycle failures;
- `builder_plan_stale` when the recorded base or issue revision changed;
- `builder_plan_freshness_unavailable` when Facility cannot prove that those
  revisions are still current; and
- `builder_plan_context_invalid` for malformed or non-canonical provenance.

The acceptance records the exact plan SHA-256, approving human principal and time,
Architect receipt, repository, and issue. Base-commit provenance must come from
the workspace/base tracking contract, and issue freshness must come from a live,
canonical digest of the exact Architect issue scope rather than the mutable
mirror timestamp. If either trusted provider is unavailable, `required` denies
Builder with `builder_plan_freshness_unavailable`; it never falls back to caller
input.
For a required project, an API key or agent cannot supply the approval event;
the approving principal must be a Facility user or the authenticated GitHub
human who issued the canonical `/builder` command, and must be distinct from
the proposal opener.

Architect records the checked-out default-branch SHA and a versioned canonical
digest of the issue title, body, state, author, URL, labels, and material
comments. Facility excludes its own progress/publication comments and exact
approval-only Builder comments from that digest. At approval, on worker receipt,
and once more after the worker atomically claims the run, Facility re-reads the
live branch and issue. A mismatch returns `builder_plan_stale`; an unavailable
read returns `builder_plan_freshness_unavailable`, before credentials or a
sandbox are released. The runner also clones with the approved SHA as its
expected head, so a later default-branch movement aborts before the model runs.

Proposals created before this coherent deployment are not backfilled. Run
Architect again, approve the newly published proposal, and do not edit or reuse
an old plan. The approved plan body and its SHA-256 remain immutable even though
GitHub cannot atomically lock an issue: an issue edit after the worker's final
freshness read cannot be excluded atomically, but it cannot rewrite the scope
that Builder receives.

Architect plan publication is a durable, retryable delivery. A scheduled
reconciler resumes terminal Architect runs whose plan comment was not recorded,
uses a stable publication marker to discover a comment created during an
ambiguous response, and closes or suppresses stale publications when their
proposal is no longer open. GitHub comment creation offers no idempotency key,
so delivery remains technically at-least-once; the stable marker, bounded retry,
and reconciler make duplicate publication observable and recoverable.

Two operational follow-ups remain. A generic inbound event
denied by the gate stays unprocessed, and replaying the same delivery ID does
not automatically execute it again; an operator must create a fresh delivery
after correcting the source workflow. Also, the web UI disables Builder trigger
controls while `required` is active, including editing an existing Builder
schedule. Remove or change that schedule before activation (or temporarily
return the project to `optional` through the governed project settings flow).
