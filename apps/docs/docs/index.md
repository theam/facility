---
title: Facility
slug: /
---

# Reviewable software delivery with AI coding agents

Facility is open-source, self-hosted tooling for running AI coding agents as part of a reviewable
software delivery process — with the humans, the gates and the evidence in one place.

Facility is an AI SDLC system. It follows work from an issue or ad hoc story through agent planning,
implementation, validation, review, and a pull request. The control plane keeps the people involved,
repository gates, conversation, Git state, delivery status, cost, and operational evidence connected
to that work.

Persistent story workspaces are the execution core introduced in 0.12, not a replacement for that
mission. Claude Code and Codex receive one durable place to work: a shared conversation, worktree,
native engine sessions, and complete development environment that Facility keeps until explicit
deletion. MCP is the primary automation interface, and the web UI remains a first-class human
surface over the same system.

The repository defines its environment in `.facility.yml` and every agent in `.agents/*.md`.
Architects, builders, reviewers, CI repair agents, and scheduled security audits use the same
manifest format, dispatcher, workspace, GitHub access, and conversation.

Facility trusts these agents as repository maintainers. They can use shell, network, Docker,
browser tools, branches, commits, pushes, and pull requests. GitHub review, CI, and branch
protection decide what merges.

## Humans, gates, and evidence

- **Humans** select work, steer the shared conversation, inspect previews and changes, review pull
  requests, and control the merge policy.
- **Gates** remain explicit in repository rules, required CI and reviews, project budgets, and the
  configured triggers that admit agent work.
- **Evidence** includes the conversation and turn history, Git branches and pull requests, CI and
  issue state, previews, usage and cost, audit events, and operational telemetry.

0.12 removes unstable implementation layers such as receipts, internal write approvals, and a
separate model gateway. It does not turn Facility into a workspace utility or abandon reviewable
delivery. Cost controls, observability, analytics, auditing, scheduled agents, and the GitHub
delivery mirror remain in the smaller control plane. Future releases can build richer governance
on the persistent lifecycle without restoring the earlier complexity wholesale.

## What Facility keeps

- The story conversation and every turn.
- The repository worktree, including uncommitted files and local branches.
- Claude Code or Codex native session data, so a compatible later turn can resume the same engine
  context.
- Dependencies, development data, and test artifacts stored in the workspace volume.
- Cost, budget, audit, observability, analytics, GitHub issue, pull-request, and CI records.

Compute may sleep or be replaced. These records and the workspace volume remain until an operator
uses the explicit delete operation. Merging or archiving a story never deletes them.

## Choose a path

If you want to use Facility:

1. [Install or run an instance](self-host/quickstart.md).
2. [Kickstart a repository](guides/kickstart.md), or [configure an existing
   repository](guides/existing-repo.md).
3. [Start and operate a story](guides/operate-story.md) from MCP or the web UI.
4. [Validate the complete loop](guides/validate-workspace-loop.md) before using a production
   repository.

If you operate an instance, read the [production checklist](self-host/production.md),
[authentication](self-host/authentication.md), [GitHub App setup](self-host/github-app.md), and
[hardening guide](reference/hardening.md).

If you want to change Facility, begin with
[Contributing](https://github.com/theam/facility/blob/main/CONTRIBUTING.md), then read the [contributor
architecture](contributors/architecture.md), [testing guide](contributors/testing.md), and
[documentation guide](contributors/documentation.md).

The contract references for [`.facility.yml`](reference/project-manifest.md),
[`.agents/*.md`](reference/agent-manifest.md), [lifecycle](reference/lifecycle.md),
[MCP](reference/mcp.md), and [HTTP](reference/api.md) describe the supported 0.12 behavior.
