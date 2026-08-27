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
  own schema and system-data reconciliation at deploy (`@facility/db deploy`). The gateway holds a
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
  upstream identity credentials, OAuth signing keys, and GitHub App credentials.
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
   AWS-compatible credentials. The compose stack only runs the bundled MinIO and
   auto-creates its bucket under the `local-storage` profile; a production
   deployment points `S3_ENDPOINT` at an externally provisioned store and omits
   the profile, so the API and gateway neither run MinIO nor wait on bucket
   creation.
3. Load secrets into the runtime: `SECRET_MASTER_KEY`, identity/OAuth variables, and
   the GitHub App variables when repo automation is enabled.
4. Run the database deploy gate once, before app traffic. Set
   `FACILITY_RUNNER_IMAGE` first (build/push the runner image from `runner/`) so
   the reconciled default profile can run platform-lane agents. The command
   holds one bounded advisory-lock session across migrations and bundled roles,
   action types, registry essentials, and sandbox profiles:

   ```bash
   FACILITY_RUNNER_IMAGE=<your-runner-image> FACILITY_SEED_DEMO=0 pnpm --filter @facility/db deploy
   ```

   In a production image the equivalent entry point is
   `node node_modules/@facility/db/dist/bin/deploy.js`. The task emits JSON phase
   timings. Exit `10` means lock timeout and is safe to retry; `11` means an
   already-applied migration changed and requires operator correction; `12`
   means a migration failed and its transaction was rolled back. Existing
   filename-only ledgers adopt SHA-256 checksums on their first upgraded run.
   Checksums cover the migration's exact UTF-8 bytes, including whitespace and
   line endings; correct drift by restoring the shipped file, never by editing
   the ledger.

5. Start or roll the services in this order: `api`, `worker`, `gateway`, `mcp`,
   then optional `web`.
6. Bootstrap the first owner and issue an API key. On an empty installation,
   run `facility instance bootstrap`, then open `https://<web-host>/api/auth/login`; the configured GitHub user
   signs into the organization already created by bootstrap. With the optional web
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
   (GitHub/OIDC login configured), GitHub App env completeness when
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

## GitHub login

Self-hosted installations create their own GitHub App and enable user authorization.
Set its callback to `https://<web-host>/api/auth/callback`, grant read access to
user email addresses, and configure `AUTH_IDENTITY_PROVIDER=github`,
`GITHUB_OAUTH_CLIENT_ID`, and `GITHUB_OAUTH_CLIENT_SECRET`. Optionally set
`GITHUB_OAUTH_ALLOWED_ORGANIZATION` to a GitHub organization login to require
active membership at sign-in. Bootstrap the dedicated organization, owner,
account, and installation binding with `facility instance bootstrap`.

SaaS instances instead set `AUTH_IDENTITY_PROVIDER=oidc` and use the commercial
identity broker. See [Authentication modes](authentication) for the broker claim contract.

### Remote MCP OAuth 2.1 (interactive clients)

Each Facility instance is the authorization server for its MCP resource. Set
`FACILITY_OAUTH_ISSUER` to the exact `WEB_URL` origin, configure a private ES256
`FACILITY_OAUTH_JWKS`, and set `MCP_PUBLIC_URL` to the MCP origin or its canonical
`/mcp` endpoint; point `MCP_AUTHORIZATION_SERVER` at the issuer. The web runtime
proxies the authorization endpoints to the API, keeping every browser cookie
host-only and same-origin. Interactive
clients use Authorization Code + PKCE and receive 15-minute, audience-bound JWTs
plus rotating refresh tokens. All four browser/resource URLs must use HTTPS in production; an
all-loopback HTTP configuration is retained only for local development. `fak_` keys remain
available for services.

> **Breaking upgrade:** update configuration or Terraform before deploying the new API, web, and
> MCP images. The issuer changes from the API origin to `WEB_URL`, and the token audience changes
> from the MCP origin to the canonical `/mcp` resource. Deploy those three services together, then
> reconnect interactive MCP clients and start new browser sessions; existing access/refresh flows
> must not be reused. For old `pnpm dev` `.env` files, replace the legacy
> `FACILITY_OAUTH_ISSUER=http://localhost:4400` and
> `MCP_AUTHORIZATION_SERVER=http://localhost:4400` values with `http://localhost:3400`. See the
> [MCP upgrade guide](../reference/mcp#breaking-upgrade-same-origin-path-aware-oauth).

## GitHub App

Create a GitHub App in your organization; the platform is installed **in your
environment**, so no third-party App trust is required. The App needs separate
permissions for repository contents, workflow files, Actions runs, checks,
deployments, issues, and pull requests. Its webhook URL is the public API origin
plus `/webhooks/github`.

Follow the [complete GitHub App guide](github-app) for the current permission
matrix, event subscriptions, private key and webhook-secret setup, installation
order, and end-to-end verification.

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
