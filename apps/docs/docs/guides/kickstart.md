---
title: Kickstart a repository
---

# Kickstart a repository

Kickstart adds Facility's repository-owned contract without changing application code. Use the UI
when the repository is already connected to an instance. Use the CLI when you want to prepare the
files locally before connecting it.

## Before kickstart

You need:

- a GitHub repository and permission to open a configuration pull request;
- a development command that starts the complete environment non-interactively;
- one service port Facility can expose for the application; and
- a Facility project whose GitHub App installation can access the repository.

Prefer a Compose command when the application depends on databases, queues, or other services. A
single package start script is enough for a standalone application. Commands run from the primary
repository checkout inside the workspace.

## Kickstart from the UI

Create a project in the UI and choose a repository visible to the GitHub App. Facility detects a
Compose file or a package start script. Review and, if needed, edit the setup command, start
command, readiness command, and exposed application port.

Kickstart opens a pull request containing exactly `.facility.yml` and six initial agent manifests
under `.agents/`. Existing files are not overwritten. The pull request does not modify the default
branch until a maintainer merges it.

If the preview shows an incorrect command, correct it before creating the PR. Detection is a
starting point; the repository contract must be deterministic enough to run in a fresh Linux
workspace.

## Kickstart from the CLI

The CLI writes the same files locally:

```bash
facility init \
  --repo=acme/app \
  --provision='pnpm install --frozen-lockfile' \
  --start='docker compose up -d' \
  --preview-readiness-command='curl --fail http://localhost:3000/health' \
  --service-port=3000

facility doctor
```

`facility init` is interactive by default. Use `--yes` with explicit flags in automation. It writes
`.facility.yml` plus the six default manifests and leaves every existing target untouched unless
`--force` is present.

Model flags let the initial catalog match your provider setup:

```bash
facility init --yes \
  --repo=acme/app \
  --start='docker compose up -d' \
  --service-port=3000 \
  --build-model=gpt-5.6-sol \
  --review-model=claude-sonnet-5 \
  --plan-model=claude-opus-4-8
```

Use `facility init --help` for the complete flag set. See the [CLI reference](../reference/cli.md)
for overwrite and exit behavior.

## Review the pull request

Before merge, inspect every command and port in `.facility.yml`, and inspect each agent's prompt,
engine, model, and triggers. All of them will run with full workspace and GitHub maintainer access.

In particular, verify:

- `repositories.primary` names the repository that owns the story branch and agent catalog;
- related repositories are listed if the environment needs them;
- `setup` is safe to rerun when the manifest changes;
- `start` returns after launching long-running services rather than holding the only shell;
- `ready` fails until the exposed service can actually accept traffic;
- every declared secret and variable has an operator-provided value; and
- scheduled and GitHub triggers cannot activate unexpectedly.

Run `facility doctor` from the repository root, commit the files, and let CI exercise them before
merging. The server performs stricter validation when it loads the merged catalog and project
manifest, so use the [manifest references](../reference/project-manifest.md) as the authoritative
schema.

## After merge

Request an immediate GitHub sync if the project does not yet see the commit. Confirm the agents
appear in the UI or through `facility_list_agents`, then start a disposable story and follow the
[validation guide](validate-workspace-loop.md). Kickstart is complete only when the declared
environment becomes ready in a Facility workspace.
