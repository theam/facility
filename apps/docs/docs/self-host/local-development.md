---
title: Local development
---

# Local development

This guide covers work on the Facility monorepo. If you only want to run the product, begin with the
[quickstart](quickstart.md).

## Toolchain

Install Node.js 24 LTS and pnpm 11.20.0 before running the repository:

```bash
corepack install --global pnpm@11.20.0
```

The root `package.json` also accepts Node.js 22 from 22.13.0. Use the repository `.nvmrc` when
working with nvm. Do not substitute npm or yarn: the lockfile, workspace filters, and verification
scripts assume pnpm.

Clone the repository, then run:

```bash
pnpm dev
```

## What `pnpm dev` owns

`pnpm dev` starts PostgreSQL, builds shared packages, applies migrations, and runs the API, worker,
UI, and documentation site. The worker needs access to the local Docker daemon to create persistent
workspace containers and volumes. Development mode seeds a local owner; use **continue locally** on
the login page. This route is restricted to loopback URLs and cannot be enabled in production.

The source stack uses:

- UI at `http://localhost:3400`;
- API, MCP, webhook, OpenAPI, and preview proxy at `http://localhost:4400`;
- PostgreSQL at `localhost:5461`; and
- the Docker daemon selected by the current Docker context.

The API and worker are separate processes. If stories can be created but remain queued, confirm the
worker process did not exit after startup. If the UI is healthy but API calls fail, inspect the API
terminal and `/readyz` before changing client code.

## Environment configuration

Copy `.env.example` only when the development script has not already created `.env`. Existing
values are preserved. Generate a local master key with:

```bash
openssl rand -base64 32
```

`FACILITY_INSECURE_DEV=1` enables the local owner shortcut only when web and API hosts are loopback.
Use real GitHub or OIDC authentication when testing identity behavior. Configure project engine
values with their full `FACILITY_PROJECT_<PROJECT_ID>_<NAME>` keys in `.env`; never add them to a
fixture, snapshot, or committed example.

## Runner and workspace runtime

Build the development runner before Docker-backed story tests:

```bash
docker build -f runner/Dockerfile -t facility-runner:dev .
```

The control-plane API and worker use the host Docker socket to create story resources. Each story
container uses a named persistent volume and a workspace-scoped nested Docker daemon. Repository
commands must not escape to the host daemon.

List exact workspace resources when debugging and preserve them across compute replacement. Avoid
`docker system prune --volumes` on a development machine that contains evidence you still need.

## Focused development loops

Use these checks while developing:

```bash
pnpm --filter @facility/agents test
pnpm --filter @facility/api test
pnpm --filter @facility/mcp test
pnpm --filter @facility/web typecheck
pnpm verify
```

Use package filters that match the changed boundary. Important packages and services are described
in the [contributor architecture](../contributors/architecture.md). Run the docs build after editing
navigation or links, and run browser checks after editing the UI.

Database migrations are immutable once committed. Add a new migration, update schema code, and run
the migration guard rather than rewriting an existing file. Integration tests create allowlisted
isolated databases; do not point test commands at a database that contains useful data.

## Docker workspace acceptance

Set `FACILITY_E2E_DOCKER=1` to run the Docker replacement test. It creates a named volume, writes
state, suspends and replaces compute, then verifies that the same files remain.

The complete command, database isolation requirements, and CI policy are in
[Testing](../contributors/testing.md). A focused unit suite cannot replace this tier for changes to
runtime, persistence, previews, credentials, or lifecycle behavior.

## GitHub and OAuth callbacks

GitHub cannot send webhooks to localhost. Use an HTTPS tunnel and set its payload URL to
`https://<api-host>/webhooks/github`. Match `WEB_URL`, `PUBLIC_URL`, OAuth callback URLs, and the
preview origin to the host used by the browser.

The preview origin is a separate security surface even in development. `preview.localhost` resolves
to loopback in modern browsers; if your environment does not resolve it, add an equivalent local
hostname while preserving origin separation.

When using an HTTPS tunnel, expose only the routes required for the test and treat the tunnel URL
as public. Do not enable the insecure local login on it.

## Before opening a pull request

Run the focused suites while iterating, then `pnpm verify` from a cleanly buildable worktree. Record
the exact command and result. For a UI change, include a browser walkthrough and screenshots where
they aid review. For a documentation change, build the Docusaurus site and run its contract tests.

See [Contributing](https://github.com/theam/facility/blob/main/CONTRIBUTING.md) for branch, commit,
pull-request, and release rules.
