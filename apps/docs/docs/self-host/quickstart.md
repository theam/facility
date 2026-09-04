---
title: Quickstart
---

# Self-host quickstart

This path runs Facility from source for local evaluation and development. Use the [production
guide](production.md) before exposing an instance to other users or repositories.

## Prerequisites

Install Docker, Node.js 24, and the repository-pinned pnpm version.

Node.js 22 is also supported from 22.13.0. Docker must be running and the current user must be able
to use it. Local story workspaces require enough disk for repository checkouts, dependencies,
nested Docker images, and persistent volumes.

## Start the local stack

```bash
corepack install --global pnpm@11.20.0
pnpm install --frozen-lockfile
cp .env.example .env
docker build -f runner/Dockerfile -t facility-runner:dev .
pnpm dev
```

`pnpm dev` preserves existing `.env` values, starts PostgreSQL from `docker-compose.dev.yml`, builds
shared packages, applies migrations, seeds the local instance, and runs the API, worker, UI, and
documentation site. Keep that terminal open while using the source stack.

The runner build is separate because story workspaces use it as their complete development image.
Rebuild it after changing `runner/Dockerfile` or its entrypoint scripts.

## Verify the processes

The UI is on `http://localhost:3400`; the API, MCP server, GitHub webhook, and preview proxy are on
`http://localhost:4400`. Local PostgreSQL listens on port 5461.

Check the public probes:

```bash
curl --fail http://localhost:4400/health
curl --fail http://localhost:4400/readyz
```

Open the API schema at `http://localhost:4400/docs`. The documentation development server URL is
printed by `pnpm dev`.

## Sign in and connect a repository

For local development, choose **continue locally** on the login page. To exercise real repositories,
configure a GitHub App for repository access and restart the services. Production installations use
GitHub or OIDC authentication and bind the first owner with `facility instance bootstrap`. Create a
project in the UI, choose a repository, and open its kickstart PR. After merging that configuration
PR, start a story through MCP or the Stories page.

The local sign-in shortcut is intentionally limited to loopback `PUBLIC_URL` and `WEB_URL` and is
refused under `NODE_ENV=production`. It is useful for UI work but cannot mint GitHub installation
tokens. Configure the [GitHub App](github-app.md) before testing clone, push, PR, webhook, mirror,
or kickstart behavior against a real repository.

## Create the first story

After the configuration PR is merged:

1. sync the project in the Pipeline page;
2. confirm the selected agent includes a `ui` or `mcp` trigger;
3. start a small disposable story;
4. watch its conversation and environment become ready;
5. open the `app` preview; and
6. suspend and continue the story to prove its files persist.

Use the [story operations guide](../guides/operate-story.md) for normal work and the [end-to-end
validation](../guides/validate-workspace-loop.md) before connecting production code.

## Stop and resume

Stop the foreground processes with Ctrl-C. The local PostgreSQL volume and Facility workspace
volumes remain. A later `pnpm dev` uses the same data. Use Docker's normal inventory commands to
inspect resources; do not run broad volume-pruning commands if you need retained stories.

To remove only the local development database, first confirm the exact Compose project and volume,
then use the Compose down-volume operation. This does not safely replace Facility's per-story
workspace deletion path.

## Upgrading an existing installation

Before reusing an older database, read the [0.12 upgrade
guide](../reference/upgrade-012.md). The migration command refuses an incompatible schema without
changing it.
