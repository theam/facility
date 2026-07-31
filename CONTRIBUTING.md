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

## Releasing (maintainers)

**Merging to `main` is the release.** There is no version-bump commit, no
release branch, and no tag to push by hand: `.github/workflows/ci.yml` decides
from the commit subjects since the last release whether this merge publishes
and as what version, then verifies, publishes, and writes the tag.

The order matters, and it is the whole safety argument:

1. **Decide** — `scripts/version.mjs` reads the full non-merge commit messages
   since the last `v*` tag. Only `feat`, `fix`, `perf`, `revert`, and anything
   marked breaking count. If nothing qualifies, the run ends here and nothing
   is published.
2. **Verify** — root verification, the self-host build, and the sandbox E2E, on
   the merged commit.
3. **Package** — the decided version is stamped into both `package.json` files
   *inside the run*, the archive is built, installed the way `npx` would, and
   its binary is executed. Nothing is committed; the checkout's version number
   is not the source of truth.
4. **Publish** — npm and, once the repository is public, the images, from that
   exact archive and digest set.
5. **Record** — only now is the annotated tag written and the GitHub release
   published with the generated notes.

A run that fails before both publishers finish leaves no tag. Retry the failed
jobs in that same workflow run so they reuse the accepted artifacts and retain
the successful publisher's result. Exact npm artifacts and image digests are
idempotent on that retry; the publishers refuse the same version with different
contents. Do not use another merge as the retry. If recording fails after the
tag was pushed, rerunning that failed job verifies the tag still targets the
released commit and creates the missing GitHub Release.

Do not run `npm publish` locally or invoke the release workflow as a substitute
for those gates; its manual entry point is a dry run.

### Commit subjects decide the version

Subjects follow [Conventional Commits](https://www.conventionalcommits.org/),
and CI checks the pull request title, because a squash merge makes that title
the subject on `main`. The rules — and the two ways a careless subject hurts a
user — are in [AGENTS.md](AGENTS.md#commit-subjects-set-the-released-version).

### First npm publish only

npm cannot attach a trusted publisher until the package exists. Bootstrap
`@theagilemonkeys/facility` once with a short-lived
[granular access token](https://docs.npmjs.com/creating-and-viewing-access-tokens/):

1. Give the token read/write access only to the `@theagilemonkeys` scope, no
   organization-management access, the shortest practical expiry, and bypass
   2FA for the CI publish.
2. Create the GitHub environment named `npm`, restrict its deployment branches
   to `main`, require maintainer approval, and store the token there as the
   `NPM_BOOTSTRAP_TOKEN` environment secret.

   Do **not** add a ruleset restricting `v*` tag creation. `record-release`
   writes that tag with `GITHUB_TOKEN` after a successful publish, and a
   ruleset's bypass list accepts roles, teams, GitHub Apps and Dependabot —
   not a workflow. Restricting tag creation would leave releases published to
   npm and GHCR with no tag, so the next merge would recompute the same version
   and npm would reject it as a duplicate. The environment approval is the gate;
   the tag is a record written afterwards.
3. Before merging the release-on-merge workflow, establish the inert history
   boundary it will read. For this repository, tag the existing version:

   ```bash
   git tag -a v0.3.0 -m "0.3.0 — release-on-merge baseline"
   git push origin v0.3.0
   ```

   Tag pushes do not publish; this only prevents legacy history from entering
   the first automated decision.
4. Merge the first release-impacting pull request to `main`. The main-push
   workflow accepts this credential only while the package is absent from npm;
   it writes the release tag after npm and the images have both published.

As soon as the first version exists, configure the package's
[npm trusted publisher](https://docs.npmjs.com/trusted-publishers/) with these
exact GitHub Actions values:

- organization or user: `theam`
- repository: `facility`
- workflow filename: `ci.yml`
- environment: `npm`
- allowed action: `npm publish`

Use `ci.yml`, not `release.yml`: npm validates the caller when a reusable
workflow contains the publish command. Then delete the `NPM_BOOTSTRAP_TOKEN`
GitHub secret, revoke the granular token on npm, and set the package's
**Publishing access** to **Require two-factor authentication and disallow
tokens**. Later release-impacting merges publish through short-lived OIDC
credentials; their tags are written afterwards as records.

### One-time GitHub Pages setup

After the repository becomes public, a maintainer must select **GitHub
Actions** under **Settings → Pages → Build and deployment → Source** once.
After that, `.github/workflows/docs.yml` deploys pushes to `main` and manual
runs selected from `main`. The workflow deliberately does not use an admin
token or PAT to change the repository setting itself.
