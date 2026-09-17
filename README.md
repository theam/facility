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

# A persistent workspace for every story

Facility is an open-source, self-hosted platform for teams working with Claude Code and Codex.
Each task keeps a shared conversation, a development environment, and a record of the changes made.
People and agents can continue the work, try the running application, and review the pull request.

We call that unit of work a **story**. Its files, dependencies, and engine sessions stay together
when an agent finishes or compute stops. The next turn continues in the same workspace.

[How it works](#how-the-work-moves) · [Run it locally](#quick-start-run-facility) ·
[Self-hosting guide](apps/docs/docs/self-host/quickstart.md) ·
[Security model](apps/docs/docs/reference/security.md)

## Status

Facility is early software, used by the team building it. We publish it while it is developing so
others can try the workflow, inspect the code, and help improve it. APIs, database schemas, and
manifests may change between `0.x` releases; no upgrade path is promised yet.

Start with a repository where your team can review the changes and tolerate failed runs. Read the
[security model](apps/docs/docs/reference/security.md) before connecting code or credentials. Bug
reports, questions, and focused pull requests are welcome.

## How the work moves

1. **Choose the work.** Start a story from a GitHub issue or an ad hoc request. Repository-defined
   agents can also respond to configured GitHub events and schedules.
2. **Continue with an agent.** Facility prepares the repository's development environment and runs
   the selected Claude Code or Codex agent. People can steer the shared conversation, and later
   turns can use another agent in the same workspace.
3. **Check the running result.** Run the repository's tests and open an authenticated preview of
   its declared services. The preview uses the story workspace, including its current files and
   local data.
4. **Review and deliver through GitHub.** Agents use ordinary Git and GitHub commands to commit,
   push, and open pull requests. Required checks, reviews, and branch protection enforce your
   repository's merge policy.
5. **Keep the work available.** Merge marks the story done and suspends compute. Archive and suspend
   also retain the workspace. Only explicit workspace deletion removes its durable files and
   engine sessions.

The story timeline brings together messages, agent turns, Git changes, pull requests, reviews,
and checks. Project views expose recorded model and workspace costs, budgets, and operational
activity. MCP and the web application work with the same stories and lifecycle controls.

Two contracts live in your repository: [`.facility.yml`](apps/docs/docs/reference/project-manifest.md)
defines setup, services, and readiness; [`.agents/*.md`](apps/docs/docs/reference/agent-manifest.md)
defines agent instructions, engines, models, and triggers. The kickstart pull request creates both.

## Quick start: run Facility

To open the local application, you need Docker, Node.js 24 LTS, and the repository-pinned pnpm
11.20.0. Node.js 22 is supported from 22.13.0. To run an agent on a real repository, you also need
the workspace image, a configured GitHub App, and credentials for the selected engine. The steps
below distinguish starting the application from connecting that first repository.

### 1. Start the local application

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

## Before connecting more repositories

Every agent receives maintainer-level access to the repositories and credentials connected to its
project. Agent roles change instructions and triggers, not permissions. Configure protected
branches, required CI, and reviews so the GitHub App cannot bypass the merge policy you expect.

Self-hosting gives you control of the Facility services, database, and workspace storage. Claude
Code and Codex still communicate with the model service configured for the engine. Review those
providers and credentials alongside your own infrastructure requirements.

Project budgets are checked before new provider calls. Usage is recorded afterwards, so an
in-flight call can take spending beyond the monthly limit. Retained workspaces also need an
explicit storage and deletion policy.

The [hardening guide](apps/docs/docs/reference/hardening.md) covers isolation, credentials,
backups, and retention. The [production guide](apps/docs/docs/self-host/production.md) covers
operating the instance.

## Documentation

| You want to… | Read |
|---|---|
| Understand the operating model | [AI SDLC method](apps/docs/docs/concepts/method.md) and [story loop](apps/docs/docs/concepts/the-loop.md) |
| Install and operate an instance | [Self-hosting](apps/docs/docs/self-host/quickstart.md), [authentication](apps/docs/docs/self-host/authentication.md), and [production](apps/docs/docs/self-host/production.md) |
| Configure a repository and its agents | [Project manifest](apps/docs/docs/reference/project-manifest.md) and [agent manifest](apps/docs/docs/reference/agent-manifest.md) |
| Continue, suspend, or archive work | [Story operations](apps/docs/docs/guides/operate-story.md) and [workspace lifecycle](apps/docs/docs/reference/lifecycle.md) |
| Connect a client or build an integration | [MCP tools](apps/docs/docs/reference/mcp.md), [REST API](apps/docs/docs/reference/api.md), and [webhooks](apps/docs/docs/reference/webhooks.md) |
| Check the whole setup on a repository | [End-to-end validation](apps/docs/docs/guides/validate-workspace-loop.md) |
| Find your way around the code | [Architecture](apps/docs/docs/reference/architecture.md) and [contributor guide](apps/docs/docs/contributors/architecture.md) |

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
