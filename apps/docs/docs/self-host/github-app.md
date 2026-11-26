---
title: GitHub App
---

# GitHub App

Facility uses a GitHub App for repository discovery, clone and push credentials, kickstart pull
requests, delivery mirroring, and webhook-driven agents. Browser login uses a GitHub OAuth App or
OIDC configuration separately; do not confuse its client secret with the GitHub App private key.

## Create the App

Create a default GitHub App for the Facility instance and install it only on repositories the instance
may automate. Additional private Apps can be registered in organization settings, so repositories in
different GitHub organizations do not require making the default App public. Grant read/write access to Contents, Issues, Pull requests, Workflows, Actions,
Checks, and Deployments; grant read access to Metadata and organization membership. Add account
email access if GitHub OAuth is also used for sign-in.

Use the Facility web URL as the homepage and `<PUBLIC_URL>/webhooks/github` as the webhook URL. Keep
webhook delivery active. Repository selection at installation time should include only repositories
that Facility may automate with maintainer-level capabilities.

## Repository permissions

The complete repository permission set is:

| Permission | Access |
| --- | --- |
| Actions | Read and write |
| Checks | Read and write |
| Contents | Read and write |
| Deployments | Read and write |
| Issues | Read and write |
| Pull requests | Read and write |
| Workflows | Read and write |
| Code scanning alerts | Read-only |
| Dependabot alerts | Read-only |
| Secret scanning alerts | Read-only |
| Metadata | Read-only |

Commit statuses read is optional. Without it, reconciliation still completes and check run
failures are reported, and the mirror does not report success for that head.

Organization membership read access may be required for organization-restricted identity and
repository discovery. If browser sign-in needs private email discovery, configure the corresponding
OAuth scope on the identity application; it is not a repository permission in the table.

Do not create different GitHub Apps or permission profiles for different agents. If an installation
cannot expose one of the alert APIs, Facility records a scanner as unavailable rather than clean.

Facility intentionally requests one consistent installation capability for all agents. The one
exception is the Reviewer's turn in the
[automatic delivery review](../concepts/agents-as-code.md#automatic-delivery-review): its token
keeps only the read permissions the installation grants (contents, pull requests, issues, checks,
commit statuses, actions and metadata). A review prompt alone is not a read-only GitHub
principal. Keep merge authority in protected branches, required reviews, current required checks,
and explicit GitHub bypass settings.

## Event subscriptions

Subscribe to Issues, Issue comment, Pull request, Pull request review, Workflow run, and Check suite
events. Set the webhook URL to `/webhooks/github` and configure `GITHUB_APP_WEBHOOK_SECRET`.

GitHub trigger names in `.agents/` do not subscribe the App automatically. Update the App settings
when a repository adds a supported trigger category, then send a test or redelivered event.

## Configure Facility

Provide the same GitHub App values to API and worker:

```text
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_APP_WEBHOOK_SECRET=...
GITHUB_APP_SLUG=facility-example
```

The private key can contain real newlines or escaped `\n`; Facility normalizes escaped newlines.
Store it and the webhook secret in the deployment secret manager. `GITHUB_CLONE_TOKEN` is a
local-only fallback for development and is not the production credential model.

The API uses these values to list installations, create kickstart pull requests, verify webhooks,
and inspect repositories. The worker uses them to mint credentials for story workspaces and
reconcile GitHub state.

## Install and bootstrap

Install the App on the intended account and record the GitHub installation id, account id, account
login, and target type. After database migration and seed, pass those values with the first owner's
GitHub identity to `facility instance bootstrap`. The installation becomes organization-bound; an
unknown or suspended installation cannot be guessed into another tenant.

After login, create a Facility project and choose repositories from that installation. The primary
repository owns configuration and delivery; related repositories must be connected explicitly.

## Additional private Apps

In **Settings → GitHub connections**, an organization administrator (`org:write`) can register an
App name, numeric App ID, PEM private key, webhook secret (at least 32 characters), and installation
ID. Create and install the App in GitHub first; Facility verifies that the key authenticates that
App and that the active installation belongs to it. Registration does not create an App, install
it, broaden its permissions, or change its visibility. Use a distinct webhook secret for each App.

After saving, copy the connection's webhook URL into the GitHub App settings. It has the form
`<PUBLIC_URL>/webhooks/github/<connection-id>`. Use the same event subscriptions listed above and
redeliver a test event. The URL selects a connection; it is not an authentication secret. Facility
checks its signature and binds the signed installation to that same connection and organization.
Additional installations of the same App can be registered on the connection card.

Connections belong to one Facility organization. Each App can be registered only once in an
instance. Project-scoped keys cannot administer or enumerate organization connections. New project
setup labels installations with their connection name; selecting one restricts repository discovery
to that installation. Manual connections also verify installation membership. If a failed kickstart
preview already connected its draft with another App, change that repository connection in project
settings before retrying; the draft never silently substitutes the previously selected App. Related repositories can use another connection. Workspace tokens remain
limited to the repositories connected to the current project, and each token uses its own App's
bot identity.

The private key and webhook secret are encrypted in PostgreSQL with `SECRET_MASTER_KEY`, bound to
the connection, organization and App ID, and never returned by the API. API and worker must share
that key. Back up the database and master key securely. **Rotate credentials** replaces both values;
coordinate the webhook-secret change with GitHub and redeliver missed events. **Disable connection**
blocks new credentials and webhook processing without deleting history. Already issued installation
tokens can remain valid until their expiry; revoke them in GitHub when immediate revocation is
required. Changes are read on use and do not require an API or worker restart.
Rotation verifies the App identity independently of its installations, so removing an installation
does not prevent recovery. Concurrent administration is revision-checked; reload and retry if another
administrator changed the connection during verification.

Existing installations keep their environment-configured default App and `/webhooks/github` URL.
No secrets are copied from the environment into the new table. Login remains controlled by the
existing OAuth/OIDC configuration, invitation and membership rules; adding a repository App does
not grant anyone Facility access or provide another sign-in identity provider.

### Changing a project's connection after a repository transfer

In **Project settings → Repositories → Change GitHub connection**, select the new installation and
enter the new `owner/repository`. Facility compares GitHub's immutable repository ID with the ID
already recorded for the project and verifies that the selected App installation includes that
repository. Public visibility alone is insufficient. It refuses while the project has queued or
running turns; enqueue and the final connection change share the same project lock.

This updates the existing repository record and preserves stories, workspaces and delivery evidence.
Existing sandbox checkouts and historical URLs are not rewritten. Update the repository paths in
`.facility.yml` through the project's normal review process and validate a new workspace before
resuming execution. Legacy rows without a recorded repository ID require a separately verified
operator recovery before switching. Use evidence recorded before the transfer to establish the
original immutable GitHub repository ID and backfill only the reviewed row. Looking up the old
URL now is not historical proof: another repository may have reused that name. The normal UI
cannot bypass this check or attach existing history to an unrelated repository.

## Runtime behavior

Facility verifies the HMAC before parsing a delivery, resolves the installation to one organization,
stores a deduplicated event, and dispatches triggers declared in `.agents/`. Duplicate deliveries
do not create duplicate turns. A merged pull request marks its story done and suspends compute; it
does not delete the workspace.
Repository deliveries are processed only for their selected installation. The worker rechecks the
stored repository binding before processing and again under repository or project locks when committing
mirror updates, story changes and turn enqueue. A receipt queued or already in flight before a connection
switch cannot start a turn under the new App. Nested reconciliation runs after the mirror transaction
commits, without keeping a database connection open during provider calls.

For repositories with a recorded immutable ID, API and workspace tokens use GitHub repository-ID
scopes, repository API requests check the same identity (also after public reads), and signed
deliveries must carry that ID.
Workspace preparation also verifies every checkout before and after fetching, and before executing
project setup or preview commands. This is required even for public repositories: public reads can
succeed independently of a token's selected repositories.
Reusing an old repository name therefore does not transfer its Facility privileges or history to a
replacement. Legacy rows without an ID retain their existing name-based behavior; verify and record
their historical identity before transferring them. Legacy and ID-scoped workspace credentials are
minted separately even when they use the same installation.

Agents receive the same installation token capability, including reviewers, scheduled agents and
planning agents outside the review cycle. Each token is limited to the repositories connected to
the active Facility project, while retaining the App's complete maintainer permission set for those
repositories. Only the review cycle's Reviewer turns receive a read-only token. The turn-local `gh`
wrapper selects the token from an explicit repository flag, PR URL, API repository path, `GH_REPO`,
or the current checkout's origin. It uses the primary repository outside a checkout and rejects
targets outside the turn's connected repository map. This keeps related checkouts on their own App
and credentials, including mixed legacy and ID-scoped repositories. If an unfamiliar CLI option
makes destination parsing ambiguous, or the command is outside the supported `pr`/`issue`/`api`
grammar, set `GH_REPO=owner/repo` explicitly. Option values such as issue bodies and titles never
select the repository, and the wrapper preserves an explicit `GH_REPO`. Its inferred target selects
credentials only; the child command keeps the caller or checkout default destination.

Installation tokens are short-lived and minted when work needs them. Revoking an installation or
removing a repository stops future credentials and reconciliation; it does not erase existing
Facility conversations or workspace files. Treat retained clones and local credentials according
to your incident and retention policy.

Workspace commits use the configured App's bot identity, including its GitHub user ID in the
`ID+APP[bot]@users.noreply.github.com` address. Facility verifies this identity with GitHub and
configures it when preparing new or retained repositories. This lets GitHub associate automated
commits with the App so deployment integrations can recognize their author. Existing commits are
not rewritten. If the identity lookup fails, preparation fails instead of using an invented email.

## Validate the integration

Before production use:

1. list installations and repositories from the Facility project setup flow;
2. open and merge a kickstart configuration PR through normal review;
3. create an issue and confirm it appears as not-started work on the Stories page;
4. send a signed webhook twice and confirm one activation;
5. have a disposable story clone, commit, push, and open a pull request;
6. run a workflow and confirm only the current pull-request head receives its status; and
7. merge with an authorized maintainer and confirm compute sleeps while the workspace remains.

If code, Dependabot, or secret scanning is unavailable to the installation, confirm Facility shows
that scanner as unavailable rather than reporting a clean result.

## Rotation and troubleshooting

GitHub supports multiple App private keys during rotation. Add the new key, update API and worker,
verify token minting, then revoke the old key. Rotate the webhook secret in a coordinated window
because GitHub signs each delivery with only the currently configured value.

For missing work, inspect GitHub's delivery record and Facility logs by `X-GitHub-Delivery`. Check
signature verification, installation status, repository connection, event subscription, manifest
trigger, action and label filters, and deduplication. Request an immediate sync to repair missed
mirror updates; reconciliation also runs every ten minutes.
