---
title: Production
---

# Production deployment

The production shape is four long-running control services (`api`, `worker`,
`gateway`, and `mcp`), an optional `web` service, a one-shot migration/seed job,
managed Postgres, and any S3-compatible store. Deploy them with whatever runs
containers in your organization — ECS, Cloud Run, Kubernetes, Nomad, or a VM
with compose.

## Requirements

- **Postgres 16+** (managed recommended). One database; the platform runs its
  own migrations at deploy (`@facility/db migrate`). The gateway holds a
  `LISTEN` connection for cache invalidation — the api `NOTIFY`s
  `facility_key_revoked` (revoked keys) and `facility_provider_changed` (rotated
  provider credentials) so the gateway evicts immediately instead of waiting out
  its 60s cache. Give the gateway a **direct/session-mode** connection: a
  transaction-mode pooler (e.g. PgBouncer) silently drops `LISTEN/NOTIFY`, so
  credential/key changes would only take effect after the TTL.
- **S3-compatible object storage** — AWS S3, GCS (S3 mode), MinIO, R2.
  Facility signs envelope reads/writes with AWS SigV4 for both AWS S3 and
  configured `S3_ENDPOINT` stores.
- **Secrets**: `SECRET_MASTER_KEY` (32-byte base64 — everything sealed at
  rest derives from it; store it in your secret manager, rotate = re-seal),
  WorkOS credentials, GitHub App credentials.
- **TLS + public URLs** for the API (webhooks, OAuth callbacks) and remote MCP.
  The web application is optional.

## Production deploy sequence

1. Build and publish immutable images for `api`, `worker`, `gateway`, and `mcp`
   (plus `web` when you deploy the optional operator app).
2. Provision Postgres and object storage. Set `DATABASE_URL`, `S3_BUCKET`,
   and `AWS_REGION` for AWS S3. Credentials must come from static
   `S3_ACCESS_KEY`/`S3_SECRET_KEY`, standard AWS env credentials
   (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`), or ECS/container
   credentials. For non-AWS S3-compatible stores, also set `S3_ENDPOINT` and
   use static `S3_ACCESS_KEY`/`S3_SECRET_KEY` unless that runtime supplies
   AWS-compatible credentials. The development compose stack auto-creates its
   MinIO bucket; external stores should be provisioned by your
   infrastructure.
3. Load secrets into the runtime: `SECRET_MASTER_KEY`, WorkOS variables, and
   the GitHub App variables when repo automation is enabled.
4. Run migrations once, before app traffic:

   ```bash
   pnpm --filter @facility/db migrate
   ```

5. Seed bundled roles, action types, registry essentials, and the default
   sandbox profile. Set `FACILITY_RUNNER_IMAGE` first (build/push the runner
   image from `runner/`) so the default profile can run platform-lane agents —
   otherwise `facility doctor` flags `sandbox_runner` and platform-lane runs
   never start:

   ```bash
   FACILITY_RUNNER_IMAGE=<your-runner-image> FACILITY_SEED_DEMO=0 pnpm --filter @facility/db seed
   ```

6. Start or roll the services in this order: `api`, `worker`, `gateway`, `mcp`,
   then optional `web`.
7. Bootstrap the first owner and issue an API key. On an empty installation,
   open `https://<api-host>/auth/login`; the first WorkOS-authenticated user
   creates the first organization and becomes its owner. With the optional web
   app, issue the key in settings. Without it, reopen
   `https://<api-host>/docs` after login and call `POST /v1/keys` from Swagger;
   the API session cookie authenticates the request and the key secret is
   returned once. Then run the go/no-go check:

   ```bash
   node packages/cli/bin/facility.mjs doctor --url https://<api-host> --key fak_...
   ```

   Production is ready only when the doctor reports no `FAIL` checks. The
   command verifies database connectivity and migrations, a recent worker
   scheduler heartbeat, object-store
   envelope write/read with SigV4, seed essentials, the `sandbox_runner` profile
   (its driver + runner image match this deployment), production `auth_config`
   (WorkOS configured when dev-login is off), GitHub App env completeness when
   enabled, and the org audit hash chain.

   The doctor runs through the API task's object-store configuration. Give
   the API and gateway identical `S3_*` and `AWS_REGION` env so the API-side
   round trip is a valid readiness proxy for gateway envelope writes.
   Envelope capture is best-effort with fail-loud logging: if a configured
   bucket rejects a write, the failure is logged and the metering row is still
   recorded.

## Sandbox networking (docker driver)

A platform-lane run executes in a sandbox the **worker** launches on the host
Docker daemon — a *sibling* container, not a child of the worker. That sandbox
authenticates back to the api with its one-time runner token and proxies every
model call through the gateway, so it has to be able to reach both. Two worker
settings make that work (the bundled `docker-compose.yml` pre-wires all three):

- **`SANDBOX_API_URL` / `SANDBOX_GATEWAY_URL`** — the api and gateway URLs *as
  resolved from inside a sandbox container*. This is **not** `PUBLIC_URL`: that
  is the browser-facing origin (often `localhost`), which inside the sandbox
  points back at the sandbox itself. On a shared Docker network use the service
  names (`http://api:4400`, `http://gateway:4410`); with host networking use
  `http://host.docker.internal:4400` / `:4410`. If unset, they fall back to
  `PUBLIC_URL` / `GATEWAY_URL`, which only works when those are already
  sandbox-reachable.
- **`FACILITY_SANDBOX_DOCKER_NETWORK`** — the seeded **Default runner** profile
  is `egress=restricted`, so a sandbox is given **no** network unless a Docker
  network is named. Point this at the network where the api and gateway live
  (the compose stack's default network is `facility_default`) so the sandbox can
  resolve them. A profile can override per-profile via `network.docker_network`;
  set `network.egress="unrestricted"` only for trusted local/e2e profiles.

If a run never leaves `provisioning` and the sandbox logs show connection
failures to the api or gateway, one of these two is almost always the cause.

## WorkOS SSO

Production authentication is WorkOS AuthKit (the dev-login path refuses to
enable in production):

1. Create a WorkOS environment; note client id + API key.
2. Set the redirect URI to `https://<api-host>/auth/callback`.
3. Configure your IdP connection (SAML/OIDC) in WorkOS.
4. Set `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD` (32+
   random chars), `WORKOS_AUTHKIT_DOMAIN`.

### Remote MCP OAuth 2.1 (interactive clients)

To let interactive MCP clients (Claude, Cursor, ChatGPT) authenticate with WorkOS
OAuth 2.1 access tokens instead of `fak_` API keys, set **`MCP_OAUTH_AUDIENCE`**
on the API service — the control plane keeps OAuth JWT auth
disabled until it is set (so audience is always validated). Run `facility-mcp
serve` with `MCP_PUBLIC_URL` (this MCP server's public URL) and
`MCP_AUTHORIZATION_SERVER` (defaults to `WORKOS_AUTHKIT_DOMAIN`) so it advertises
`/.well-known/oauth-protected-resource`. `fak_` keys keep working for services.

## GitHub App

Create a GitHub App in your org (the platform is installed **in your
environment** — no third-party App trust required):

- Permissions: contents RW, pull requests RW, issues RW, workflows R,
  checks R, members R (org), metadata R.
- Webhooks → `https://<api-host>/webhooks/github`, secret =
  `GITHUB_APP_WEBHOOK_SECRET`.
- Subscribe: installation, push, issues, issue_comment, pull_request,
  workflow_run.
- Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`.

## Hardening checklist

- Postgres and MinIO/S3 unreachable from the public network.
- Gateway reachable from sandboxes and CI only (it holds no read endpoints,
  but it is the money path).
- Sandboxes on an isolated network segment; egress per profile.
- Backups: Postgres PITR + object-store lifecycle; audit retention per your
  compliance window.
- Keep `node packages/cli/bin/facility.mjs doctor --url https://<api-host> --key
  fak_...` in the release
  checklist after every deploy and migration.
