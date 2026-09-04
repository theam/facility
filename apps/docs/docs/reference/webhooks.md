---
title: Webhooks
---

# GitHub webhooks

GitHub webhooks keep Facility's delivery mirror current and can activate repository-defined
agents. Configure one webhook secret per Facility GitHub App and send deliveries to the public API
origin, never the preview origin.

## Required request

Send GitHub App deliveries to `POST /webhooks/github`. Facility requires
`X-Hub-Signature-256`, `X-GitHub-Delivery`, `X-GitHub-Event`, and an installation id in the JSON
payload.

The content type should be `application/json`. The signature is GitHub's SHA-256 HMAC over the exact
raw request body using `GITHUB_APP_WEBHOOK_SECRET`. A proxy must not rewrite the body before it
reaches Facility.

## Verification and deduplication

The body is authenticated before parsing. The installation resolves the organization; unknown or
suspended installations are ignored without guessing a tenant. Delivery ids are deduplicated per
installation. Replays return success and do not queue another turn.

Returning success for an ignored unknown or duplicate delivery prevents GitHub from retrying an
event that Facility cannot safely attribute. Inspect the webhook and worker logs when an expected
activation is absent; do not infer that every 2xx response created a turn.

## Supported events and triggers

Supported agent events are Issues, Issue comment, Pull request, Pull request review, Check suite,
and completed Workflow run. Matching happens against triggers in the primary repository's
`.agents/` catalog. A merged pull request marks the linked story done and suspends compute without
destroying durable state.

The GitHub trigger `event` must match one of those event names, and optional `actions` and `labels`
must match the payload. The acting account's `author_association` must also pass the trigger's
[author gate](agent-manifest.md#author-gate), which defaults to repository owners, members, and
collaborators. The manifest must be enabled at the current primary-repository commit. Facility
records the trigger identity and manifest snapshot on the resulting turn.

Delivery deduplication and story message deduplication are separate. A repeated GitHub delivery id
is ignored; distinct deliveries that represent the same logical event are also constrained by the
stable trigger/story identity before dispatch.

## Delivery mirror

Push, create, delete, issue, pull request, pull request review, workflow run, check suite, and check
run deliveries update the project mirror where applicable. CI state attaches to the matching pull
request only when the event's head SHA is current. The worker reconciles every connected repository
every ten minutes, and maintainers can request an immediate sync through MCP, API, or the Pipeline
page.

The mirror is a local operating view, not a replacement for GitHub. Issue, branch, pull-request,
review, and check records retain GitHub identity and current state. Check suites and workflow runs
attach to the pull request whose current head SHA matches the event, preventing stale CI from being
shown as the present result. Reconciliation discovers matching changes that happened outside
Facility and records them on the story timeline without attributing them to an agent turn unless
the final SHA proves that relationship.

## App subscriptions

Subscribe the GitHub App to:

- Issues
- Issue comment
- Pull request
- Pull request review
- Push
- Create
- Delete
- Workflow run
- Check suite
- Check run

Adding a manifest for an event that the App does not subscribe to cannot activate the agent. After
changing subscriptions or repository access, send a test delivery and request an immediate sync.

## Operational checks

For a missing activation, compare the GitHub delivery page with Facility API and worker logs using
the delivery id. Verify the request reached the API, the HMAC matched, the installation is active,
the project connects the repository, the manifest contains a matching trigger, the sender passes
that trigger's author gate (a skipped delivery is logged by the worker with the delivery id and
association), and no equivalent message or turn already exists.

Do not replay a delivery with an edited body under its old signature or delivery id. Use GitHub's
redelivery feature so the signature and request metadata remain coherent.
