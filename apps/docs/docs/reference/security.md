---
title: Security model
---

# Security model

Security and privacy are first-class concerns; this page is the contract.

## Identity & access

- Humans: GitHub identity through direct OAuth or the SaaS OIDC broker. Machines: argon2id-hashed API keys bound to
  roles. One permission catalog for web, CLI, MCP, and agents; deny by
  default; every route declares its permission and the startup assertion
  refuses undeclared routes.
- Custom roles are named permission sets — no side-channel authority.

## Secrets

- **Stored secrets** — provider API keys and integration signing secrets are
  sealed (libsodium) with a master key from your secret manager/KMS, decrypted
  only in the service that needs them. Provider credentials are never returned;
  integration signing secrets appear only in create/rotate responses and never
  in read responses.
- **Service credentials** — the GitHub App, upstream identity, and OAuth signing credentials
  are supplied to the services as environment variables from your secret
  manager; the platform reads them at boot and does not persist them in its
  database.
- Sandboxes receive no provider secrets — only run-scoped virtual keys and
  short-lived repo tokens fetched after boot.

## Webhooks and outbound network safety

- Facility-signed inbound events bind timestamp, delivery id, event type, and
  exact body bytes into HMAC-SHA256. The receiver enforces a five-minute replay
  window and integration-scoped delivery deduplication.
- Outbound webhooks require HTTPS outside insecure development, reject URL
  credentials and private/reserved IPv4/IPv6 answers, pin the validated address
  for the connection, disable redirects, and use a ten-second deadline. The
  durable outbox gives at-least-once delivery with bounded retry and visible dead
  letters.
- Remote MCP validates `Host` and browser `Origin`, bounds JSON bodies, and asks
  the control plane to authenticate each uncached Bearer credential before MCP
  protocol admission. Invalid credentials cannot enumerate the catalog;
  validation outages fail closed with `503` and `Retry-After`. Accepted caller
  credentials are forwarded to the API, and MCP has no privileged service identity.

## Protected previews

- Preview origins bind only to Docker loopback or an AWS private address;
  Facility rejects public, credential-bearing, and non-HTTP origins.
- Production preview creation, listing, viewing, and deletion fail closed until
  interactive GitHub/OIDC login is configured. Machine keys can request a preview, but cannot view
  or delete it.
- Preview HTML and JavaScript are served only from `FACILITY_PREVIEW_URL`, a
  browser site isolated at the registered-site boundary that routes to the
  existing API tasks. The AWS module creates a dedicated AWS-assigned
  CloudFront origin by default; custom deployments must provide a separately
  registered site. The preview host denies every control-plane route, and the
  control-plane hosts deny preview content routes.
- Opening a preview exchanges the Facility session for a single-use,
  60-second handoff and then a short-lived HttpOnly cookie bound to one user,
  organization, and preview. Every request rechecks active membership and
  `runs:read`; the proxy strips cookies and authorization before forwarding
  only browser-safe `GET` and `HEAD` requests.
- Do not configure a custom preview hostname as a sibling of the app/API
  hostnames, and never widen Facility cookies with a parent `Domain` attribute.
  The AWS-assigned origin or a separate registered site prevents untrusted
  preview JavaScript from tossing cookies into the control-plane site.
- No provider or production secrets are injected. Projects publish an immutable
  review image whose command prepares only non-production data.
- Preview application containers currently have outbound network access. Place
  production preview workers in a dedicated subnet/network whose policy blocks
  metadata endpoints and internal services; treat the review image as untrusted.
- Readiness is a project-defined HTTP path. PR close and retention expiry queue
  sandbox destruction, and each lifecycle transition enters the audit log.

## Untrusted text

Issue, PR, review, and comment text is data, never instructions — the rule
holds in webhook handlers (no interpolation into shell/prompts/SQL), in
operating contracts, and in the rendered workflows (jq event parsing,
start-of-line slash commands, bot-refusal, message-hash canary
authorization). The fifteen production hardening notes ship encoded in
templates, handlers, and guards — not as advice.

## Audit & privacy

- Append-only, hash-chained audit log; tamper evidence is a query.
- Store-everything default (envelopes, transcripts). Expiry is by the object
  store's lifecycle policy — configured by our AWS Terraform, and operator-
  configured for other S3-compatible stores; there is no app-level enforcement yet
  (a per-org `retention_days` setting is recorded; app-enforced per-org expiry is a
  follow-up). Access is gated by permission + project scope — the full transcript
  needs `audit:read`.
- Receipts and analytics are metrics-only: no prompts, no code, hashed
  actors. Self-hosted telemetry to the vendor: none.

## The invariants that never move

Agents never approve, never merge, never push to protected branches. Every
outward action carries a named principal. Every merge carries a human
decision.

## Repository settings that back the gates

Facility enforces part of the paragraph above — generated workflows declare their
own least-privilege `permissions:` block, refuse bot-authored events, skip fork
heads, and pin every action to a SHA. The rest is GitHub repository
configuration, which Facility cannot enforce from inside a workflow. The split is
invisible: a repository can run the whole loop, produce plans and pull requests
and reviews, look completely correct, and still let an automated actor satisfy a
human gate. Configure these before the first agent run.

| setting | required value | enforced by | what skipping it costs |
|---|---|---|---|
| **Allow GitHub Actions to create and approve pull requests** (organization and repository) | disabled | the setting | Breaks *agents never approve*. The review workflow only comments — but that is a prompt, and the job runs with `pull-requests: write`. With this enabled, `GITHUB_TOKEN` can submit an approving review and satisfy the required human approval on its own pull request. |
| **Workflow permissions** — the default `GITHUB_TOKEN` scope | read repository contents and packages permissions | the setting, for workflows you add later; Facility, for the ones it generates | Every generated workflow declares an explicit job-level `permissions:` block, so this default does not change what the crew receives. It governs the next workflow added without one, which otherwise gets write access to everything. |
| **Default branch protected, pull request required** | enabled | the setting | Breaks *agents never push to protected branches* by making the sentence vacuous. Facility commits kickstart to `facility/kickstart` and builders push semantic branches, but the address-review and doctor workflows hold `contents: write`. Nothing structural stops a push to an unprotected default branch. |
| **Required approvals** | at least 1 | the setting | Breaks *every merge carries a human decision*. The count alone is not enough: pair it with the Actions-approval setting above, or a token can satisfy it. |
| **Dismiss stale approvals when new commits are pushed** | enabled | the setting | The address-review agent pushes commits to the pull request branch after a human reviews it. Without dismissal, an approval given for one diff silently covers code the approver never read. |
| **Required status checks**, with branches up to date (or a merge queue) | the repository's own checks, plus the guards runner | Facility runs them; the setting makes them blocking | The agent verified the change against these checks. Unless they are required, nothing stops a merge that ignores that verification — and a green check against a stale base is not evidence about what lands. |
| **Restrict who can push, and who can bypass required pull requests** | humans and teams only — never the Facility GitHub App | the setting | Breaks *agents never merge*. The App installation holds `Contents: Read and write`; a bypass entry converts that permission into merge authority over the default branch. |
| **Do not allow bypassing the above settings** | enabled | the setting | An administrator, or an App acting with administrative rights, otherwise skips every row in this table. |

Rulesets are the modern equivalent of branch protection and satisfy the same
rows. Audit their **bypass list** with equal suspicion: a bypass entry is the
setting saying "except for this actor".

### Checking them through the API

| setting | endpoint and field | needs |
|---|---|---|
| Actions may approve pull requests; default `GITHUB_TOKEN` scope | `GET /repos/{owner}/{repo}/actions/permissions/workflow` → `can_approve_pull_request_reviews` must be `false`, `default_workflow_permissions` must be `"read"` | repository admin |
| The same two, organization-wide | `GET /orgs/{org}/actions/permissions/workflow` | organization admin, and an `admin:org` token scope |
| Approvals, stale dismissal, required checks, push restrictions, admin enforcement | `GET /repos/{owner}/{repo}/branches/{branch}/protection` → `required_pull_request_reviews.required_approving_review_count`, `.dismiss_stale_reviews`, `required_status_checks.contexts` and `.strict`, `restrictions`, `enforce_admins` | repository admin |
| The rules actually in force on a branch, including rulesets | `GET /repos/{owner}/{repo}/rules/branches/{branch}` | read access — no admin required |

The organization setting constrains the repository one: if the organization
disables Actions approving pull requests, a repository cannot re-enable it. Check
both before concluding a repository is safe.

Two `404` responses from the protection endpoint mean different things, and the
message body is the difference: `Branch not protected` is an answer, `Not Found`
means the caller is not an admin and learned nothing.

### What `facility doctor --github` covers today

The command verifies that the required secrets and variables exist, and that the
default branch returns a branch-protection response at all. It does not read that
response. Worth adding, in rough priority order — each is a field in a call the
command already makes, or one extra call:

- `can_approve_pull_request_reviews` and `default_workflow_permissions`, from a
  single `actions/permissions/workflow` call. Neither is checked today, and the
  first is the setting that most directly defeats an advertised gate.
- The organization-level values of those two fields when the token carries
  `admin:org`, reported as unknown rather than as a pass when it does not.
- `required_approving_review_count`, `dismiss_stale_reviews`, the required check
  contexts, `strict`, `restrictions`, and `enforce_admins` — all already present
  in the protection response the check fetches and discards.
- `GET /repos/{owner}/{repo}/rules/branches/{branch}` as a fallback: a branch
  protected purely by a ruleset returns `404` from the classic endpoint, so the
  command currently reports a correctly protected repository as a failure.
- Distinguishing `Branch not protected` from `Not Found`, so a non-administrator
  does not get the same failure as a genuinely unprotected branch.

---

Report vulnerabilities per [SECURITY.md](https://github.com/theam/facility/blob/main/SECURITY.md).
