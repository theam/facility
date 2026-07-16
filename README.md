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
part of a reviewable software delivery process. It installs the process into a
GitHub repository and, when a team needs shared operations, provides a control
plane for projects, credentials, budgets, sandboxes, approvals, knowledge, and
run data.

You can use the repository installer by itself. The platform is optional.

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

For one repository, start with the installer. Add the platform when you need
shared governance or platform-hosted agent runs.

## What you can do with it

| Goal | Facility provides | Available with |
|---|---|---|
| Take work from an issue to a pull request | `/architect` investigates and proposes a plan; a human invokes `/builder`; the builder implements, runs the repository's checks, pushes a branch, and opens a PR. | Installer or platform |
| Keep accountability with people | A person accepts the plan; at Gate 2 a person validates the live preview, reviews the PR, and squash-merges it. Agents cannot approve, merge, or push to protected branches. | Installer or platform |
| Give agents a usable job site | Each run starts with the repository's provision command, then follows `STANDARD.md`, relevant skills, specialist review, and the configured test/build commands. | Installer or platform |
| Validate behavior before merge | Every implementation PR must expose a provider-managed live preview today; native provider-agnostic preview orchestration is on the [roadmap](apps/docs/docs/roadmap.md). | Installer or platform |
| Turn team rules into enforcement | Repository-specific invariants live in zero-dependency guards. Repeated review feedback can graduate from prose into a deterministic check. | Installer or platform |
| Keep repositories on a known system version | The platform fingerprints managed files, reports drift, and delivers template upgrades as reviewable pull requests. | Platform |
| Control model access and spend | The gateway issues project-scoped virtual keys, enforces budgets, attributes usage by project/agent/task, and can store request/response envelopes in your object store. | Platform |
| Run and supervise agents outside CI | The platform launches Claude Code, Codex, or bring-your-own agents in disposable Docker or AWS Fargate sandboxes, streams sessions, and records human steering. | Platform |
| Reuse operational knowledge | The harness versions skills, rules, agent contracts, guards, and templates. Project knowledge and learning proposals remain human-validated. | Platform |
| See whether the process works | Receipts, outcomes, health checks, analytics, issues, and a synthetic canary show cost, reliability, acceptance, and recurring failures. | Installer or platform |
| Operate from different clients | The same permission model is exposed through the web app, REST API, CLI, and MCP server. | Platform |

## Quick start: one repository

The standalone installer needs a GitHub repository and Node.js 20 or newer; its
runtime floor is lower than the platform's. It does not require you to deploy
the Facility platform.

```bash
cd your-repository
npx @theam/facility init
npx @theam/facility doctor
```

The installer detects the repository's package manager, default branch, checks,
and useful quality modules. It asks for the commands that create a working
environment and verify a change, then adds:

- GitHub workflows for planning, building, reviewing, addressing feedback,
  repairing routine CI failures, security sweeps, and the watchtower;
- `STANDARD.md`, agent instructions, skills, hooks, and deterministic guards;
- `.facility.json`, which records the choices needed to reproduce the install.

### Operate without the web application

Every control-plane workflow is available over the versioned REST API and the
zero-dependency CLI; AI clients use the same permissions through MCP.

```bash
# REST/OpenAPI
open http://localhost:4400/docs

# CLI (the API key is hidden when entered interactively)
facility login --url http://localhost:4400 --key fak_…
facility status
facility --help

# MCP streamable HTTP (Bearer credentials are forwarded to the API)
curl http://localhost:4420/healthz
```

See the [CLI, API, SDK, and MCP operator guide](docs/platform/INTERFACES.md) for
authentication, automation-safe output, streaming, write approvals, deployment,
and troubleshooting.

The installer skips existing generated destinations unless you explicitly use
`--force`. `AGENTS.md` and `CLAUDE.md` receive a delimited managed block instead
of being replaced, and the current answers are written to `.facility.json`.

After installation, follow the human-only steps printed by the CLI: configure
the [selected authentication mode](#repository-automation-authentication),
install the Claude GitHub App, protect the default branch, and use test-tier
spend-capped credentials for integration tests. Connect a deployment provider
and require its per-PR live preview check. Then commit the generated files, open
an issue, and comment `/architect` to start the delivery loop described below.

See the [CLI reference](apps/docs/docs/reference/cli.md) and
[guards guide](docs/guards.md) for the available commands and extension points.

## Quick start: self-host the platform

For local evaluation, you need Docker, Node.js 22 or newer, and pnpm 11.
One command prepares the repository and runs the complete development stack:

```bash
git clone https://github.com/theam/facility.git
cd facility
corepack enable
pnpm dev
```

`pnpm dev` creates `.env` when needed, fills only blank required development
values, starts Postgres and MinIO, installs dependencies, builds shared
packages, migrates and seeds the database, then launches the API, worker,
gateway, web app, and documentation site. Existing `.env` values are never
replaced. Because the command seeds development data, it refuses a non-local
`DATABASE_URL`.

Open `http://localhost:3400` and use the development sign-in. Ctrl-C stops the
foreground development processes; the Docker infrastructure remains available
for the next `pnpm dev`.

To delegate setup to Claude Code or Codex, paste this prompt:

> Set up and launch Facility from this repository. Run `pnpm dev`, fix
> prerequisite errors without replacing existing `.env` values, wait for the
> services to be ready, then report their local URLs.

To run agents in local Docker sandboxes, also build the runner image named in
`.env`:

```bash
docker build -t facility-runner:dev runner/
```

Your first real setup steps are to add model-provider credentials, configure a
GitHub App, create a project, connect a repository, preview the generated files,
and let Facility open the kickstart PR. Follow the
[self-host quickstart](apps/docs/docs/self-host/quickstart.md),
[production deployment guide](apps/docs/docs/self-host/production.md), and
[kickstart guide](apps/docs/docs/guides/kickstart.md).

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
4. `/builder` provisions the environment, implements the complete change, runs
   the configured checks, and opens a pull request.
5. The deployment provider creates a live, isolated preview for fast validation.
6. Automated review, deterministic guards, and the repository's CI examine the
   result.
7. At Gate 2, a human validates the preview, reviews the PR, and squash-merges it.
8. The run leaves a receipt; the watchtower joins it with the eventual outcome
   and reports health over time.

Facility supports two execution lanes. The **repo lane** runs the vendored
GitHub workflows in your existing CI and has no platform dependency at run
time. The **platform lane** runs the same contracts in an isolated sandbox and
adds live streaming, steering, centralized credentials, and platform-enforced
budgets. A project can move one trigger at a time between lanes.

Read [the method](docs/method.md) for the reasoning behind the roles, gates,
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
[hardening notes](docs/hardening.md) cover these practices in more detail.

## Current status

Facility v0.3 is a private preview. The repository installer and delivery method
precede the platform; the control plane is newer and its APIs and file layout may
still change.

The web app currently covers projects, agents, sessions and live steering,
issues, Project Owner knowledge, the human inbox, harness items, analytics,
audit, integrations, providers, API keys, budgets, and members. The REST API is
the complete platform surface, with focused subsets exposed through the CLI and
MCP. Production deployments require WorkOS for human SSO and a separately
configured GitHub App for repository automation.

For the detailed implementation inventory, limitations, and verification
record, read [the platform status](docs/platform/STATUS.md).

## Repository map

```text
apps/web            Next.js operator interface
apps/docs           Docusaurus documentation
services/api        REST control plane, workers, GitHub integration, HITL
services/gateway    model proxy, budgets, metering, envelope capture
packages/cli        @theam/facility installer and platform client
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
[architecture document](docs/platform/ARCHITECTURE.md).

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
high-severity dependency gate. A clean `docker compose build` is a separate
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
