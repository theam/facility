---
title: Contributor architecture
---

# Contributor architecture

This map is for finding the owning boundary before changing code. Facility is a pnpm/Turborepo
monorepo, but the durable behavior crosses a small number of explicit packages and processes.

## Applications and services

| Path | Package | Responsibility |
| --- | --- | --- |
| `apps/web` | `@facility/web` | Next.js UI, browser sessions, projects, stories, agents, pipeline, insights, and administration. |
| `apps/docs` | `@facility/docs` | Docusaurus user, operator, reference, and contributor documentation. |
| `services/api` | `@facility/api` | HTTP API, embedded MCP transport, OAuth, webhooks, preview proxy, worker, domain services, and workspace providers. |

The API and worker have different entrypoints but share the `@facility/api` codebase. Keep request
validation and presentation at routes, business invariants in domain services, provider behavior
behind interfaces, and durable facts in the database.

## Shared packages

| Path | Package | Responsibility |
| --- | --- | --- |
| `packages/agents` | `@facility/agents` | Strict `.agents/*.md` parser, renderer, trigger schema, hashes, and catalog helpers. |
| `packages/core` | `@facility/core` | Shared identifiers and domain primitives without service dependencies. |
| `packages/db` | `@facility/db` | Drizzle schema, migrations, seed data, and database test support. |
| `packages/mcp` | `@facility/mcp` | MCP tool definitions, schemas, and server adapter over Facility domain capabilities. |
| `packages/sdk` | `@facility/sdk` | Typed client-facing SDK surface. |
| `packages/ui` | `@facility/ui` | Reusable presentation components shared by web surfaces. |
| `packages/cli` | `@theagilemonkeys/facility` | Published repository init, local doctor, starter files, and instance bootstrap CLI. |

Avoid importing service or web code into these packages. If a type is part of an external
contract, define one clear owner and derive clients or schemas from it rather than maintaining
similar handwritten versions.

## Runtime and infrastructure

- `runner/` builds the complete trusted workspace image and its Git credential and preview helpers.
- `infra/terraform/aws/` deploys the AWS control plane with Vercel workspaces.
- `docker-compose.yml` is the single-host deployment with Docker workspaces.
- `docker-compose.dev.yml` provides local PostgreSQL for source development.
- `guards/` enforces repository-wide invariants that ordinary package tests cannot protect.
- `scripts/` owns development startup, verification orchestration, migration checks, and release
  mechanics.

## Main request path

A UI or MCP request enters the API, resolves a principal, checks project scope and permissions, and
calls a domain service. Starting or continuing a story persists its message and turn in PostgreSQL.
The worker claims the turn, resolves an exact agent manifest, wakes the workspace provider,
prepares `.facility.yml`, issues repository credentials, and starts or resumes Claude Code or
Codex. Events and usage return to PostgreSQL; UI and MCP read the same projections.

GitHub webhooks enter the API after raw-body HMAC verification, are deduplicated by installation and
delivery id, then reach the worker. The same event may update the delivery mirror, transition a
linked story, and activate a manifest trigger.

Preview opening creates a one-time handoff. The browser exchanges it for a preview cookie on the
separate preview site. The API proxy then resolves the service endpoint from the same workspace and
rechecks authorization for HTTP and WebSocket traffic.

## Change routing

For an agent or skill inventory schema change, update `packages/agents`, CLI starter files, server
catalog code, UI/API/MCP presentation, reference docs, and parser integration tests together.

For a workspace contract change, update the project manifest parser and environment service,
provider implementations, CLI init/doctor, MCP/API/UI surfaces, runner if needed, lifecycle and
manifest docs, and Docker-backed E2E coverage.

For an API change, update route schemas, OpenAPI behavior, SDK/MCP consumers where applicable,
authorization and idempotency tests, and the API reference. Preserve organization and project
scoping at the query boundary.

For a database change, add a new immutable migration and update schema, query code, fixtures,
integration tests, and operational migration guidance. Never edit a released migration.

For a UI change, verify loading, empty, error, forbidden, and successful states against the real API
shape. Retain MCP parity for lifecycle capability even when presentation differs.

## Invariants worth protecting

- A story has one durable conversation and workspace and at most one active turn.
- Suspend, archive, and merge do not destroy workspace state.
- Explicit deletion targets one verified workspace and requires confirmation.
- Every agent uses the same full project access policy; manifests cannot add permission profiles.
- Catalog and project configuration come from the primary repository and are reviewed in Git.
- GitHub installation and project repository scope are enforced before issuing credentials.
- Missing cost or scanner data is unavailable, not zero or clean.
- Costs, budgets, audit, observability, analytics, and GitHub mirror remain first-class behavior.
- The web UI and MCP use the same services and persistent state.

Read the [testing guide](testing.md) before choosing acceptance evidence and the [documentation
guide](documentation.md) when a behavior or contract changes.
