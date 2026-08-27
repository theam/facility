---
title: The inbox
---

# The inbox: human-in-the-loop, one place

Every Facility action an agent needs from a human lands in one inbox: plan
acceptances, learning-mode validations, kickstart reviews, budget overrides,
task approvals from the Project Owner agent, escalations from blocked runs.

This inbox implements **Gate 1** and other governed platform actions. **Gate
2** remains the pull-request review, live-preview validation, and squash merge
in GitHub. Facility surfaces evidence for that decision, but does not replace
GitHub's protected-branch boundary.

## How it works

Facility implements a typed, auditable HITL model:

- **Action types** declare what can be proposed: a JSON schema for the
  payload, a resolver for who may decide (explicit emails, a permission, a
  team, or a dynamic rule), and an executor for what approval does (an
  internal platform action, an outbound webhook, or nothing but the record).
- **Proposals** carry the evidence: a human-readable context, the exact
  payload, links to the run and project.
- **The ledger** is append-only: draft → open → approved / rejected /
  cancelled / expired, then executed or execution-failed. Who decided, when,
  and why is never reconstructable-only — it's recorded.
- **Plan acceptance** is executable: approving a platform-lane plan creates
  and queues the builder run linked to the architect run. The current repo-lane
  workflow executes outside this control-plane boundary and is therefore not
  compatible with `builderPlanPolicy=required`; required projects must route
  both Builder commands to the platform lane. A later signed repo-lane handshake
  can extend the same invariant without treating a slash command as a proposal.

## Design intent

Gate actions are one tap, with the evidence inline — the plan, the diff, the
receipts. Approving dispatches the action; rejecting records the reason and
feeds it back to the proposing agent. Nothing an agent proposes executes
without the ledger saying a named human said yes.
