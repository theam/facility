---
title: API
---

# HTTP API

The interactive OpenAPI document is served from `/docs` by the API process. It is the authoritative
source for request bodies, response schemas, operation ids, and current status codes. This page
maps the supported 0.12 resources and cross-cutting behavior.

## Public and protocol endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Process and database liveness; returns 503 when the database is down. |
| `GET /readyz` | Readiness probe with the same version and database status shape. |
| `POST /webhooks/github` | Signed GitHub App delivery ingress. |
| `POST /mcp` | Streamable HTTP MCP endpoint. |
| `GET /.well-known/oauth-protected-resource/mcp` | MCP protected-resource discovery. |
| `/auth/*` | Web login, callback, logout, and loopback-only development login. |
| `/oauth/*` | Facility's MCP authorization server when interactive OAuth is configured. |

The preview origin also reaches the API process, but it accepts only preview routes. Facility
rejects attempts to use that origin as another control-plane host.

## Organization and access

- `/v1/me` returns the resolved principal and effective membership.
- `/v1/org` reads or updates organization settings.
- `/v1/members` and `/v1/members/:userId` manage membership.
- `/v1/roles` and `/v1/roles/:roleId` manage roles.
- `/v1/keys` and `/v1/keys/:keyId` create, list, and revoke API keys.

Organization-administration endpoints reject project-scoped keys. Key plaintext is returned only
at creation; store it as a secret.

## GitHub installations and projects

- `/v1/github/installations` lists installations visible to kickstart.
- `/v1/github/installations/:installationId/repos` lists repositories available to an
  installation.
- `/v1/projects` creates and lists projects.
- `/v1/projects/:projectId` reads, updates, or deletes a project.
- `/v1/projects/:projectId/repos` lists or connects repositories.
- `/v1/projects/:projectId/repos/:repoId` removes a repository connection.
- `/v1/projects/:projectId/kickstart/preview` detects and renders the proposed contract.
- `/v1/projects/:projectId/kickstart` opens the configuration pull request.

Repository connections are organization- and installation-bound. A project-scoped key requesting
another project receives 404 rather than a distinguishable authorization error.

## Agents and stories

- `/v1/projects/:projectId/story-agents` lists the catalog and schedule status.
- `/v1/projects/:projectId/story-agents/:agentName` reads an agent or proposes an update PR.
- `/v1/projects/:projectId/project-skills` lists valid repository-installed skills and their source
  commit. It is inventory only; it does not install or upgrade skills.
- `/v1/projects/:projectId/workspace-stories` lists or starts stories.
- `/v1/projects/:projectId/workspace-stories/:storyId` returns the story bundle and ordered
  timeline of turn, Git, artifact, attention, and GitHub evidence.
- `/v1/projects/:projectId/workspace-stories/:storyId/messages` queues a shared-conversation
  message.
- `/v1/projects/:projectId/workspace-stories/:storyId/conversation` pages durable messages.
- `/v1/projects/:projectId/workspace-stories/:storyId/turns/:turnId/cancel` cancels active work.
- `/v1/projects/:projectId/workspace-stories/:storyId/attention/:attentionId/retry` retries an
  attention item.
- `/v1/projects/:projectId/workspace-stories/:storyId/attention/:attentionId/dismiss` dismisses it.

Start and message bodies contain their own `idempotency_key` for story-level deduplication. The
request can also use the HTTP `Idempotency-Key` behavior described below.

## Environments, previews, and lifecycle

- `/v1/projects/:projectId/workspace-stories/:storyId/environment` returns provider inspection,
  metrics, and cursor-paged environment events.
- `/environment/clean-setup` forces the setup and optional seed commands in the retained worktree.
- `/environment/browser-test` runs the declared check and records artifacts.
- `/preview/:service/open` creates a one-time authenticated preview handoff.
- `/:storyId/suspend`, `/:storyId/archive`, and `/:storyId/restore` apply reversible lifecycle
  operations.
- `DELETE /v1/projects/:projectId/workspace-stories/:storyId/workspace` destroys the durable
  workspace after explicit confirmation.

The delete body must contain `confirm: true` and an `idempotency_key` identical to the
`Idempotency-Key` header. See the [lifecycle reference](lifecycle.md) before exposing this operation
in another client.

## Costs, budgets, operations, and delivery

- `/v1/projects/:projectId/costs` returns cost and usage analysis.
- `/v1/projects/:projectId/budget` reads or updates the monthly project budget.
- `/v1/projects/:projectId/observability` returns operational events and summaries.
- `/v1/projects/:projectId/pipeline` returns the issue, pull-request, check, and workflow view.
- `/v1/projects/:projectId/github/sync` requests immediate mirror reconciliation.
- `/v1/projects/:projectId/audit` returns project audit events.

Unavailable provider pricing is represented explicitly and must not be interpreted as zero.

## Authentication and authorization

Protected routes accept a browser session, a Facility API key as a Bearer token, or an MCP access
token where applicable. Every request resolves one organization principal and checks route-level
permissions. Project routes verify both organization ownership and optional key project scope.

## Idempotency

Authenticated `POST`, `PATCH`, `PUT`, and `DELETE` routes accept `Idempotency-Key` from 8 through 200
characters. The key is scoped to principal, method, and path and retained for 24 hours.

- The same key and body replay the original status and JSON response with
  `idempotency-status: replayed`.
- The same key with a different body returns `idempotency_key_reused`.
- A concurrent request returns `idempotency_in_progress` and `retry-after: 1`.
- An uncertain committed outcome is sealed as `idempotency_outcome_indeterminate` rather than
  automatically repeated.

Use a random key per logical mutation and reuse it only to retry that exact operation.

## Pagination, errors, and request ids

List operations use route-specific cursor or `limit`/`offset` parameters. Generic page limits are
1–200 with a default of 100. Conversation and environment events return cursors so clients can
continue without refetching the entire history.

Errors use:

```json
{
  "error": {
    "code": "not_found",
    "message": "Project not found",
    "details": {}
  }
}
```

Common codes include `validation_error`, `unauthorized`, `forbidden`, `not_found`, `conflict`,
`invalid_reference`, and `bad_request`. Unknown server failures are masked as `internal_error`.
Every response includes `x-request-id`; include it in support and log searches.

Long-running work is represented by persisted turns and events rather than an open HTTP request.
Start and message operations normally return 202, after which clients poll the story or
conversation without creating duplicate work.

Timeline entries expose `source`, `type`, optional `turn_id`, structured `data`, `occurred_at`, and
`observed_at`. Consumers should render unknown event types generically so later evidence additions
remain backward compatible.
