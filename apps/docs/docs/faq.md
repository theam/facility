---
title: FAQ
---

# Frequently asked questions

## What is Facility?

Facility is an AI SDLC system for running coding agents inside a reviewable software delivery
process. It joins persistent story workspaces with human steering and review, repository gates,
GitHub delivery state, costs, audit history, observability, and operational evidence.

## How do humans, gates, and evidence fit into the workflow?

Humans steer work, inspect previews and pull requests, and control repository merge policy. Branch
protection, required CI, and reviews provide structural gates. Conversations, turns, Git state,
pull requests, CI, costs, audits, previews, and lifecycle events provide reviewable evidence in the
story timeline.

## Is a workspace deleted after merge?

No. Merge marks the story done and may suspend compute. The worktree, volume, conversation, and
Claude or Codex session files remain. Only `facility_delete_workspace` or the corresponding UI
control destroys them.

## Are agents sandboxed differently by role?

No. Every agent receives the same full workspace and GitHub installation access. Role-specific
restraint belongs in its prompt. Tenant and project isolation still apply.

## Where are agents configured?

Only in `.agents/*.md`. Each manifest contains the name, engine, model, options, triggers, and
prompt. The database stores a cache tied to the source commit, not an editable second definition.

## Do scheduled agents still exist?

Yes. A schedule in an agent manifest creates or resumes a stable scheduled story. GitHub events and
manual requests use the same dispatcher.

## Is a preview another deployment?

No. Facility authenticates a short-lived session and proxies the declared port from the live
workspace, including WebSockets.

## Are Vercel Sandbox compute sessions permanent?

No. Provider compute has a finite lease. Facility creates a named persistent sandbox with
non-expiring retained snapshots, stops or replaces compute, and resumes the same workspace state.
Persistence still depends on the provider resource and snapshot, so operators must monitor and back
them up according to their recovery policy.

## Does a project budget delete or stop a workspace?

No. Turns and title generation reserve a priced estimate before a provider call. Admission counts
measured usage, open holds and settled title charges together. A call already running may exceed
its estimate and is accounted afterwards; later calls are blocked when their estimate will not fit.
The worktree, conversation,
and engine sessions remain. Unknown model pricing is rejected while budget enforcement is enabled,
and unavailable workspace pricing is not reported as zero.

If a worker dies, recovery reads the turn's retained usage journal. Final counters are charged
once; partial counters are a lower bound. Missing, unreadable, or incomplete usage is marked
unpriced and the budget state becomes `unconfirmed`: new agent and title-generation model calls
are blocked while enforcement is enabled. Raising the limit, resolving attention, or starting a
new month does not confirm the bill. Recovery retries retained journals without waking compute
or rerunning the agent. A finalized journal clears the block after reconciliation.
The same recovery pass marks missing bills on worker-interrupted turns failed by older
Facility versions as unconfirmed; it cannot invent usage that was never retained.

Failed or canceled live turns also retain an unconfirmed bill when final usage is unavailable.
Accounting and hold settlement happen before the next queued turn is activated. If accounting
cannot be saved, the hold remains and handoff stops until recovery reconciles it. Recovery can
read a late final journal for a terminal turn without waking compute or rerunning inference.
An open hold stranded on a terminal turn also blocks enforced-budget admission.

Title generation also records a durable API attempt, even before a budget is enabled.
Duplicate jobs share one attempt and only one can call the provider. A lost response,
timeout, server error, or missing usage leaves spending unconfirmed; it does not trigger
another paid attempt. An authentication rejection is recorded as unbilled. Recovery expires
an attempt that never started without charging it, but an expired started attempt remains
uncertain. A final receipt for the same fenced attempt can reconcile that uncertainty.
The bill and generated title are saved atomically; a failed database write keeps the attempt
and hold for recovery instead of calling the provider again. The ledger stores numerical
usage and request identity, without prompts or credentials. It currently covers titles;
read-only consultation is a separate feature.

When no final journal can be recovered, inspect the provider bill and retained session files;
the true charge may exceed the recorded lower bound. There is currently no manual billing
reconciliation endpoint. An authorized budget administrator can explicitly disable enforcement
to continue, accepting that spend remains incomplete. Deleting the workspace loses evidence
and does not clear the accounting block.

To use a newly supported model, update the agent's `model` field and ensure the
deployed Facility version contains its price-book entry. See
[cost and budget API behavior](reference/api.md) for the supported additions and
fallback pricing limits. Catalog support does not grant provider access.

## How does Facility cover cost, observability, analytics, and delivery pipelines?

Facility stores turn usage and cost, monthly project budgets, audit and observability records,
product summaries, and a webhook-plus-reconciliation mirror of GitHub issues, pull requests,
checks, and workflows. The API, worker, and PostgreSQL provide these functions.

## Is MCP the only interface?

No. MCP is the primary automation interface. The web UI uses the same story, agent, environment,
preview, lifecycle, budget, and backlog services and can inspect and continue the shared
conversation.

## How do I configure an existing repository?

Add the small [project manifest](reference/project-manifest.md) and [agent
catalog](reference/agent-manifest.md), or use [kickstart](guides/kickstart.md) to open that change as
a pull request. Validate it with a disposable story before connecting important work.

## Where should I start when something fails?

Use the [troubleshooting guide](guides/troubleshooting.md) to separate control-plane, workspace,
environment, engine, preview, GitHub, and cost failures. Keep the request, story, turn, workspace,
delivery, and provider identifiers together when inspecting logs.

## How can I work on Facility?

Read [Contributing](https://github.com/theam/facility/blob/main/CONTRIBUTING.md), then use the
[contributor architecture](contributors/architecture.md), [testing](contributors/testing.md), and
[documentation](contributors/documentation.md) guides. Public contributions must avoid private
repository, deployment, and customer details.

## Can I upgrade a 0.11 database?

Not in place. Back it up and start 0.12 with an empty database. See [the upgrade boundary](reference/upgrade-012.md).
