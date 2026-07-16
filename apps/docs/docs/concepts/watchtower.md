---
title: Watchtower
---

# The watchtower

An agent pipeline fails politely: a dead trigger stops summoning agents, a
mis-permissioned lane approves silence, and nothing turns red. The watchtower
is the layer that makes silence visible — platformized from the vendored
scripts, per project, with the same non-negotiable design rules:

1. **The monitor does not depend on what it monitors.** Health judgments read
   the GitHub API directly — never the telemetry the pipeline writes about
   itself.
2. **A watchtower that quietly rots is worse than none.** Watchtower failures
   raise platform issues themselves.

## The instruments

- **Outcomes** (nightly) — every terminal agent PR is joined to its linked
  issue, merger identity, merge-commit shape and policy evidence, review rounds, and human
  fixup commits. **Accepted** means a human squash-merged it; lead time runs
  from issue creation to merge. If GitHub cannot prove the merge method,
  Facility reports the outcome as unassessed instead of guessing. **One-shot**
  means merged with zero change requests and zero human fixup commits.
  Acceptance and one-shot rates are metrics, not anecdotes.
- **Health** (daily) — failure streaks and run budgets per workflow and per
  platform agent; breaches open a single deduped issue and resolve themselves
  on recovery.
- **The canary** (weekly) — a synthetic probe through the real pipeline.
  For repo-lane projects the pinned, hash-authorized `/architect` probe is
  verified; for platform-lane projects the canary run must produce its ack
  and its receipt. Monitors tell you a workflow ran; only the canary proves
  the chain works before a human hits the breakage.

## Issues

Everything that goes wrong across the lifecycle — drift, budget breaches,
run failures, stuck sessions, guard failures, canary failures — is a
first-class platform issue with a fingerprint (deduped), a state, and a
trail. The Actions-tab glance becomes an org-wide view.
