<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
    <img src="assets/wordmark-light.svg" alt="Facility" width="270">
  </picture>
</div>

<p align="center">
  <a href="https://github.com/theam/facility/actions/workflows/ci.yml"><img src="https://github.com/theam/facility/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-161B22" alt="Node.js 22 or newer">
  <img src="https://img.shields.io/badge/license-Apache--2.0-FFD923" alt="Apache License 2.0">
</p>

Facility is open-source, self-hosted tooling for running AI coding agents as
part of a reviewable software delivery process — with the humans, the gates
and the evidence in one place.

**Connect a repository and your repository stays yours.** Install the GitHub
App, and the work already in it appears in Facility: every issue, with its
history. From there a person dispatches agents, reads the plan they wrote,
approves or refuses it, and follows the work to a merged pull request —
without a single file being added to the repository. Agents run in Facility's
own sandboxes and write back only what a human collaborator would: branches,
pull requests, and comments. The project's context — its charter, its
decisions, its documentation — lives in the platform, not vendored into the
codebase.

That matters most where it is hardest to adopt anything: a team with a working
process can connect Facility, watch it for a week, and disconnect it without a
trace if it does not earn its place.

When a team *wants* the process in the repository — agents running in its own
CI, invoked from issue comments — Facility installs that too. It is the second
step, not the entry price.

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
  repositories who need centrally managed templates, upgrades, credentials,
  spend limits, audit history, and outcome data.
- **Security-conscious organizations** that need to keep the control plane,
  run records, and model traffic in their own environment while using scoped
  machine credentials and human approval gates.

Start by connecting one repository. Install the process into the repository
itself when the team wants agents running in its own CI.

## What you can do with it

| Goal | Facility provides | Available with |
|---|---|---|
| Take work from an issue to a pull request | `/architect` investigates and proposes a plan; a human invokes `/builder`; the builder implements and publishes a reviewable PR. Platform runs publish a draft before GitHub CI decides acceptance. | Installer or platform |
| Keep accountability with people | A person accepts the plan; at Gate 2 a person validates the live preview, reviews the PR, and squash-merges it. Agents cannot approve, merge, or push to protected branches. | Installer or platform |
| Give agents a usable job site | Each run starts with the repository's provision command, then follows `STANDARD.md`, relevant skills, specialist review, and the configured test/build commands. | Installer or platform |
| Validate behavior before merge | Facility can provision a private Docker or AWS preview from a project-defined image, wait for its readiness endpoint, and expose it only through the SSO-authenticated proxy. Existing provider previews remain supported. | Installer or platform |
| Turn team rules into enforcement | Repository-specific invariants live in zero-dependency guards. Repeated review feedback can graduate from prose into a deterministic check. | Installer or platform |
| Keep repositories on a known system version | The platform fingerprints managed files, reports drift, and delivers template upgrades as reviewable pull requests. | Platform |
| Control model access and spend | The gateway issues project-scoped virtual keys, enforces budgets, attributes usage by project/agent/task, and can store request/response envelopes in your object store. | Platform |
| Run and supervise agents outside CI | The platform launches Claude Code, Codex, or bring-your-own agents in disposable Docker or AWS CodeBuild sandboxes, streams sessions, and records human steering. | Platform |
| Reuse operational knowledge | The harness versions skills, rules, agent contracts, guards, and templates. Project knowledge and learning proposals remain human-validated. | Platform |
| See whether the process works | Receipts, outcomes, health checks, analytics, issues, and a synthetic canary show cost, reliability, acceptance, and recurring failures. | Installer or platform |
| Operate from different clients | The same permission model is exposed through the web app, REST API, CLI, and MCP server. | Platform |

## Quick start: run Facility

Running Facility locally takes one command for the stack plus a one-time GitHub
App setup for sign-in and repository automation. You need Docker, Node.js 22 or
newer, and pnpm 11 (via corepack).

### 1. Clone and boot the stack

```bash
git clone https://github.com/theam/facility.git
cd facility
corepack enable
pnpm dev
```

`pnpm dev` creates `.env` when needed, fills only blank required development
values (including `SECRET_MASTER_KEY` and the MCP signing keys), starts
Postgres plus MinIO when `S3_ENDPOINT` is local (or only Postgres for an external
S3-compatible endpoint), installs dependencies, builds shared packages, migrates and
seeds platform essentials, then launches the API (`:4400`), worker, gateway
(`:4410`), web app (`:3400`), and documentation site. Existing `.env` values
are never replaced, and the command refuses a non-local `DATABASE_URL`.

The stack is now up, but sign-in answers `501 auth_unconfigured` until you
finish the steps below.

### 2. Create the GitHub App

Facility uses one GitHub App per instance for BOTH human sign-in and
repository automation. Create it on the organization (or user account) that
owns the repositories you will automate: **Settings → Developer settings →
GitHub Apps → New GitHub App**.

- **GitHub App name / Homepage URL**: anything you like.
- **Callback URL**: `http://localhost:3400/api/auth/callback` — it must match
  `AUTH_CALLBACK_URL` in `.env` exactly, byte for byte.
- Leave **"Request user authorization (OAuth) during installation"** unchecked.
  Facility requests authorization when you sign in after configuring `.env`
  and restarting the stack.
- **Webhook**: optional for local evaluation — you can disable it and use the
  "sync from GitHub" button instead. To receive events on a development
  machine you need a public URL for your laptop; the
  [local development guide](apps/docs/docs/self-host/local-development.md)
  walks through a Cloudflare tunnel and the exact payload URL
  (`https://<your-host>/api/webhooks/github` — through the `/api` proxy).
- **Permissions**:

  | Scope | Permission | Access |
  |---|---|---|
  | Repository | Actions, Checks, Deployments, Metadata | Read-only |
  | Repository | Contents, Workflows | Read and write |
  | Repository | Issues, Pull requests | Read and write |
  | Organization | Members | Read-only |
  | **Account** | **Email addresses** | **Read-only — required for sign-in** |

  Sign-in checks every verified email on your GitHub account against explicit
  Facility invitations, so a company address may remain secondary on GitHub.
  Without the Email addresses permission every login fails with a generic
  `auth_failed` error.
- **Subscribe to events** (only if the webhook is enabled): Installation,
  Push, Issues, Issue comment, Pull request, Pull request review, Workflow
  run, Check run, Deployment status.

### 3. Collect the App credentials

From the App's **General** tab:

1. Note the **App ID** and the **Client ID**.
2. **Client secrets → Generate a new client secret** — copy it immediately,
   GitHub shows it once.
3. **Private keys → Generate a private key** — a `.pem` file downloads.
4. **Install App** (left sidebar) on your organization/account, selecting the
   repositories Facility may automate. Note the **installation id** — it is
   the number at the end of the installation page URL
   (`…/settings/installations/<id>`).

### 4. Configure `.env`

Fill these values (everything else was auto-filled by `pnpm dev`):

```dotenv
# Human sign-in (the App acts as the OAuth provider)
AUTH_IDENTITY_PROVIDER=github
AUTH_CALLBACK_URL=http://localhost:3400/api/auth/callback
GITHUB_OAUTH_CLIENT_ID=<Client ID from step 3>
GITHUB_OAUTH_CLIENT_SECRET=<client secret from step 3>
# Optional: require active membership in this GitHub organization
GITHUB_OAUTH_ALLOWED_ORGANIZATION=<organization login>

# Repository automation (the same App)
GITHUB_APP_ID=<App ID from step 3>
GITHUB_APP_SLUG=<the app slug from its URL>
GITHUB_APP_PRIVATE_KEY="<contents of the .pem, kept as a quoted multiline value>"
GITHUB_APP_WEBHOOK_SECRET=<only if you enabled the webhook>

# Model provider for local development (or store credentials via the API later)
DEV_ANTHROPIC_API_KEY=<your key>
```

Set `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` together — the
configuration refuses one without the other.

`GITHUB_OAUTH_ALLOWED_ORGANIZATION` is optional. When set, Facility verifies
active membership in that organization during every direct GitHub login. When
blank or unset, the existing explicit invitation and App-installation access
checks apply without an additional organization restriction.

### 5. Bind the instance and provision yourself

Every instance is dedicated to one Facility organization, one GitHub account,
and one App installation, and sign-in only admits explicitly provisioned
members. Bootstrap that binding once:

```bash
# Find your ids:
#   your user id:          gh api /user --jq .id
#   the account id:        gh api /orgs/<org> --jq .id   (or /users/<login> for a personal account)
#   the installation id:   from step 3.4

pnpm exec facility instance bootstrap \
  --org-name "My Org" --org-slug my-org \
  --owner-email you@example.com --owner-name "Your Name" \
  --github-user-id <your user id> --github-login <your login> \
  --github-account-id <account id> --github-account-login <org-or-user login> \
  --github-installation-id <installation id> \
  --github-account-type organization
```

The command connects to the local database, is idempotent for the same
binding, and refuses to modify a database bound to a different instance.

### 6. Sign in

Restart `pnpm dev` (configuration is read at boot), open
`http://localhost:3400`, and press **continue with GitHub**. GitHub asks you
to authorize the App once; you land back in Facility with a session.

To run agents in local Docker sandboxes, also build the runner image named in
`.env`:

```bash
docker build -f runner/Dockerfile -t facility-runner:dev .
```

To delegate all of this to Claude Code or Codex, paste this prompt:

> Set up and launch Facility from this repository. Run `pnpm dev`, fix
> prerequisite errors without replacing existing `.env` values, wait for the
> services to be ready, then report their local URLs.

### Troubleshooting sign-in

| Symptom | Cause and fix |
|---|---|
| `501 auth_unconfigured` on `/api/auth/login` | `GITHUB_OAUTH_CLIENT_ID`/`SECRET` missing — set both and restart. |
| GitHub shows a `redirect_uri` mismatch page | The App's Callback URL and `AUTH_CALLBACK_URL` differ — they must match exactly. |
| `auth_failed: GitHub identity or installation access could not be verified` | The App lacks the **Email addresses: Read-only** account permission, or no verified GitHub email is available. Fix the permission and re-authorize. |
| `403 not_invited` / `installation_access_required` | Your GitHub user is not provisioned, or the user/account/installation ids in the bootstrap don't match — re-run step 5 with the real ids. |
| Login succeeds but you land on the wrong host | `WEB_URL` must be the origin your browser uses. |
| Testing through an HTTPS tunnel: navigation, live updates or hot reload fail | Set `WEB_URL` and `AUTH_CALLBACK_URL` to the tunnel origin (and the App's Callback URL to match), and put the tunnel hostname in `FACILITY_DEV_ORIGINS` — Next blocks cross-origin development requests otherwise. Full walkthrough: [local development](apps/docs/docs/self-host/local-development.md). |

## Connect your first repository

Create a project and connect a repository from the web application. The issues
already in it appear in Facility with their history, and you can dispatch an
agent against any of them from there. Nothing is written to the repository by
connecting it: agents work in Facility's sandboxes and push branches, pull
requests and comments the way a collaborator would. Disconnecting leaves no
trace either.

That is the whole entry path. If the repository already runs Facility's
vendored workflows, follow the
[existing-repository adoption guide](apps/docs/docs/guides/existing-repo.md).
For the rest of the platform, follow the
[self-host quickstart](apps/docs/docs/self-host/quickstart.md),
[authentication guide](apps/docs/docs/self-host/authentication.md), and
[production deployment guide](apps/docs/docs/self-host/production.md).

## Operate without the web application

Every control-plane workflow is available over the versioned REST API and the
zero-dependency CLI; AI clients use the same permissions through MCP.

```bash
# REST/OpenAPI
open http://localhost:4400/docs

# CLI from this checkout (the API key is hidden when entered interactively)
node packages/cli/bin/facility.mjs login --url http://localhost:4400 --key fak_…
node packages/cli/bin/facility.mjs status
node packages/cli/bin/facility.mjs --help

# MCP streamable HTTP (Bearer credentials are forwarded to the API)
curl http://localhost:4420/healthz
```

See the [API reference](apps/docs/docs/reference/api.md) and
[webhooks reference](apps/docs/docs/reference/webhooks.md) for
authentication, automation-safe output, streaming, write approvals, deployment,
and troubleshooting.

## Optional: install the process into the repository

Everything above happens without touching the repository. When a team decides it
wants the process *in* the repository — agents running in its own CI, invoked
from issue comments — the standalone installer writes it there. This is the
second step, not the entry price, and it is the only step that adds files.

The installer needs a GitHub repository and Node.js 20 or newer; its runtime
floor is lower than the platform's, and it does not require you to deploy
Facility at all.

```bash
git clone https://github.com/theam/facility.git /absolute/path/to/facility
cd your-repository
node /absolute/path/to/facility/packages/cli/bin/facility.mjs init
node /absolute/path/to/facility/packages/cli/bin/facility.mjs doctor --run-guards --github
```

Until the CLI is published to npm, run it from a Facility checkout as above.

The installer detects the repository's package manager, default branch, checks,
and useful quality modules. It asks for the commands that create a working
environment and verify a change, then adds:

- GitHub workflows for planning, building, reviewing, addressing feedback,
  repairing routine CI failures, security sweeps, and the watchtower;
- `STANDARD.md`, agent instructions, skills, hooks, and deterministic guards;
- `.facility.json`, which records the choices needed to reproduce the install.

The installer skips existing generated destinations unless you explicitly use
`--force`. `AGENTS.md` and `CLAUDE.md` receive a delimited managed block instead
of being replaced, and the current answers are written to `.facility.json`.

For a Facility-owned preview, supply an immutable review image, its start
command, internal port, and readiness path. The image command may seed
non-production data before it starts the server. The workflow requests the
preview only after verified builder delivery:

```bash
node /absolute/path/to/facility/packages/cli/bin/facility.mjs init \
  --preview-image='ghcr.io/acme/app:${{ steps.delivery.outputs.head_sha }}' \
  --preview-command='npm run preview' \
  --preview-port=3000 \
  --preview-readiness-path=/healthz \
  --preview-ttl-hours=24
```

Configure `FACILITY_API_URL`, `FACILITY_PROJECT_ID`, and a project-scoped
`FACILITY_PREVIEW_KEY` in GitHub. Production Facility deployments must have a
complete GitHub/OIDC login configuration or preview creation fails closed. The review
image must already exist; Facility does not build application images.

After installation, follow the human-only steps printed by the CLI: configure
the [selected authentication mode](#repository-automation-authentication),
install the Claude GitHub App, protect the default branch, and use test-tier
spend-capped credentials for integration tests. Choose Facility-owned or
existing-provider previews and require their readiness check. Then commit the generated files, open
an issue, and comment `/architect` to start the delivery loop described below.

See the [CLI reference](apps/docs/docs/reference/cli.md) and
[guards guide](apps/docs/docs/reference/guards.md) for the available commands and extension points.

## Repository automation authentication

`facility init --auth=<mode>` renders one authentication mode consistently into
every generated workflow and records it in `.facility.json`. The default is
`api-key`; enterprises should prefer short-lived WIF or cloud OIDC when their
provider setup supports it.

| Mode | GitHub configuration | Intended use |
|---|---|---|
| `wif` | `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID` variables | Preferred direct-Anthropic enterprise path; short-lived GitHub OIDC exchange |
| `bedrock` | `AWS_ROLE_TO_ASSUME` secret, `AWS_REGION` variable | Amazon Bedrock through an AWS GitHub OIDC role |
| `vertex` | `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT` variables | Vertex AI through Google Workload Identity Federation |
| `api-key` | `ANTHROPIC_API_KEY` secret | Simple default; use a dedicated, spend-capped test-tier key |
| `oauth` | `CLAUDE_CODE_OAUTH_TOKEN` secret | Compatibility path for a Claude subscription token |

`facility doctor` reads the manifest and workflows, checks the selected mode,
and reports the three configured model tiers. Do not configure multiple modes
in the same workflow; static credentials take precedence over WIF and defeat
its purpose. For `bedrock` and `vertex`, pass provider-compatible model
identifiers through the three `--*-model` flags instead of relying on the
direct-Anthropic defaults.

## How the delivery loop works

Whichever setup you choose, work follows the same reviewed path:

1. Work starts as an issue or another owned signal.
2. `/architect` inspects the real repository and proposes a plan in the issue.
3. A human accepts that plan by invoking `/builder`.
4. `/builder` provisions the environment and implements the complete change.
   Repo-lane builders run the configured checks before opening a PR. A
   platform-lane builder runs focused checks and Facility immediately publishes
   its signed commit as a draft PR.
5. Facility or the configured deployment provider creates a live, isolated preview for fast validation.
6. Automated review, deterministic guards, and the repository's CI examine the
   result. GitHub CI is authoritative for platform-lane delivery; failed checks
   can dispatch the configured CI-doctor on the same branch, and Facility marks
   the draft ready only after the current head's aggregate rollup succeeds.
7. At Gate 2, a human validates the preview, reviews the PR, and squash-merges it.
8. The run leaves a receipt; the watchtower joins it with the eventual outcome
   and reports health over time.

Facility supports two execution lanes. The **repo lane** runs the vendored
GitHub workflows in your existing CI and has no platform dependency at run
time. The **platform lane** runs the same contracts in an isolated sandbox and
adds live streaming, steering, centralized credentials, and platform-enforced
budgets. A project can move one trigger at a time between lanes.

Platform-lane Anthropic credentials support both API-key billing and Claude
Code Pro/Max subscription tokens. Add the latter in Settings → Providers or
with `facility providers create --provider anthropic --auth-mode oauth ...`;
the setup token remains sealed behind the gateway and the sandbox receives only
its expiring run-scoped virtual key.

Platform CI repair is limited to branches produced by that project's Facility
builder runs. It retries the same SHA-stable failure at most twice and retains
an absolute three-attempt branch ceiling by default; set the project setting
`ci_repair_max_attempts` to an integer from 1 through 10 to change that branch
ceiling. Exhaustion leaves the draft PR and its failing checks intact for human
iteration.

Read [the method](apps/docs/docs/concepts/method.md) for the reasoning behind the roles, gates,
standards, guards, and watchtower.

## Getting the most from Facility

1. **Make provisioning real.** The provision command should create everything
   the checks need on a fresh machine: databases, migrations, seeds, browsers,
   generated clients, and local services. If an agent cannot reproduce a
   failure, it cannot reliably fix it.
2. **Define completion in executable terms.** Put the exact lint, typecheck,
   test, build, and guard commands in `STANDARD.md` and `.facility.json`. Keep
   judgment calls in the standard; turn stable invariants into guards.
3. **Protect the default branch.** Require pull requests and a human review.
   Facility's prompts and hooks reinforce this boundary, but branch protection
   makes it structural.
4. **Use least-privilege test credentials.** Give agent jobs only test-tier,
   spend-capped secrets. Use gateway virtual keys and project budgets when the
   platform is available; never expose production credentials to a run.
5. **Adopt the platform incrementally.** For an existing Facility repository,
   connect and fingerprint it first, route model traffic through the gateway
   second, add telemetry third, and move individual triggers to sandboxes only
   when the team is ready.
6. **Review the numbers, not just individual PRs.** Watch acceptance rate,
   one-shot delivery, human fixups, cost, failed runs, and canary health. Use
   recurring failures to improve the standard, provision command, skills, or
   guards.
7. **Set an object-store retention policy.** Envelope and transcript capture is
   useful for audit and diagnosis, but the current platform relies on your S3
   lifecycle policy for deletion.

The [existing-repository guide](apps/docs/docs/guides/existing-repo.md),
[security model](apps/docs/docs/reference/security.md), and
[hardening notes](apps/docs/docs/reference/hardening.md) cover these practices in more detail.

## Current status

Facility v0.3 is a pre-1.0 release. The repository installer and delivery method
precede the platform; the control plane is newer and its APIs and file layout may
still change.

The web app currently covers projects, agents, sessions and live steering,
issues, Project Owner knowledge, the human inbox, harness items, analytics,
audit, integrations, providers, API keys, budgets, and members. The REST API is
the complete platform surface, with focused subsets exposed through the CLI and
MCP. Production deployments use GitHub directly or the SaaS OIDC broker for human login and a separately
configured GitHub App for repository automation.

The [architecture document](apps/docs/docs/reference/architecture.md) describes the
platform topology, security boundaries, and major design decisions.

Once this repository is public, a maintainer must enable GitHub Pages with
**GitHub Actions** as its source. After that one-time setting, the docs workflow
deploys pushes to `main` (or a manual run from `main`); it does not require an
admin token or PAT.

## Repository map

```text
apps/web            Next.js operator interface
apps/docs           Docusaurus documentation
services/api        REST control plane, workers, GitHub integration, HITL
services/gateway    model proxy, budgets, metering, envelope capture
packages/cli        @theagilemonkeys/facility installer and platform client
packages/core       domain logic, permissions, receipts, fingerprints
packages/db         Postgres schema and migrations
packages/mcp        MCP server
packages/harness    Project Owner and learning-agent contracts
packages/sdk        generated TypeScript API client
packages/ui         shared React design system
runner              sandbox agent host
infra               Docker and AWS deployment assets
```

The full topology and design decisions are in the
[architecture document](apps/docs/docs/reference/architecture.md).

## Contributing

Bug reports, documentation improvements, and focused feature proposals are
welcome. Before implementing a substantial change, open an
[issue](https://github.com/theam/facility/issues) so its behavior and boundaries
can be agreed on.

```bash
git clone https://github.com/theam/facility.git
cd facility
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` is the release-shaped local acceptance command: lint, typecheck,
output cleanup followed by a cache-disabled build, uncached critical integration
tests against isolated databases, the remaining uncached tests, guards, and the
all-severity dependency gate. A clean `docker compose build` is a separate
required CI job.

The Docker-backed sandbox E2E is a separate acceptance tier. Its required versus
allowed-skip policy and local command are defined in
[docs/testing.md](docs/testing.md).

Use a semantic branch name such as `docs/readme` or `fix/gateway-metering`, keep
the change to one coherent intent, add tests for behavior changes, and include
the commands you ran in the pull request. Do not weaken an existing test, guard,
or check to make a change pass. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
repository-specific rules and test commands. Report vulnerabilities through
[SECURITY.md](SECURITY.md), not a public issue.

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 The Agile
Monkeys.

---

<p align="center">
  <img src="assets/mark.svg" alt="" width="28"><br>
  <sub>An initiative by <a href="https://theagilemonkeys.com">The Agile Monkeys</a></sub>
</p>
