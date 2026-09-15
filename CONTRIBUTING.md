# Contributing

Facility uses the same operating rules it applies to other repositories: one
coherent change, explicit verification, and human review before merge.

## Before you start

- Search the [issue tracker](https://github.com/theam/facility/issues) before
  reporting a bug or proposing a feature.
- Open an issue before implementing a substantial or behavior-changing feature
  so its contract can be agreed on first.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- Be decent to each other — see the [code of conduct](CODE_OF_CONDUCT.md).

## What belongs in this tracker

This repository is public: issues, pull requests, comments and CI logs are all
visible. Keep the tracker to **product-technical work** — a bug, a capability,
a design question about how Facility behaves — written so that a contributor
who has never met the maintainers can act on it.

Deployment plans, customer or pilot names, deadlines, private infrastructure
and commercial strategy do not belong here, even when they motivate the work.
When private context drives a public change, the public issue states the
technical problem on its own terms and the private tracker links to it.

## Set up the repository

The monorepo recommends Node.js 24 LTS and uses pnpm 11.20.0. Node.js 22 is
also supported from 22.13.0. Docker is required for the local platform stack
and workspace end-to-end tests. For nvm users, the repository's `.nvmrc` selects
the recommended Node.js 24 line with `nvm use`.

```bash
git clone https://github.com/theam/facility.git
cd facility
corepack install --global pnpm@11.20.0
pnpm dev
```

`pnpm dev` owns dependency installation, safe `.env` defaults, development
infrastructure, shared package builds, migrations, seed data, and every
foreground process, including the worker and documentation site. It preserves
existing `.env` values. See the
[self-host quickstart](apps/docs/docs/self-host/quickstart.md) for details.

The local UI is at `http://localhost:3400`, the API and MCP endpoint are at
`http://localhost:4400`, and PostgreSQL listens on port 5461. Build the runner
image before testing real Docker-backed story workspaces:

```bash
docker build -f runner/Dockerfile -t facility-runner:dev .
```

To delegate setup to Claude Code or Codex:

> Set up and launch Facility from this repository. Run `pnpm dev`, fix
> prerequisite errors without replacing existing `.env` values, wait for the
> services to be ready, then report their local URLs.

## Find the owning code

The [contributor architecture](apps/docs/docs/contributors/architecture.md)
describes request flow and cross-package invariants. The short package map is:

| Path | Responsibility |
| --- | --- |
| `apps/web` | Next.js user interface. |
| `apps/docs` | Published Docusaurus documentation. |
| `services/api` | API, MCP transport, OAuth, webhooks, previews, worker, and workspace runtimes. |
| `packages/agents` | Strict agent manifest and trigger contract. |
| `packages/db` | Schema, migrations, seed, and database test support. |
| `packages/mcp` | MCP tools and schemas. |
| `packages/cli` | Published init, doctor, templates, and instance bootstrap. |
| `packages/core`, `packages/sdk`, `packages/ui` | Shared primitives, client surface, and UI components. |
| `runner` | Complete agent workspace image and runtime helpers. |
| `infra/terraform/aws` | AWS control-plane reference deployment. |
| `guards`, `scripts` | Repository invariants, development, verification, migration, and release automation. |

Keep policy in one owning boundary. Routes validate and present, domain services
enforce behavior, provider interfaces isolate external runtimes, and database
queries enforce organization/project scope. Avoid adding another service when
the behavior belongs in the existing API, worker, or database.

## Make a focused change

- Use semantic branch names such as `feature/...`, `fix/...`, or `docs/...`.
- Follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
  when committing; maintainers squash and merge pull requests.
- Add or update tests for behavior changes. Never relax, skip, or delete a test,
  guard, or check to make a change pass.
- Keep the repository contract small. The CLI may write only `.facility.yml`
  and `.agents/*.md` during kickstart.
- Treat files under `packages/cli/templates/agents/` and the shared agent
  parser as product surfaces. Comments should explain why a constraint exists,
  not narrate the code.
- Security-sensitive changes need unit and integration coverage for both the
  allowed and denied paths.
- Money-sensitive changes to usage, costs, or budgets have the same unit and
  integration requirement. Missing provider pricing must remain unavailable,
  not become an invented zero.
- Treat cost analysis, budgeting, observability, analytics, audit, and the
  GitHub issue/PR/CI mirror as product behavior with regression coverage.
- Preserve one shared service path for MCP and UI. A new UI action and its MCP
  counterpart should not create separate lifecycle rules.

### Database changes

Add a new migration and update schema, queries, fixtures, and integration tests
together. Committed migrations are immutable; never edit an existing one to
make a fresh database pass. Run `pnpm migrations:check` while iterating.

Tests may create only the allowlisted disposable databases used by repository
scripts. Never point a destructive test or migration experiment at a database
containing useful data.

### Agent and workspace contract changes

An agent schema change normally affects `packages/agents`, CLI templates,
catalog loading, API/MCP/UI presentation, documentation, and parser tests. A
workspace manifest or lifecycle change normally affects project environment
preparation, provider adapters, CLI init/doctor, user surfaces, reference docs,
and Docker-backed E2E coverage.

Protect the core retention invariant: suspend, archive, merge, and compute
replacement keep the conversation, worktree, and native engine session.
Permanent deletion remains a separate confirmed action.

### Documentation changes

Update the relevant concept, guide, reference, self-hosting, or contributor page in the same pull
request. Cover prerequisites, the successful flow, failure and denial paths, persistence,
destructive actions, security, operations, and verification where they apply.

Add published pages to `apps/docs/sidebars.ts`. Keep public examples free of
private deployment details or confidential context. Follow the
[documentation guide](apps/docs/docs/contributors/documentation.md).

## Verify the change

Run the repository acceptance command before opening a pull request:

```bash
pnpm verify
```

It runs lint and type checks, a clean cache-disabled build, critical integration
tests against isolated databases, the remaining uncached tests, repository
guards, and the high-severity dependency audit. CI separately builds the
self-host images and applies the Docker-backed workspace E2E policy documented in
[docs/testing.md](docs/testing.md).

Useful narrower commands include:

```bash
pnpm --filter @theagilemonkeys/facility test
pnpm --filter @facility/api test
pnpm --filter @facility/mcp test
pnpm --filter @facility/docs build
pnpm --filter @facility/web build
node guards/run.mjs
```

For workspace execution boundaries, run the Docker-backed tier described in
[docs/testing.md](docs/testing.md). For UI work, exercise the flow in a browser
against the source stack. For docs, run both:

```bash
pnpm --filter @facility/docs test
pnpm --filter @facility/docs build
```

Report exact command results. A test you did not run is not passing evidence.
Passing checks also do not replace review of whether the requested behavior
works end to end.

CLI and template tests run the real installer against temporary repositories.
When generated YAML changes, ensure the affected test parses and exercises the
rendered workflow rather than checking text alone.

## Open the pull request

Describe the user-visible behavior, the files or subsystems affected, and the
verification commands you ran. Keep unrelated cleanup in a separate pull
request so the change can be reviewed and reverted independently.

The pull request should also state:

- any persistence, migration, or compatibility effect;
- security and permission implications;
- cost, budget, observability, analytics, or mirror effects;
- manual browser or provider validation performed;
- known risks and genuine follow-up work; and
- whether the change is user-visible or breaking for release classification.

Do not include customer names, private repositories, internal planning,
deployment credentials, or confidential motivation in public issues, pull
requests, comments, logs, fixtures, screenshots, or documentation.

## Releasing

**Merging to `main` is the release.** There is no version-bump commit, no
release branch, and no tag to push by hand: `.github/workflows/ci.yml` decides
from the commit subjects since the last release whether this merge publishes
and as what version, then verifies, publishes, and writes the tag.

That puts one obligation on a contributor, and it is the section below. The
maintainer's side — the ordering behind those gates, how to recover a failed
release, and the setup steps that run once — is in
[docs/releasing.md](docs/releasing.md).

### Commit subjects decide the version

Subjects follow [Conventional Commits](https://www.conventionalcommits.org/),
and CI checks the pull request title, because a squash merge makes that title
the subject on `main`. The rules — and the two ways a careless subject hurts a
user — are in [AGENTS.md](AGENTS.md#commit-subjects-set-the-released-version).
