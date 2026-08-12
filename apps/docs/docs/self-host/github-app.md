---
title: GitHub App
---

# Configure the GitHub App

Self-hosted Facility uses one GitHub App for two jobs: direct GitHub OAuth for
human sign-in, and an App installation for repository automation. The OAuth
side verifies a user's stable id and verified emails; the installation side
discovers repositories, creates governed branches and pull requests, collects
delivery outcomes, and receives repository events.

Configuration has two phases. First set the App's OAuth identity, permissions,
and credentials, then install it to obtain the installation id used by
`facility instance bootstrap`. The webhook can remain inactive during initial
deployment: bootstrap records the installation binding directly. After the
public Facility API is reachable, activate and test the webhook.

## 1. Create or edit the App

In GitHub, open the owning organization, then **Settings → Developer settings →
GitHub Apps**. Create a new App or edit the existing one.

Use these general settings:

| setting | value |
|---|---|
| GitHub App name | a unique name, such as `facility-production` |
| Homepage URL | the Facility web URL or project homepage |
| Callback URL | `https://<web-host>/api/auth/callback`, exactly matching `AUTH_CALLBACK_URL` |
| Setup URL | empty |
| Device flow | disabled |
| Request user authorization (OAuth) during installation | disabled |
| Where can this GitHub App be installed? | **Only on this account** for a private installation |

Keep automatic user authorization disabled when installing the App before
Facility is deployed. This does not disable OAuth: signing in to Facility later
starts GitHub authorization after the callback URL is reachable. Leave the
webhook inactive until the API has a public HTTPS URL.

## 2. Grant permissions

For an existing-repository lifecycle, set these **Repository permissions**:

| permission | access | why |
|---|---|---|
| Actions | Read-only | inspect workflow runs and receive `workflow_run` |
| Checks | Read-only | receive CI check results |
| Code scanning alerts | Read-only | collect deterministic platform security-sweep evidence when code scanning is enabled |
| Contents | Read and write | clone, read files, create commits, and update governed branches |
| Dependabot alerts | Read-only | collect deterministic platform security-sweep evidence when Dependabot is enabled |
| Deployments | Read-only | receive deployment health signals |
| Issues | Read and write | sync work issues, publish agent plans/comments, and project qualifying security or learning work through trusted code (receipts/outcomes do not create issues) |
| Metadata | Read-only | repository identity and collaborator metadata; GitHub normally selects this automatically |
| Pull requests | Read and write | open and close PRs and collect review evidence |
| Secret scanning alerts | Read-only | collect deterministic platform security-sweep evidence when secret scanning is enabled |
| Workflows | Read and write | install or update files under `.github/workflows` during kickstart |

Set **Organization permissions → Members** and **Account permissions → Email
addresses** to **Read-only**. The latter is required for direct GitHub sign-in;
Facility checks every verified address against explicit invitations, including
a secondary company email. Without this permission Facility cannot obtain the
verified addresses and rejects the login. The
Members permission lets direct login enforce `GITHUB_OAUTH_ALLOWED_ORGANIZATION`
when configured. Leave all other account and user permissions at **No access**.

`Administration: Read and write` is optional and high privilege. Enable it only
when Facility must create repositories in the organization. It is not required
to connect and operate on an existing repository.

GitHub shows only webhook events allowed by the selected permissions. In
particular, `workflow_run` requires Actions read access, `check_run` requires
Checks read access, and `deployment_status` requires Deployments read access.
Facility records a scanner as unavailable rather than clean when its GitHub
feature is disabled or its read permission has not been approved.
See GitHub's
[permission guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
and [webhook event reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

## 3. Subscribe to events

GitHub shows **Subscribe to events** only after the App's webhook is active and
its URL has been saved. If the API is not reachable yet, complete sections 4
and 6, deploy and bootstrap Facility, then return here after section 5.

On **Permissions & events**, scroll below the permission panels to **Subscribe
to events** and select:

- **Check run** (`check_run`)
- **Deployment status** (`deployment_status`)
- **Issue comment** (`issue_comment`)
- **Issues** (`issues`)
- **Pull request** (`pull_request`)
- **Pull request review** (`pull_request_review`)
- **Push** (`push`)
- **Workflow run** (`workflow_run`)

Then save the App settings. If one of those checkboxes is missing, return to
**Permissions**, grant its required read permission, save, and open the App
settings again.

After deployment, run `facility doctor --platform` (or inspect the admin
readiness doctor) to verify that the App still has **Checks: Read-only** and is
subscribed to **Check run**. Facility reports a failing readiness check instead
of leaving the Validating stage silently empty when either setting is missing.

Every GitHub App receives `installation` events automatically; GitHub does not
offer a checkbox for them. GitHub also sends installation-repository changes
when repositories are added to or removed from the installation.

If the App is already installed when permissions change, an organization owner
must approve the new permissions on the installation.

## 4. Create the credentials

The Facility API needs six values in direct-GitHub mode:

```dotenv
GITHUB_OAUTH_CLIENT_ID=<Client ID from the App's General page>
GITHUB_OAUTH_CLIENT_SECRET=<generated client secret>
GITHUB_APP_ID=<numeric App ID, not the Client ID>
GITHUB_APP_SLUG=<the suffix from https://github.com/apps/<slug>>
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----"
GITHUB_APP_WEBHOOK_SECRET=<random secret shared with GitHub>
```

### OAuth client credentials

Copy the **Client ID** from the App's General page. Under **Client secrets**,
select **Generate a new client secret** and store it immediately; GitHub shows
the plaintext once. These values become `GITHUB_OAUTH_CLIENT_ID` and
`GITHUB_OAUTH_CLIENT_SECRET`. They are distinct from the numeric App ID and the
private key used for installation authentication.

### Private key

Under **Private keys**, select **Generate a private key**. GitHub downloads the
only copy of the private half as a PEM file. Store it outside the repository,
restrict it with `chmod 600`, and put its complete PEM contents in the runtime
secret named `GITHUB_APP_PRIVATE_KEY`. The header may be `BEGIN PRIVATE KEY`
instead of `BEGIN RSA PRIVATE KEY`; preserve the downloaded format exactly.

### Webhook secret

Generate a high-entropy value locally:

```bash
openssl rand -hex 32
```

Paste the exact same value into:

1. GitHub App settings → **Webhook secret**.
2. Facility's runtime secret → `GITHUB_APP_WEBHOOK_SECRET`.

GitHub uses this value to sign the exact request body in
`X-Hub-Signature-256`; Facility rejects missing or invalid signatures. GitHub
does not reveal the saved value later. If it is lost, generate a new value and
replace both sides together. Never put the secret in the webhook URL.

For a local `.env`, confirm the file is ignored before adding credentials:

```bash
git check-ignore .env
```

Production deployments should store the private key and webhook secret in the
platform secret manager rather than in a repository file.

## 5. Get the webhook URL

GitHub does not generate the webhook URL. It comes from the externally reachable
Facility **API** origin:

```text
<PUBLIC_URL>/webhooks/github
```

For example, when `PUBLIC_URL=https://api.facility.example.com`, configure:

```text
https://api.facility.example.com/webhooks/github
```

Use the API hostname, not the web app, internal gateway, MCP server, ECS service
name, or private load-balancer address. The endpoint must be reachable from
GitHub over HTTPS with a valid certificate.

For the AWS Terraform deployment, obtain the API origin after apply:

```bash
cd infra/terraform/aws
terraform output -raw api_url
```

The dedicated `github_webhook_url` output prints the complete URL directly. For
a validation deployment without a public DNS zone, set
`enable_cloudfront_api_endpoint = true`; both outputs then use an AWS-managed
CloudFront HTTPS hostname. For production, the module's `api_hostname` should
resolve to its public ALB. Set `route53_zone_id` to let Terraform create the
record, or create the equivalent alias/CNAME with another DNS provider.

After the API is healthy, return to the GitHub App's **General** settings and
configure:

| setting | value |
|---|---|
| Active | enabled |
| Webhook URL | `https://<api-host>/webhooks/github` |
| Webhook secret | the exact `GITHUB_APP_WEBHOOK_SECRET` value |
| SSL verification | enabled |

Save the changes. An App installed while the webhook was inactive does not need
to be reinstalled; bootstrap already recorded its installation binding.

Return to **Permissions & events** and complete section 3. The event checkboxes
will now appear below the permission panels.

## 6. Install the App

Open **Install App**, choose the organization, and select **Only select
repositories** for the least-privilege validation setup. Select the repositories
Facility will govern and confirm the installation.

Install before running `facility instance bootstrap`, and note the installation
id at the end of the installation-settings URL. It is safe to do this while the
webhook is inactive: bootstrap creates the initial binding. Once the webhook is
active, adding or removing a test repository generates an
`installation_repositories` delivery if you need to verify that event family.

## 7. Verify the integration

For generated review workflows, add the repository variable
`FACILITY_BOT_LOGIN` with the App slug (for example, `facility-production`,
without a `[bot]` suffix). This lets the review action accept PRs created by
that one trusted App without allowing every bot. Receipt artifacts are always
uploaded. Set `FACILITY_ENABLE_ATTESTATIONS=true` only when GitHub artifact
attestations are available for the repository's visibility and organization
plan; otherwise leave it unset so receipt collection remains green without an
unsupported attestation call.

1. Create a test issue or comment in an installed repository.
2. In the GitHub App settings, open **Advanced → Recent deliveries** and confirm
   it received a `2xx` response.
3. Submit a non-approving review on a disposable pull request.
4. Confirm the corresponding `issues` or `issue_comment` and
   `pull_request_review` deliveries received a `2xx` response and appear in
   Facility's inbound event history. Without `pull_request_review`, the
   address-review agent cannot receive actionable feedback.
5. Run the platform readiness check:

   ```bash
   node packages/cli/bin/facility.mjs doctor --url https://<api-host> --key fak_...
   ```

Common failures:

| symptom | likely cause |
|---|---|
| `501 auth_unconfigured` on sign-in | OAuth client id/secret missing — configure both and restart the API |
| GitHub reports a redirect URI mismatch | the App callback and `AUTH_CALLBACK_URL` differ; they must match exactly |
| `auth_failed` after GitHub authorization | the App lacks **Email addresses: Read-only**, or the user has no verified email |
| `404` delivery | wrong hostname or path; the path must be `/webhooks/github` |
| `401` delivery | GitHub and Facility have different webhook secrets |
| TLS delivery error | DNS or certificate is not valid for the API hostname |
| event checkbox missing | the corresponding App permission has not been granted |
| App authenticates but cannot see a repository | the repository is not selected in the App installation |
| permission changed but calls still return `403` | the installation owner has not approved the new permission set |

GitHub recommends HTTPS, SSL verification, a high-entropy webhook secret, and
checking `X-Hub-Signature-256` for every delivery. See GitHub's
[webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
and [webhook security guidance](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).
