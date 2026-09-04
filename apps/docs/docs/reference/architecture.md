---
title: Architecture
---

# Architecture

Facility has one control plane and provider-backed story workspaces. MCP, the web UI, GitHub, and
schedules are entry surfaces for the same domain services rather than separate products.

## Control plane

The web UI and MCP clients call one control API. The API owns authentication, project and story
operations, GitHub webhook ingress, the embedded MCP endpoint, and authenticated preview routing.
PostgreSQL stores durable control-plane state and pg-boss jobs.

The same database stores per-turn usage, monthly project budgets, audit events, turn Git evidence,
and the GitHub issue, branch, pull request, review, check, and CI mirror. The API exposes those
records through MCP and the web UI. No separate gateway, metering service, analytics service, or
pipeline service is required.

The deployable processes are:

- **web**, the human UI for projects, stories, agents, environments, pipeline, budget, and
  administration;
- **api**, the HTTP API, MCP server, authorization server, GitHub webhook receiver, and preview
  proxy;
- **worker**, the durable queue consumer, agent dispatcher, GitHub reconciliation loop, and
  schedule scanner; and
- **PostgreSQL**, the source of truth for control state and pg-boss queue storage.

API and worker use the same database schema and configuration source. Apply migrations before
starting either process on a new release.

## Activation and dispatch

One worker consumes turn, webhook, and generic schedule queues. Every activation resolves a
versioned `.agents/` manifest and calls the same dispatcher. The dispatcher wakes the story
workspace, provisions repositories and environment state, supplies short-lived credentials, and
starts or resumes the selected native engine session.

The worker handles these recurring paths:

- `turns.dispatch` for queued agent work;
- `github.webhook` for verified GitHub deliveries;
- `github.mirror` for ten-minute reconciliation of configured repositories; and
- `agent.schedules` for minute-level schedule evaluation.

Messages and turns are persisted before dispatch. A database claim prevents two workers from
running the same story turn concurrently. Every activation resolves the repository catalog, checks
the trigger, and snapshots the manifest used for history.

The dispatcher captures the initial Git identity after workspace preparation and before invoking
Claude Code or Codex. It captures final Git state after the engine settles, including failure and
cancel paths. Evidence capture uses the provider's ordinary execution boundary, so Docker and
Vercel workspaces follow the same contract.

## Workspace plane

`WorkspaceRuntime` is the provider boundary: create, wake, exec, expose, inspect, suspend, and
destroy. Docker uses a named volume independent of its replaceable container. The Vercel adapter
uses named sandboxes and non-expiring filesystem snapshots while each compute lease is renewed
within provider limits.

The Docker runtime creates replaceable workspace containers backed by named volumes. Project Docker
commands run against a workspace-scoped sidecar daemon; the agent does not receive the Facility
host Docker socket. In local development the control-plane API and worker need host Docker access
to create and manage those isolated workspace resources.

The Vercel runtime uses Vercel Sandbox compute with retained snapshot-backed filesystem state.
Compute leases are finite even though the Facility workspace is durable, so the adapter suspends,
snapshots, recreates, and wakes compute behind the same `WorkspaceRuntime` contract.

The runner image supplies Git, GitHub CLI, Claude Code, Codex, Chromium, Docker/Compose/Buildx,
language toolchains, and a persistent Facility home. Projects may override the image in
`.facility.yml` when the provider can pull it.

## Project environment

The environment service checks out all configured repositories, selects the primary story branch,
injects only declared project values, runs setup and seed when due, starts the environment, waits
for readiness, and exposes named services. Commands execute in the primary repository and their
events are persisted with secret values redacted.

The preview proxy routes HTTP and WebSockets to ports exposed from that same workspace. There is no
separate preview build or execution lifecycle.

A one-time handoff creates a preview session, and each proxied request rechecks identity, project
membership, workspace, service, expiry, and revocation.

## GitHub boundary

The GitHub App installation is both the repository discovery boundary and the credential source for
workspaces. Facility issues short-lived installation tokens restricted to repositories connected
to the active project while retaining the App's configured maintainer-level permission set.

Signed webhooks update the local issue, branch, pull-request, review, check, and workflow mirror and
may activate repository-defined agents. Ten-minute reconciliation lists repository branches,
issues, pull requests, reviews for linked pull requests, statuses, and check runs to repair missed
delivery. A complete branch scan marks disappeared branches as deleted; an incomplete paginated
scan does not.

GitHub facts are linked to an exact turn when their SHA matches a recorded final turn SHA. Branch,
pull-request, and closing-issue identity provide a story-level fallback for changes made outside
Facility. Pull-request merge transitions a linked story to done and suspends compute without
deleting the workspace.

## Durable records

PostgreSQL retains organizations, members, roles, keys, projects, repository bindings, agent and
skill catalog projections, stories, messages, turns, attention items, artifacts, workspace
references, per-turn Git evidence, ordered story evidence, usage, costs, budgets, observability,
analytics summaries, GitHub mirror records, idempotency records, preview sessions, and audit
events.

Workspace storage retains source and engine-local state. A valid backup strategy therefore covers
PostgreSQL and the workspace provider. Database recovery alone cannot restore unpushed files; a
volume or snapshot alone cannot reconstruct the conversation and authorization state.

## Deployment shapes

The AWS reference deployment runs the web UI, API, worker, and PostgreSQL in AWS. Its workspace
driver is fixed to Vercel, so the full development environment and durable workspace snapshots
remain Vercel resources.

The local Compose deployment uses the Docker runtime and named volumes on one trusted host. The
provider interface permits another implementation. Docker and Vercel are the documented and tested
providers.

See the [story lifecycle](lifecycle.md), [security model](security.md), and [production
guide](../self-host/production.md) for the operational consequences of these boundaries.
