---
title: Webhooks
---

# GitHub webhooks

Send GitHub App deliveries to `POST /webhooks/github`. Facility requires
`X-Hub-Signature-256`, `X-GitHub-Delivery`, `X-GitHub-Event`, and an installation id in the JSON
payload.

The body is authenticated before parsing. The installation resolves the organization; unknown or
suspended installations are ignored without guessing a tenant. Delivery ids are deduplicated per
installation. Replays return success and do not queue another turn.

Supported agent events are Issues, Issue comment, Pull request, Pull request review, Check suite,
and completed Workflow run. Matching happens against triggers in the primary repository's
`.agents/` catalog. A merged pull request marks the linked story done and suspends compute without
destroying durable state.

Issue and pull request deliveries also update the project mirror. Workflow run and check suite
deliveries attach CI state to the matching pull request only when the event's head SHA is current.
The worker reconciles every connected repository every ten minutes, and maintainers can request an
immediate sync through MCP, API, or the Pipeline page.
