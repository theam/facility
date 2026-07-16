# Contributing

Facility uses the same operating rules it installs into other repositories:
one coherent change, explicit verification, and human review before merge.

## Before you start

- Search the [issue tracker](https://github.com/theam/facility/issues) before
  reporting a bug or proposing a feature.
- Open an issue before implementing a substantial or behavior-changing feature
  so its contract can be agreed on first.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

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
- Add entries to `docs/hardening.md` only for observed failures and the
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
pnpm --filter @theam/facility test
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

## Releasing (maintainers)

1. Bump the version in `package.json` and `packages/cli/package.json` according
   to semver (before 1.0, a minor release may contain breaking changes).
2. Run `pnpm verify` and the build for every publishable artifact.
3. Publish `@theam/facility` with public access.
4. Tag `vX.Y.Z` and write release notes in terms of behavior, not commit titles.
