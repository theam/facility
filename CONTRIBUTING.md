# Contributing

Facility uses the same operating rules it installs into other repositories:
one coherent change, explicit verification, and human review before merge.

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

The monorepo requires Node.js 22 or newer and pnpm 11. Docker is required for
the local platform stack and sandbox end-to-end tests.

```bash
git clone https://github.com/theam/facility.git
cd facility
corepack enable
pnpm dev
```

`pnpm dev` owns dependency installation, safe `.env` defaults, development
infrastructure, shared package builds, migrations, seed data, and every
foreground process, including the worker and documentation site. It preserves
existing `.env` values. See the
[self-host quickstart](apps/docs/docs/self-host/quickstart.md) for details.

To delegate setup to Claude Code or Codex:

> Set up and launch Facility from this repository. Run `pnpm dev`, fix
> prerequisite errors without replacing existing `.env` values, wait for the
> services to be ready, then report their local URLs.

## Make a focused change

- Use semantic branch names such as `feature/...`, `fix/...`, or `docs/...`.
- Follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
  when committing; maintainers squash and merge pull requests.
- Add or update tests for behavior changes. Never relax, skip, or delete a test,
  guard, or check to make a change pass.
- Keep the CLI and everything it vendors into user repositories free of runtime
  dependencies. A new dependency becomes part of every adopter's supply chain.
- Treat files under `packages/cli/templates/` and `packages/cli/modules/` as
  product surfaces. Comments should explain why a constraint exists, not
  narrate the code.
- Add entries to `apps/docs/docs/reference/hardening.md` only for observed failures and the
  countermeasure that worked.

## Verify the change

Run the repository acceptance command before opening a pull request:

```bash
pnpm verify
```

It runs lint and type checks, a clean cache-disabled build, critical integration
tests against isolated databases, the remaining uncached tests, repository
guards, and the high-severity dependency audit. CI separately builds the
self-host images and applies the Docker-backed sandbox E2E policy documented in
[docs/testing.md](docs/testing.md).

Useful narrower commands include:

```bash
pnpm --filter @theagilemonkeys/facility test
pnpm --filter @facility/api test
pnpm --filter @facility/gateway test
pnpm --filter @facility/docs build
pnpm --filter @facility/web build
node guards/run.mjs
```

CLI and template tests run the real installer against temporary repositories.
When generated YAML changes, ensure the affected test parses and exercises the
rendered workflow rather than checking text alone.

## Open the pull request

Describe the user-visible behavior, the files or subsystems affected, and the
verification commands you ran. Keep unrelated cleanup in a separate pull
request so the change can be reviewed and reverted independently.

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
