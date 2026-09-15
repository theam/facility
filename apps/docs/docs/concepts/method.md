---
title: AI SDLC operating model
---

# AI SDLC operating model

Facility runs AI coding agents as part of a reviewable software delivery process. It keeps the
humans, repository gates, and delivery evidence connected from the first story message to the pull
request and its outcome.

The persistent workspace is the execution foundation for that process. It gives an agent the same
practical working surface a repository maintainer expects: a checkout, a shell, the project
development environment, a browser, Git, and GitHub. Durability lets several agents and people
continue the same work without replacing the software-delivery process a team already trusts.

## Humans, gates, and evidence

Facility does not define software delivery as autonomous code generation. A person chooses or
accepts the work, can steer the shared conversation, inspects the resulting branch and preview, and
retains authority over merge policy.

Repository rules provide structural gates: protected branches, required CI, required reviews, and
the final merge controls. Facility adds operating gates such as project budgets, authenticated
previews, trigger configuration, and explicit confirmation before permanent deletion.

The story keeps the evidence needed to review and operate that process: prompts and messages, agent
and model identity, turn outcomes, worktree state, branches and pull requests, CI and issue state,
usage and cost, audit events, previews, and workspace lifecycle events.

## Repository-owned configuration

The primary repository carries two contracts:

- [`.facility.yml`](../reference/project-manifest.md) says how to prepare, start, check, and expose
  the development environment.
- [`.agents/*.md`](../reference/agent-manifest.md) says which agents exist, which engine and model
  each one uses, what activates it, and what it should do.

Configuration changes follow normal Git review. Facility can propose an agent edit, but does so on
a branch and through a pull request. A merged commit becomes the catalog version used by later
turns; it does not rewrite earlier execution records.

## One story, one durable place

A story owns a shared conversation and one persistent worktree. The selected agent may change
between turns, but all turns continue from the same files and conversation. This permits a useful
sequence such as architect, builder, reviewer, and CI repair without moving state between isolated
jobs.

Only one turn is active for a story at a time. Later messages wait in order. If a worker or compute
instance fails, Facility keeps the message, turn, worktree, and native engine session needed to
continue or retry.

## Broad agent access, narrow merge authority

Every agent gets the same project capability. Facility does not maintain separate tool allowlists
or permission profiles for builders, reviewers, and schedules. The agent can edit, test, commit,
push, and open or update a pull request for configured repositories.

This is deliberately a maintainer trust model. The structural safety boundary remains the normal
repository workflow: protected branches, required CI, required reviews, and a human decision to
merge. Agent prompts describe expected conduct; they are not a security sandbox.

Facility records agent identity, model and session data, Git changes, GitHub delivery state, costs,
and runtime activity as story evidence. It relies on repository review and merge controls instead
of a separate internal approval protocol.

## Persistence is explicit

Suspending stops active compute. Archiving removes a story from the active workflow. Merging marks
delivery complete. None of these actions destroys the workspace volume or the conversation.

Deletion is a separate, confirmed operation because the volume may be the only copy of
uncommitted work, development data, artifacts, or native engine session state. Operators decide
retention according to their storage, privacy, and cost requirements.

## One control plane

MCP is the primary automation interface and the web UI remains a first-class human interface. Both
call the same story, agent, environment, budget, mirror, and audit services. GitHub webhooks and
schedules enter that same path. There is no MCP-only lifecycle that can drift from the UI.

Facility keeps cost analysis, budgets, observability, analytics, auditing, and the GitHub delivery
mirror in the control plane. These are operating capabilities, not extra execution layers: the
same API, worker, and PostgreSQL database provide them.
