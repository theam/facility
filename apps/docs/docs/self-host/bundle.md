---
title: Compose bundle
---

# Compose bundle

The bundle is the adoption path: one `docker compose up` brings up the whole control plane — API
with embedded MCP and webhooks, worker, web UI, PostgreSQL, and the workspace runner image — from
the repository's `docker-compose.yml`. It needs no cloud account and no Terraform.

Use the [quickstart](quickstart.md) instead when working on the Facility source, and the
[AWS reference deployment](aws.md) when a hosted control plane is the goal. The bundle runs every
service on one host with one Docker daemon, so it is an evaluation and small-team shape, not a
resilient deployment.

## Prerequisites

Docker with Compose v2, a running daemon the current user can reach, and a GitHub organization
whose repositories Facility may automate. Story workspaces hold repository checkouts, dependencies,
nested images, and persistent volumes; keep several gigabytes of disk free.

## Start the control plane

The master key encrypts every stored credential. Generate it once and keep it: an instance that
loses its key cannot decrypt the project secrets it already holds.

```bash
git clone https://github.com/theam/facility.git
cd facility
printf 'SECRET_MASTER_KEY=%s\n' "$(openssl rand -base64 32)" >> .env
docker compose up -d
```

The first run builds the API, web, and runner images. `migrate` applies the schema and must exit
zero before the API and worker start; `runner-image` builds the workspace image the worker later
hands to stories. Both are one-shot services, so `docker compose ps` showing them as exited is the
expected steady state.

Check the control plane:

```bash
curl --fail http://localhost:4400/health
curl --fail http://localhost:4400/readyz
```

| Surface | URL |
| --- | --- |
| Web UI | `http://localhost:3400` |
| API, MCP, webhooks, OpenAPI | `http://localhost:4400` |
| Story previews | `http://preview.localhost:4400` |

The preview origin is a separate security surface because it serves code an agent wrote. It stays a
registered site of its own even here; `preview.localhost` resolves to loopback in modern browsers.
A bundle whose origins are all loopback runs without TLS. Publishing any origin — a tunnel, a
reverse proxy, a LAN address — puts the whole set back under the HTTPS requirement described in the
[production guide](production.md).

## Connect GitHub

The bundle ships no identity, so sign-in and repository automation both have to be configured
before the first story. This is the longest step; the rest of the page takes minutes.

1. Create a **GitHub OAuth App** for browser sign-in with callback
   `http://localhost:3400/api/auth/callback`, and put its credentials in `.env`:

   ```dotenv
   AUTH_IDENTITY_PROVIDER=github
   GITHUB_OAUTH_CLIENT_ID=...
   GITHUB_OAUTH_CLIENT_SECRET=...
   ```

   Without them the login page offers GitHub sign-in and the API answers `auth_unconfigured`. See
   [Authentication](authentication.md) for the OIDC alternative and for the organization
   restriction.

2. Create and install the **GitHub App** that Facility uses for clone and push credentials,
   kickstart pull requests, and webhook-driven agents, then add `GITHUB_APP_ID`,
   `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` and `GITHUB_APP_SLUG` to `.env`. The
   permission table and event subscriptions are in the [GitHub App guide](github-app.md).

3. Apply the new configuration:

   ```bash
   docker compose up -d
   ```

GitHub cannot deliver webhooks to `localhost`. Agents triggered from the UI or MCP work without a
tunnel; issue, comment, and pull-request triggers need an HTTPS tunnel whose payload URL is
`https://<tunnel-host>/webhooks/github`, and `PUBLIC_URL` must match it. Treat that tunnel as
public.

## Bind the first owner

Migrations create the schema but no organization. Bind one owner to the installed GitHub App with
the operator CLI, which ships inside the API image:

```bash
docker compose exec api facility instance bootstrap \
  --org-name "Acme" --org-slug acme \
  --owner-email owner@acme.example --owner-name "Owner" \
  --github-user-id 1 --github-login owner \
  --github-account-id 2 --github-account-login acme \
  --github-installation-id 3
```

Read the account, user, and installation identifiers from the GitHub App installation. Repeating
the exact binding is safe; a different binding against a populated instance is refused rather than
applied.

## First story

Sign in at `http://localhost:3400`, create a project, choose a repository, and open its kickstart
pull request. After merging that configuration pull request, sync the project on the Pipeline page
and start a small disposable story. The [story operations guide](../guides/operate-story.md) covers
normal work, and the [end-to-end validation](../guides/validate-workspace-loop.md) is worth running
before connecting code that matters.

## Operate

```bash
docker compose logs -f api worker    # follow the control plane
docker compose up -d --build         # apply a new checkout
docker compose stop                  # stop; volumes and stories remain
```

Facility does not delete worktrees or session volumes by age, so watch disk usage. Story workspace
volumes are managed by Facility and outlive the API and worker containers: remove a story through
the product, not with broad Docker volume pruning. Before reusing a database from an earlier
release, read the [0.12 upgrade guide](../reference/upgrade-012.md).
