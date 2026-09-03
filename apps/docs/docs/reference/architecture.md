---
title: Architecture
---

# Architecture

The web UI and MCP clients call one control API. The API owns authentication, project and story
operations, GitHub webhook ingress, the embedded MCP endpoint, and authenticated preview routing.
PostgreSQL stores durable control-plane state and pg-boss jobs.

The same database stores per-turn usage, monthly project budgets, audit events, and the GitHub
issue, pull request, and CI mirror. The API exposes those records through MCP and the web UI. No
separate gateway, metering service, analytics service, or pipeline service is required.

One worker consumes turn, webhook, and generic schedule queues. Every activation resolves a
versioned `.agents/` manifest and calls the same dispatcher. The dispatcher wakes the story
workspace, provisions repositories and environment state, supplies short-lived credentials, and
starts or resumes the selected native engine session.

`WorkspaceRuntime` is the provider boundary: create, wake, exec, expose, inspect, suspend, and
destroy. Docker uses a named volume independent of its replaceable container. The Vercel adapter
uses named sandboxes and non-expiring filesystem snapshots while each compute lease is renewed
within provider limits.

The preview proxy routes HTTP and WebSockets to ports exposed from that same workspace. There is no
separate preview build or execution lifecycle.

The AWS reference deployment runs the web UI, API, worker, and PostgreSQL in AWS. Its workspace
driver is fixed to Vercel, so the full development environment and durable workspace snapshots
remain Vercel resources.
