---
title: GitHub App
---

# GitHub App

Facility uses a GitHub App for repository discovery, clone and push credentials, kickstart pull
requests, delivery mirroring, and webhook-driven agents. Browser login uses a GitHub OAuth App or
OIDC configuration separately; do not confuse its client secret with the GitHub App private key.

## Create the App

Create one GitHub App for the Facility instance and install it only on repositories the instance
may automate. Grant read/write access to Contents, Issues, Pull requests, Workflows, Actions,
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

Organization membership read access may be required for organization-restricted identity and
repository discovery. If browser sign-in needs private email discovery, configure the corresponding
OAuth scope on the identity application; it is not a repository permission in the table.

Do not create different GitHub Apps or permission profiles for different agents. If an installation
cannot expose one of the alert APIs, Facility records a scanner as unavailable rather than clean.

Facility intentionally requests one consistent installation capability for all agents. A read-only
review prompt is not a read-only GitHub principal. Keep merge authority in protected branches,
required reviews, current required checks, and explicit GitHub bypass settings.

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

## Runtime behavior

Facility verifies the HMAC before parsing a delivery, resolves the installation to one organization,
stores a deduplicated event, and dispatches triggers declared in `.agents/`. Duplicate deliveries
do not create duplicate turns. A merged pull request marks its story done and suspends compute; it
does not delete the workspace.

All agents receive the same installation token capability. Facility does not request a smaller
permission set for reviewers, scheduled agents, or planning agents. Each token is limited to the
repositories connected to the active Facility project, while retaining the App's complete
maintainer permission set for those repositories.

Installation tokens are short-lived and minted when work needs them. Revoking an installation or
removing a repository stops future credentials and reconciliation; it does not erase existing
Facility conversations or workspace files. Treat retained clones and local credentials according
to your incident and retention policy.

## Validate the integration

Before production use:

1. list installations and repositories from the Facility project setup flow;
2. open and merge a kickstart configuration PR through normal review;
3. create an issue and confirm the Pipeline mirror updates;
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
