<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
    <img src="assets/wordmark-light.svg" alt="Facility" width="270">
  </picture>
</div>

<p align="center">
  <a href="https://github.com/theam/facility/actions/workflows/ci.yml"><img src="https://github.com/theam/facility/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-24%20LTS-161B22" alt="Node.js 24 LTS">
  <img src="https://img.shields.io/badge/license-Apache--2.0-FFD923" alt="Apache License 2.0">
</p>

Facility is a self-hosted service for continuing a software story with Claude Code or Codex in a
persistent development workspace. MCP is the primary interface. The web application exposes the
same projects, agents, stories, conversations, environments, previews, and lifecycle controls.

Facility 0.12 is a breaking simplification currently under development. Do not use a 0.11 database
with it. Back up existing data and start from an empty 0.12 database.

## The working model

Starting a story creates one durable unit of work:

- one shared conversation;
- one persistent worktree and volume;
- one or more resumable native Claude Code or Codex sessions;
- one normal Git branch and pull request; and
- the complete development environment declared by the repository.

Compute can sleep or be replaced. The conversation, session files, dependencies, uncommitted
changes, and worktree remain until an authorized user explicitly deletes the workspace. Merging or
archiving a story only suspends compute.

Agents use ordinary `git` and `gh` commands. Every configured agent receives the same full access
to the workspace and the same GitHub App installation capability for the project's repositories.
Facility does not implement per-agent permission profiles, internal write approvals, receipts,
or delivery brokers. Project budgets use a simple preflight check: a running provider call may
finish and is accounted afterwards, while later turns are blocked once the monthly limit has been
reached. GitHub branch protection, reviews, and CI remain the merge boundary.

## Agents as code

Every agent is a Markdown manifest under `.agents/`. The frontmatter selects its engine, model,
options, and triggers; the Markdown body is the prompt.

```markdown
---
name: security-audit
description: Audits the repository for actionable security risks.
engine: claude_code
model: claude-opus-4-8
enabled: true
triggers:
  - type: manual
  - type: mcp
  - type: ui
  - type: schedule
    name: weekly-security-audit
    cron: "0 5 * * 1"
    timezone: UTC
---

Audit reachable risks, preserve evidence, and continue from this story's shared workspace.
```

The same parser and dispatcher handle manual, MCP, UI, GitHub, and scheduled activations. A
manifest cannot declare `permissions`, `sandbox`, or `tools`; access is fixed for all agents.

Kickstart creates:

```text
.agents/
  architect.md
  builder.md
  pr-reviewer.md
  address-review.md
  ci-doctor.md
  security-audit.md
```

Teams can add or change agents by editing files in this directory. The database keeps only a cache
of the exact repository commit and content hash used for each turn.

## Repository environment

`.facility.yml` tells Facility what to clone, set up, start, wait for, and expose:

```yaml
version: 1
repositories:
  primary: github.com/acme/app
  related:
    - github.com/acme/shared
environment:
  setup: pnpm install --frozen-lockfile
  start: docker compose up -d
  ready: curl --fail http://localhost:3000/health
  secrets:
    - ANTHROPIC_API_KEY
    - OPENAI_API_KEY
  services:
    app:
      port: 3000
      protocol: http
      websocket: true
```

The workspace can run Docker and Docker Compose and includes browser tooling for end-to-end tests.
Secret names are committed in `.facility.yml`; their values come from the operator's secret
environment and are injected only while setup, services, or agents run. Use the provider variable
names supported by the selected Claude Code and Codex authentication method.
Declared services are available through short-lived, authenticated preview sessions routed to the
live workspace. Facility does not build a second preview deployment.

## MCP surface

The embedded Streamable HTTP server is available at `POST /mcp`. It exposes nineteen tools:

```text
facility_list_projects       facility_list_agents
facility_list_stories        facility_get_story
facility_start_story         facility_send_message
facility_get_conversation    facility_get_environment
facility_open_preview        facility_suspend_story
facility_archive_story       facility_restore_story
facility_delete_workspace
facility_get_costs           facility_get_budget
facility_set_budget          facility_get_observability
facility_get_pipeline        facility_sync_github
```

`facility_delete_workspace` is the only operation that destroys durable state. It requires an
explicit confirmation value and an idempotency key. Other lifecycle operations are reversible.

OAuth protected-resource metadata is served from
`/.well-known/oauth-protected-resource/mcp`. API keys can also authenticate MCP clients with a
Bearer header.

## Run locally

Requirements: Docker, Node.js 24 LTS, and pnpm 11.20.0.

```bash
git clone https://github.com/theam/facility.git
cd facility
corepack install --global pnpm@11.20.0
pnpm install --frozen-lockfile
pnpm dev
```

The local services are:

- web UI: `http://localhost:3400`
- API, MCP, webhooks, and preview proxy: `http://localhost:4400`
- PostgreSQL: `localhost:5461`

Build the workspace image before starting a real story:

```bash
docker build -f runner/Dockerfile -t facility-runner:dev .
```

Configure the GitHub App and authentication values in `.env`, migrate an empty database, and bind
the first owner and installation:

```bash
pnpm exec facility instance bootstrap \
  --org-name "My Org" --org-slug my-org \
  --owner-email you@example.com --owner-name "Your Name" \
  --github-user-id <user-id> --github-login <login> \
  --github-account-id <account-id> --github-account-login <account-login> \
  --github-installation-id <installation-id> \
  --github-account-type organization
```

For a production-shaped single-host stack:

```bash
SECRET_MASTER_KEY="$(openssl rand -base64 32)" docker compose up --build
```

Use TLS for the web, API/MCP, and preview origins in any shared deployment.

## Configure a repository

From the UI, create a project, select a repository visible to the GitHub App, review the detected
commands and port, then open the kickstart pull request. The PR contains only `.facility.yml` and
the six `.agents/*.md` manifests.

The local installer writes the same contract:

```bash
pnpm exec facility init \
  --repo=acme/app \
  --provision='pnpm install --frozen-lockfile' \
  --start='docker compose up -d' \
  --preview-readiness-command='curl --fail http://localhost:3000/health' \
  --service-port=3000

pnpm exec facility doctor
```

Existing files are preserved unless `--force` is explicit.

## GitHub App access

Facility is intended for repositories whose maintainers choose to trust coding agents with write
access. Configure the App with read/write access to Contents, Issues, Pull requests, Workflows,
Actions, Checks, and Deployments, plus read access to Metadata and organization membership. Select
only repositories that should be available to Facility.

Installation tokens are minted shortly before use and delivered through a credential helper; they
are not written to the persistent volume. Facility does not narrow a token according to the active
agent. The token keeps the GitHub App's complete configured permission set and is restricted to the
repositories connected to that project. Repository and tenant checks prevent one project from
receiving another project's credentials.

Do not enable signed webhook ingestion without `GITHUB_APP_WEBHOOK_SECRET`. Preview sessions are
authenticated, expire, can be revoked, and re-check project membership on every proxied request.

## Validation

```bash
pnpm verify
```

The acceptance suite covers manifest validation, idempotent story creation, serialized turns,
session and worktree persistence, Docker runtime replacement, cost and budget enforcement, GitHub
credential scoping and delivery mirroring, webhook replay, schedules, authenticated HTTP and
WebSocket previews, embedded MCP, AWS control-plane planning, and the UI build.

Facility is early software. The 0.x schema and API can change incompatibly. Review the
[security model](apps/docs/docs/reference/security.md),
[architecture](apps/docs/docs/reference/architecture.md), and
[0.12 validation guide](apps/docs/docs/guides/validate-workspace-loop.md) before using it with a
sensitive repository.

## Documentation and contributing

The documentation site includes paths for [operating a
story](apps/docs/docs/guides/operate-story.md), [self-hosting in
production](apps/docs/docs/self-host/production.md), the exact [project
manifest](apps/docs/docs/reference/project-manifest.md) and [agent
manifest](apps/docs/docs/reference/agent-manifest.md) contracts, and
[troubleshooting](apps/docs/docs/guides/troubleshooting.md).

To work on Facility, read [Contributing](CONTRIBUTING.md), the [contributor
architecture](apps/docs/docs/contributors/architecture.md), [testing
guide](apps/docs/docs/contributors/testing.md), and [documentation
guide](apps/docs/docs/contributors/documentation.md). Public issues and pull
requests should contain enough product-technical context for someone outside
the maintainer group to understand and verify the change, without private
deployment or repository details.

Apache-2.0. No warranty.
