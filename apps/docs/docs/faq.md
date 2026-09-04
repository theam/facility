---
title: FAQ
---

# Frequently asked questions

## Is Facility now only a persistent workspace manager?

No. Facility remains an AI SDLC system for running coding agents inside a reviewable software
delivery process. Persistent story workspaces are the 0.12 execution core. The product still joins
human steering and review, repository gates, GitHub delivery state, costs, audit history,
observability, and operational evidence around that core.

## Did 0.12 remove humans, gates, or evidence?

No. It removed unstable implementations of receipts, internal write approvals, and separate
execution services. Humans still steer work and control repository merge policy. Branch protection,
required CI, and reviews remain structural gates. Conversations, turns, Git state, pull requests,
CI, costs, audits, previews, and lifecycle events remain reviewable evidence. Facility can add
richer governance later without restoring the previous architecture unchanged.

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

No. A budget is checked before a provider call. A call already running may finish and be accounted
afterwards; later turns are blocked once the monthly limit is reached. The worktree, conversation,
and engine sessions remain. Unknown model pricing is rejected while budget enforcement is enabled,
and unavailable workspace pricing is not reported as zero.

## Are cost, observability, analytics, and pipeline features still available?

Yes. The API, worker, and PostgreSQL retain those functions without separate gateway, analytics, or
pipeline services. Facility stores turn usage and cost, monthly project budgets, audit and
observability records, product summaries, and a webhook-plus-reconciliation mirror of GitHub
issues, pull requests, checks, and workflows.

## Is MCP the only interface?

No. MCP is the primary automation interface. The web UI uses the same story, agent, environment,
preview, lifecycle, budget, and pipeline services and can inspect and continue the shared
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
