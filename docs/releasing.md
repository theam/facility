# Releasing Facility

**Merging to `main` is the release.** There is no version-bump commit, no
release branch, and no tag to push by hand: `.github/workflows/ci.yml` decides
from the commit subjects since the last release whether this merge publishes
and as what version, then verifies, publishes, and writes the tag.

What that asks of a contributor — an honest commit subject — is in
[CONTRIBUTING.md](../CONTRIBUTING.md#releasing). Everything below is the
maintainer's side: the ordering that makes a release safe, how to recover a
failed one, and the setup steps that run once and never again.

## The release run

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

## Recovering a failed run

A run that fails before both publishers finish leaves no tag. Retry the failed
jobs in that same workflow run so they reuse the accepted artifacts and retain
the successful publisher's result. Exact npm artifacts and image digests are
idempotent on that retry; the publishers refuse the same version with different
contents. Do not use another merge as the retry. If recording fails after the
tag was pushed, rerunning that failed job verifies the tag still targets the
released commit and creates the missing GitHub Release.

Do not run `npm publish` locally or invoke the release workflow as a substitute
for those gates; its manual entry point is a dry run.

## First npm publish only

npm cannot attach a trusted publisher until the package exists. Bootstrap
`@theagilemonkeys/facility` once with a short-lived
[granular access token](https://docs.npmjs.com/creating-and-viewing-access-tokens/):

1. Give the token read/write access only to the `@theagilemonkeys` scope, no
   organization-management access, the shortest practical expiry, and bypass
   2FA for the CI publish.
2. Create the GitHub environment named `npm`, restrict its deployment branches
   to `main`, require maintainer approval, and store the token there as the
   `NPM_BOOTSTRAP_TOKEN` environment secret.

   Do **not** add a ruleset restricting `v*` tag creation while
   `record-release` pushes that tag with `GITHUB_TOKEN` after a successful
   publish. A ruleset's bypass list accepts roles, teams, GitHub Apps and
   Dependabot; Actions' own token is none of those, so the push is rejected and
   the release stays on npm and GHCR with no tag recording it. The next merge
   then recomputes the same version and npm rejects it as a duplicate. The
   environment approval is the gate; the tag is a record written afterwards.

   The trade-off this accepts: anyone with write access can create a `v*` tag,
   and `scripts/version.mjs` reads the highest one as the release baseline, so
   a stray tag can skip a version or wedge a release after it has published.
   Closing that means `record-release` authenticating as a GitHub App the
   ruleset lists as a bypass actor — a change to the workflow, not a
   setting to switch on.
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

## One-time GitHub Pages setup

After the repository becomes public, a maintainer must select **GitHub
Actions** under **Settings → Pages → Build and deployment → Source** once.
After that, `.github/workflows/docs.yml` deploys pushes to `main` and manual
runs selected from `main`. The workflow deliberately does not use an admin
token or PAT to change the repository setting itself.
