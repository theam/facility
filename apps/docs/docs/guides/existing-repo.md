---
title: Configure an existing repository
---

# Configure an existing repository

You can adopt Facility without reorganizing a repository. The work is to describe its existing
development environment and review the initial agent catalog.

## 1. Make the development environment reproducible

Start from the command a new maintainer would run on Linux. It must install dependencies, launch
required services, and expose an application port without relying on an interactive desktop.

For a Compose repository, a useful first contract is:

```yaml
version: 1
repositories:
  primary: github.com/acme/payments
  related: []
environment:
  setup: corepack enable && pnpm install --frozen-lockfile
  start: docker compose up -d
  ready: curl --fail --silent http://127.0.0.1:3000/health
  stop: docker compose down
  browser_test: pnpm test:e2e
  services:
    app:
      port: 3000
      protocol: http
      websocket: true
```

Facility runs Docker inside the workspace. Do not mount the Facility host Docker socket from the
project Compose file. Use project-local volumes and avoid fixed container names so separate story
workspaces cannot collide.

## 2. Add related repositories only when needed

List a related repository when setup, development, or testing needs its checkout. Facility places
all checkouts under `repos/<owner>/<repository>` and gives the agent GitHub credentials for the
repositories connected to the project.

Keep the primary repository as the owner of `.facility.yml`, `.agents/`, the story branch, and the
delivery pull request. A related repository can be edited, committed, and pushed, but cross-repo
delivery remains an explicit part of the agent prompt and human review.

## 3. Declare runtime inputs

List secret names under `environment.secrets` and non-secret operator values under
`environment.variables`. The repository stores names, never values:

```yaml
environment:
  start: docker compose up -d
  secrets:
    - ANTHROPIC_API_KEY
    - TEST_DATABASE_PASSWORD
  variables:
    - PAYMENT_PROVIDER_MODE
  services:
    app:
      port: 3000
```

The instance operator provides each value as
`FACILITY_PROJECT_<PROJECT_ID>_<NAME>` to the API and worker. Facility uppercases the lowercase
project id when forming that name. A missing declaration fails workspace preparation rather than
silently using a control-plane variable.

## 4. Review the agent catalog

Run `facility init` to create the default manifests, then edit them like any other repository
files. Keep only triggers you intend to use. Choose an installed engine and model for every agent.
The catalog is configurable, but access is uniform: all enabled agents receive full workspace and
GitHub maintainer capability for the project.

Add a custom agent by adding another lower-kebab-case Markdown file under `.agents/`. There is no
registration step outside the repository.

## 5. Validate in a disposable story

Run `facility doctor`, merge the configuration through normal review, sync the project, and start a
small story. Test installation, environment startup, preview access, browser automation, commit and
PR creation, suspend/wake persistence, and explicit deletion. Use the [end-to-end
checklist](validate-workspace-loop.md) before relying on the repository for production work.

If the repository already has generated or local-only files, update `.gitignore` normally. Do not
ignore `.facility.yml` or `.agents/`; they are reviewed product configuration.
