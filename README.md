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

Facility is open-source, self-hosted tooling for running AI coding agents as
part of a reviewable software delivery process — with the humans, the gates
and the evidence in one place.

Facility connects software work, agents, development environments, GitHub delivery state, human
review, costs, and operational evidence. Each story has a persistent workspace and shared
conversation that agents and people can continue until the work is complete. MCP is the primary
automation interface, while the web application is a first-class surface over the same projects,
agents, stories, conversations, environments, previews, and lifecycle controls.

## Status: early software, published early on purpose

Facility runs the delivery of the team that builds it, and nowhere else yet. It
is published at this stage deliberately: a platform for governing AI-assisted
delivery is not something to design in private for a year and then unveil. It
gets better by being used, argued with, and corrected.

What that means in practice: the database schema moves, the API is versioned
but young, features arrive ahead of their documentation, and no upgrade path is
promised between `0.x` releases. Point it at repositories where a bad agent
pull request is an inconvenience rather than an incident, and read the
[security model](apps/docs/docs/reference/security.md) and the
[hardening notes](apps/docs/docs/reference/hardening.md) before pointing it at
anything else. Apache-2.0 means what it says: no warranty, use at your own
risk.

Bug reports, questions and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). Rough edges are expected, and the ones you
hit are the ones worth fixing first.

## Who Facility is for

- **Engineering teams** that want one explicit standard for humans and agents,
  reproducible environments for agent runs, and deterministic checks for
  repository-specific rules.
- **Platform and engineering leaders** operating agents across several
  repositories who need repository-owned agent configuration, credentials,
  spend limits, audit history, and outcome data.
- **Security-conscious organizations** that need to keep the control plane,
  run records, and model traffic in their own environment while using
  repository-scoped maintainer credentials and GitHub review and merge controls.

Start by connecting one repository, then add its `.facility.yml` and `.agents/` contracts through
the kickstart pull request.

## What you can do with it

| Goal | Facility provides |
|---|---|
| Take work from an issue to a pull request | Mirror GitHub issues into stories, dispatch repository-defined agents, and follow their branches, commits, checks, reviews, and pull requests through delivery. |
| Keep work available between agent turns | One shared conversation, persistent worktree and volume, and resumable Claude Code or Codex sessions live until an authorized user explicitly deletes the workspace. |
| Give agents a complete development environment | `.facility.yml` defines setup, startup, readiness, browser tests, services, and secrets. Workspaces can run Docker and Docker Compose. |
| Test the running result | Facility opens authenticated previews of services running inside the workspace, including WebSocket applications. |
| Configure every agent in the repository | Markdown manifests in `.agents/` define prompts, engines, models, options, and manual, MCP, UI, GitHub, or scheduled triggers. |
| Inspect project capabilities | The web UI and MCP list the agents and the skills installed under `.agents/skills/` and `.claude/skills/` at the repository commit used by Facility. |
| Review what an agent changed | Every turn records its agent, model, session, workspace, initial and final Git state, commits, changed files, and related GitHub delivery events in the story timeline. |
| Keep accountability with people and repository rules | People steer the conversation and review the running result and pull request. Branch protection, required CI, reviews, and merge controls remain the delivery boundary. |
| Track and limit spend | Facility attributes model and workspace costs to projects and agents, presents cost analysis, and enforces monthly project budgets before new provider calls. |
| Operate the system | Audit history, observability records, analytics, and periodic GitHub reconciliation make delivery and control-plane health inspectable. |
| Work from automation or a human interface | MCP is the primary automation interface; the web application exposes the same stories, agents, environments, previews, evidence, and lifecycle operations. |

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
Facility uses one maintainer trust model for every agent instead of per-agent permission profiles.
Project budgets use a preflight check: a running provider call may finish and is accounted
afterwards, while later turns are blocked once the monthly limit has been reached. GitHub branch
protection, reviews, and CI remain the merge boundary.

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

Facility also inventories valid skills installed under `.agents/skills/**/SKILL.md` and
`.claude/skills/**/SKILL.md`. The Agents page and `facility_list_skills` MCP tool show their names,
descriptions, paths, and source commit. Facility does not distribute or upgrade a separate catalog;
the repository remains the source of truth for both agents and skills.

## Delivery evidence

Each turn records its agent, engine, model, resumable session, workspace, branch, and initial Git
SHA before the engine starts. When the turn settles, Facility records the final SHA, commits,
changed files, and whether uncommitted changes remain. These records are available for review in
the story timeline.

GitHub webhooks and ten-minute reconciliation add branch, pull-request, review, and check facts.
Facility links a GitHub fact to the exact turn when its head SHA matches that turn's final SHA and
otherwise keeps it as an external change on the story. The web UI and `facility_get_story` expose
conversation, agent activity, Git changes, artifacts, attention, and GitHub delivery in one ordered
story timeline.

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

The embedded Streamable HTTP server is available at `POST /mcp`. It exposes twenty tools:

```text
facility_list_projects       facility_list_agents
facility_list_skills
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

## Quick start: run Facility

Running Facility locally takes one command for the stack, a runner image for story workspaces, and
a GitHub App when you want to use a real repository. You need Docker, Node.js 24 LTS, and the
repository-pinned pnpm 11.20.0. Node.js 22 is supported from 22.13.0.

### 1. Clone and boot the stack

```bash
git clone https://github.com/theam/facility.git
cd facility
corepack install --global pnpm@11.20.0
pnpm dev
```

`pnpm dev` creates `.env` when needed, fills only blank development values, starts PostgreSQL,
installs dependencies, builds shared packages, applies migrations, seeds local data, and launches
the API and worker, web application, and documentation site. Existing `.env` values are never
replaced, and the command refuses a non-local `DATABASE_URL`.

The local services are:

| Service | Address | Role |
|---|---|---|
| Web | `http://localhost:3400` | Human interface |
| API | `http://localhost:4400` | REST, MCP, webhooks, previews, and OAuth |
| Docs | `http://localhost:3500` | Documentation site |
| PostgreSQL | `localhost:5461` | Persistent control-plane data |

Build the workspace image before starting a real story:

```bash
docker build -f runner/Dockerfile -t facility-runner:dev .
```

To delegate local setup to Claude Code or Codex, paste this prompt:

> Set up and launch Facility from this repository. Run `pnpm dev`, fix prerequisite errors without
> replacing existing `.env` values, build the runner image, wait for the services to be ready, then
> report their local URLs.

### 2. Create the GitHub App

Create one GitHub App for the Facility instance and install it only on repositories the instance
may automate. Use `http://localhost:4400/webhooks/github` as the local webhook URL.

Grant these repository permissions:

| Permission | Access |
|---|---|
| Actions, Checks, Contents, Deployments, Issues, Pull requests, Workflows | Read and write |
| Code scanning alerts, Dependabot alerts, Secret scanning alerts, Metadata | Read-only |

Grant organization membership read access when repository discovery or identity policy requires
it. Subscribe to Issues, Issue comment, Pull request, Pull request review, Workflow run, and Check
suite events. The [GitHub App guide](apps/docs/docs/self-host/github-app.md) covers the exact setup,
validation, and rotation procedure.

### 3. Configure the instance

Add the App values to `.env`:

```dotenv
GITHUB_APP_ID=<App ID>
GITHUB_APP_SLUG=<App slug>
GITHUB_APP_PRIVATE_KEY="<private key>"
GITHUB_APP_WEBHOOK_SECRET=<webhook secret>
```

Use the project-scoped environment convention for model credentials. For a project whose id is
`proj_example`:

```dotenv
FACILITY_PROJECT_PROJ_EXAMPLE_ANTHROPIC_API_KEY=<key>
FACILITY_PROJECT_PROJ_EXAMPLE_OPENAI_API_KEY=<key>
```

Restart `pnpm dev` after changing `.env`. For production authentication, configure GitHub OAuth or
OIDC and bind the first owner and GitHub installation:

```bash
pnpm exec facility instance bootstrap \
  --org-name "My Org" --org-slug my-org \
  --owner-email you@example.com --owner-name "Your Name" \
  --github-user-id <user-id> --github-login <login> \
  --github-account-id <account-id> --github-account-login <account-login> \
  --github-installation-id <installation-id> \
  --github-account-type organization
```

Local development can use **continue locally** on the login page. That shortcut cannot mint
GitHub installation tokens, so real clone, push, pull-request, webhook, mirror, and kickstart tests
need the App configuration above.

### Troubleshooting setup

| Symptom | Cause and fix |
|---|---|
| The UI starts but no repositories are available | Configure and install the GitHub App, bind its installation to the instance, then restart the API and worker. |
| A story stays queued | Confirm the worker process is running and inspect its queue and dispatch logs. |
| Workspace creation reports a missing image | Build `facility-runner:dev` or set `FACILITY_WORKSPACE_IMAGE` to the runner image available to the selected provider. |
| A webhook has no effect | Check its HMAC secret, event subscription, installation binding, repository connection, and the agent's GitHub trigger. |
| A preview does not open | Check the service name, readiness command, preview origin, workspace state, and preview authorization logs. |

### 4. Connect your first repository

Create a project in the web application and choose a repository visible to the GitHub App. Facility
imports its issues and delivery state. Review the detected setup command, development command, and
service port, then open and merge the kickstart pull request.

The pull request adds the repository contracts Facility needs:

```text
.facility.yml
.agents/
  architect.md
  builder.md
  pr-reviewer.md
  address-review.md
  ci-doctor.md
  security-audit.md
```

The local CLI writes the same files:

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

### 5. Start a story

Start an issue-backed or ad hoc story from MCP or the web application. Select an agent whose
manifest admits that trigger. Facility creates the shared conversation and workspace, prepares the
repository environment, and queues the first turn.

Open the declared service preview, suspend the story, and continue it to verify that the
conversation, worktree, and engine session persist. Follow the [story operations
guide](apps/docs/docs/guides/operate-story.md) for normal work and the [end-to-end validation
guide](apps/docs/docs/guides/validate-workspace-loop.md) before connecting sensitive code.

## Operate without the web application

AI clients use the embedded MCP server. Operators can also use the versioned REST API and OpenAPI
schema:

```bash
# REST/OpenAPI
open http://localhost:4400/docs

# MCP streamable HTTP
curl --fail http://localhost:4400/health
```

Register the MCP endpoint directly in Claude Code or Codex:

```bash
claude mcp add --transport http facility https://facility.example.com/mcp
codex mcp add facility --url https://facility.example.com/mcp
codex mcp login facility
```

See the [MCP](apps/docs/docs/reference/mcp.md), [API](apps/docs/docs/reference/api.md), and
[webhook](apps/docs/docs/reference/webhooks.md) references for the complete contracts.

## How the delivery loop works

1. Work starts from a GitHub issue, an ad hoc request, a schedule, or a configured GitHub event.
2. Facility creates or resumes the story's shared conversation and persistent workspace.
3. The selected repository-defined agent continues the work with its configured engine and model.
4. The repository setup, services, tests, and browser checks run inside the workspace.
5. A person can steer the conversation and test the running service through an authenticated
   preview.
6. The agent uses normal Git and GitHub operations to commit, push, and open or update a pull
   request.
7. Facility mirrors the branch, pull request, reviews, and checks and relates them to the agent turn
   when their Git SHAs match.
8. Repository CI, review, branch protection, and merge controls decide what is accepted.
9. Merge suspends compute and marks the story done. The conversation, worktree, and engine session
   stay available until explicit deletion.

Read [the method](apps/docs/docs/concepts/method.md) and [the story
loop](apps/docs/docs/concepts/the-loop.md) for the operating model and exact lifecycle.

## Getting the most from Facility

1. **Make setup reproducible.** `environment.setup` should create everything the development
   environment and checks need on a fresh machine.
2. **Define readiness.** Use `environment.ready` so agents, previews, and browser checks do not race
   a service that has not started.
3. **Keep agents focused.** Give each `.agents/*.md` manifest one clear role, select its engine and
   model explicitly, and configure only the triggers it should accept.
4. **Protect the default branch.** Require pull requests, current CI, and human review. Agents have
   maintainer access to their working branches.
5. **Set project budgets.** Facility checks the monthly limit before new provider calls and records
   usage after each turn. Treat unavailable pricing as unavailable, not zero.
6. **Review the whole story.** Use the timeline to inspect prompts, agents, Git changes, previews,
   costs, reviews, and checks together.
7. **Plan retention.** Workspace storage persists across suspend, archive, merge, and compute
   replacement. Delete it only after preserving anything the team needs.
8. **Watch the mirror and control plane.** Monitor webhook and reconciliation freshness, queue lag,
   workspace failures, cost collection, and preview authorization.

The [security model](apps/docs/docs/reference/security.md), [hardening
notes](apps/docs/docs/reference/hardening.md), and [production
guide](apps/docs/docs/self-host/production.md) cover these practices in detail.

## Current status

Facility is pre-1.0 software. The schema, APIs, manifests, and deployment shape may change between
`0.x` releases. The current web application covers projects, repository-defined agents and skills,
stories and shared conversations, persistent environments and previews, delivery pipelines, costs
and budgets, insights, settings, and members. MCP is the primary automation interface; the REST API
and web application expose the same domain operations for their respective clients.

The [architecture document](apps/docs/docs/reference/architecture.md) describes the topology,
security boundaries, and component responsibilities.

## Repository map

```text
apps/web              Next.js human interface
apps/docs             Docusaurus documentation
services/api          REST control plane, MCP, workers, GitHub, previews, and workspaces
packages/agents       agent manifests and trigger contracts
packages/cli          repository setup, validation, and instance bootstrap
packages/core         shared domain primitives
packages/db           PostgreSQL schema and migrations
packages/mcp          MCP tools and schemas
packages/sdk          generated TypeScript API client
packages/ui           shared React design system
runner                complete agent workspace image
infra/terraform/aws   AWS control-plane reference deployment
```

## Contributing

Bug reports, documentation improvements, and focused feature proposals are welcome. Before
implementing a substantial change, open an [issue](https://github.com/theam/facility/issues) so its
behavior and boundaries can be agreed on.

```bash
git clone https://github.com/theam/facility.git
cd facility
corepack install --global pnpm@11.20.0
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs lint and type checks, a clean cache-disabled build, critical integration tests,
the remaining uncached tests, repository guards, and the dependency gate. CI separately builds the
self-host images and applies the Docker-backed workspace E2E policy documented in
[docs/testing.md](docs/testing.md).

Use a semantic branch name such as `docs/readme` or `fix/workspace-recovery`, keep the change to one
coherent intent, add tests for behavior changes, and include the commands you ran in the pull
request. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [contributor
documentation](apps/docs/docs/contributors/architecture.md) for the complete workflow. Report
vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 The Agile Monkeys.

---

<p align="center">
  <img src="assets/mark.svg" alt="" width="28"><br>
  <sub>An initiative by <a href="https://theagilemonkeys.com">The Agile Monkeys</a></sub>
</p>
