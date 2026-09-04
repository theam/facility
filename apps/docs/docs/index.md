---
title: Facility
slug: /
---

# Persistent development workspaces for software agents

Facility gives Claude Code and Codex a persistent place to do software work. Start a GitHub issue
or an ad hoc story from MCP or the web UI. Facility creates one shared conversation, one worktree,
and one complete development environment, then keeps them until you explicitly delete them.

The repository defines its environment in `.facility.yml` and every agent in `.agents/*.md`.
Architects, builders, reviewers, CI repair agents, and scheduled security audits use the same
manifest format, dispatcher, workspace, GitHub access, and conversation.

Facility trusts these agents as repository maintainers. They can use shell, network, Docker,
browser tools, branches, commits, pushes, and pull requests. GitHub review, CI, and branch
protection decide what merges.

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
