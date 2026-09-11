---
title: Production
---

# Production deployment

Facility runs trusted repository code with maintainer-level project credentials. A production
installation needs the same care as a CI control plane and a persistent development fleet. Start
with a private validation repository and complete the [end-to-end
checklist](../guides/validate-workspace-loop.md) before connecting important code.

## Required components

The permanent services are the control API with embedded MCP and webhooks, one worker with the
generic scheduler and GitHub reconciliation, PostgreSQL, the web UI, and a workspace provider. Cost
accounting, budgets, observability, audit events, analytics summaries, and pipeline state live in
those services. They do not require sidecars or separate control-plane applications.

The single-host Compose file uses Docker named volumes. The [AWS reference deployment](aws.md)
runs the control plane on ECS and RDS while Vercel Sandbox runs and retains story workspaces.

Run at least one API, one worker, and one web process. API and worker must use the same release,
database, master key, GitHub App configuration, workspace provider configuration, and project value
namespace. Multiple API replicas are stateless apart from PostgreSQL. Multiple workers coordinate
through durable queue claims and schedule locks.

## Hostnames, TLS, and routing

Use managed PostgreSQL, HTTPS, encrypted backups, and a dedicated preview registered site separate
from the control plane. The web UI and API/MCP may share one application hostname behind a reverse
proxy or use separate origins. Give the worker Docker access only on a host dedicated to trusted
project workspaces. Monitor disk usage: Facility does not delete worktrees or session volumes by
age.

`FACILITY_PREVIEW_URL` is mandatory in production. Its hostname must belong to a registered site
different from `PUBLIC_URL`, `WEB_URL`, and `MCP_PUBLIC_URL`; a sibling subdomain on the same site is
not sufficient. Route HTTP and WebSocket traffic from that origin to the API preview surface while
preventing it from reaching control-plane routes.

Set `PUBLIC_URL` to the public API origin, `WEB_URL` to the browser UI origin, `MCP_PUBLIC_URL` to
the exact MCP resource URL, and `AUTH_CALLBACK_URL` to the exact web `/api/auth/callback` URL. When
Facility's MCP OAuth server is enabled, `FACILITY_OAUTH_ISSUER` must equal the `WEB_URL` origin.

## Core configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection URL for API, worker, migration, and bootstrap jobs. |
| `SECRET_MASTER_KEY` | Canonical base64 for exactly 32 random bytes. |
| `FACILITY_WORKSPACE_DRIVER` | `docker` or `vercel`. |
| `FACILITY_WORKSPACE_IMAGE` | Complete runner image available to the provider. |
| `AUTH_IDENTITY_PROVIDER` | `github` or `oidc`. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | Installation-token minting. |
| `GITHUB_APP_WEBHOOK_SECRET` | Raw-body webhook HMAC verification. |
| `GITHUB_APP_SLUG` | GitHub App identity used by installation flows. |
| `FACILITY_OAUTH_JWKS` | Private ES256 JWK set when interactive MCP OAuth is enabled. |
| `LOG_LEVEL` | Structured service log level. |

Vercel workspaces also require `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, and either
`VERCEL_OIDC_TOKEN` or `VERCEL_TOKEN`; the OIDC token takes precedence. Docker workspaces require
API and worker access to the host daemon, while agents receive only their workspace-scoped daemon.

See [Authentication](authentication.md) and [GitHub App](github-app.md) for provider-specific
variables and callbacks.

## Project and engine values

Required secrets include `SECRET_MASTER_KEY`, GitHub App credentials, OAuth credentials, and the
engine credentials made available to workspaces. Installation and engine tokens should be
short-lived where the provider supports it.

Repositories list required engine and project secret names under `environment.secrets` in
`.facility.yml`. Put each value in the API and worker secret environment as
`FACILITY_PROJECT_<PROJECT_ID>_<NAME>`. For example, project `proj_abc` can declare
`ANTHROPIC_API_KEY` and receive it from `FACILITY_PROJECT_PROJ_ABC_ANTHROPIC_API_KEY`. Facility
never resolves a repository declaration directly against the control process environment, so a
project cannot request `DATABASE_URL`, `SECRET_MASTER_KEY`, or another project's credential.
Rotating or removing a value affects the next turn and does not delete the stored worktree or native
session files.

Apply migrations before starting API or worker replicas. Follow the [versioned upgrade
guide](../reference/upgrade-012.md) when the existing database is incompatible.

Configure project values on both API and worker because environment inspection and turn dispatch
cross those process boundaries. In a managed secret store, map each exact environment name to one
secret value when separate rotation is useful.

## Database bootstrap and upgrades

Create an empty PostgreSQL database, run the deployment migration entrypoint, and require a zero
exit status before starting the API or worker. Then run `facility instance bootstrap` once to bind
the first organization owner and GitHub App installation. Repeating the exact binding is safe; a
different binding against a populated instance is refused.

For application upgrades:

1. take a restorable database backup and confirm workspace provider retention;
2. build immutable API, worker, web, and runner images;
3. stop new dispatch or scale the worker down if the release requires a controlled cutover;
4. run migrations as a one-shot administrative job;
5. deploy API, worker, and web at the same version;
6. verify `/readyz`, queue processing, login, MCP discovery, GitHub webhook delivery, and preview
   authorization; and
7. run a disposable story through wake, environment readiness, agent continuation, and suspend.

Do not roll application code back across an incompatible migration. Restore the pre-upgrade
database and matching service images together when a migration cannot be safely used by the prior
release.

## Backups and recovery

Back up PostgreSQL and durable workspace state. A database backup preserves conversations, turns,
provider references, costs, budgets, mirrors, and audit events but not unpushed files. A provider
snapshot preserves files and engine sessions but not Facility ownership and lifecycle records.

Test recovery into an isolated instance. A meaningful drill restores a story, reads its
conversation, locates the correct workspace, inspects Git status, wakes the environment, and
resumes a native engine session. Record recovery time and any provider-specific manual mapping.

Protect `SECRET_MASTER_KEY` separately and restore the exact key with its database. Rotate it only
through an implemented key-rotation procedure; replacing it ad hoc can make encrypted values
unreadable.

## Monitoring

Monitor:

- API `/readyz`, error rate, latency, and authentication failures;
- worker health, queue depth and age, failed dispatch, schedule lag, and reconciliation lag;
- PostgreSQL connections, locks, storage, backups, and transaction failures;
- workspace create/wake duration, provider failures, active compute, and retained storage;
- turn success, cancellation, attention, usage, cost collection, and project budget thresholds;
- GitHub webhook signature failures, unknown installations, duplicate rate, and mirror freshness;
- preview authorization failures and WebSocket errors; and
- audit activity for membership, key, project, agent, budget, and deletion changes.

Facility's observability and analytics views remain the product-level source for stories and
delivery. Provider metrics and centralized logs remain necessary for host, network, and service
failures. Preserve `x-request-id`, GitHub delivery id, story id, turn id, workspace id, and provider
reference as correlation fields.

## Scaling and maintenance

Scale API and web horizontally behind a load balancer. Worker replicas can share the queue, but
validate provider quotas and rate limits before increasing concurrency. Retained workspace storage
does not shrink when worker count falls.

For Docker, reserve CPU, memory, inode, and disk headroom for nested project environments. For
Vercel, monitor sandbox concurrency, snapshot storage, token validity, and API quotas. A finite
provider compute lease is normal; failure to snapshot or wake the retained state is not.

Use Facility's explicit delete operation for one verified story workspace. Never use broad
provider cleanup based on age or a prefix without reconciling it to active database records and
backups.

## Go-live checklist

- TLS and registered-site separation are verified from an external browser.
- GitHub or OIDC login, MCP OAuth/API key authentication, and logout/revocation work.
- The GitHub App has the documented repositories, permissions, event subscriptions, and branch
  rules.
- Database and workspace backups have passed a restore drill.
- Project secrets are isolated, available to API and worker, and absent from logs.
- Budgets, cost-unavailable states, observability, analytics, audit, and GitHub mirror views work.
- A disposable story passes the complete workspace validation, including deletion denial paths.
- Operators have the [troubleshooting](../guides/troubleshooting.md) and
  [hardening](../reference/hardening.md) runbooks available during incidents.
