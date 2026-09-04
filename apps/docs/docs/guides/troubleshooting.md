---
title: Troubleshooting
---

# Troubleshooting

Start with the narrowest failed boundary: control plane, repository contract, workspace provider,
engine, preview, or GitHub. Keep the request id, project id, story id, workspace id, and provider
reference together when comparing logs.

## A story remains queued

Check that the worker is running and can reach PostgreSQL. Inspect the `turns.dispatch` queue and
the story's open attention items. A story permits only one queued or running turn, so a previous
turn that has not reached a terminal state can block promotion.

Confirm the selected agent exists at the current primary-repository commit, is enabled, and
declares the activation surface (`mcp`, `ui`, `manual`, matching GitHub event, or schedule). A
catalog parse error prevents dispatch and should be corrected through a repository PR.

## Workspace creation or wake fails

Open the environment event stream and provider inspection. Check:

- `FACILITY_WORKSPACE_DRIVER` and provider credentials;
- that `FACILITY_WORKSPACE_IMAGE` exists and matches the provider architecture;
- provider team/project identifiers for Vercel;
- Docker daemon access for a local control plane;
- retained-volume or snapshot availability; and
- storage, quota, and provider error messages.

Do not delete the workspace to clear a transient compute failure. Suspending and waking, or
replacing compute, should attach the same volume. Delete only when loss of its state is acceptable.

## Setup, start, or readiness fails

Run the exact `.facility.yml` command in the primary checkout. `setup` runs when its contract
checksum changes or clean setup is requested; `start` runs on each preparation. Make `start`
idempotent and avoid foreground processes that never return.

Check that every declared secret and variable has a matching
`FACILITY_PROJECT_<PROJECT_ID>_<NAME>` operator value. Facility reports missing names but does not
return secret values. Use clean setup to distinguish a bad contract from stale dependencies.

If readiness times out, test the declared host and port from inside the workspace. The service must
listen beyond loopback when the workspace provider requires a proxy connection.

## The agent starts but cannot continue its session

Inspect the turn's engine, model, native session reference, and workspace volume. Engine sessions
belong under the persistent Facility home in the workspace. If an engine reports a corrupt or
unusable session, Facility retains the reference for history and may create a replacement; it does
not manufacture the missing provider context.

Verify provider credentials, model availability, and any configured reasoning effort. A manifest
model name is passed to its engine and must be valid for that installation.

## Git operations fail

Confirm the GitHub App installation still covers every connected repository and has the documented
permissions. Installation tokens are short-lived; retrying a turn should issue a fresh credential.
Check branch protection separately from authentication: full maintainer capability does not bypass
repository rules unless GitHub has been configured to allow it.

For webhook-driven work, verify the signature secret, subscribed event, installation id, delivery
id, event action, and optional label filters. Use an immediate GitHub sync when webhook delivery
was missed; periodic reconciliation runs every ten minutes.

## A preview does not open

Confirm the workspace is not destroyed, the named service exists in `.facility.yml`, and readiness
has passed. The preview origin must be HTTPS in production and on a registered site separate from
the web, API, and MCP origins.

Generate a new one-time handoff. Preview cookies expire and can be revoked. Each HTTP and WebSocket
request revalidates membership, workspace, and service, so removing access should stop an existing
session.

## Cost appears unavailable

Environment metrics can report active compute and retained storage even when the provider does not
return billable prices. `provider_pricing_unavailable` means Facility lacks a defensible amount; it
does not mean zero. Check provider usage collection, turn usage records, project cost aggregation,
and the configured budget independently.

## Health and logs

Use `/health` for process liveness and `/readyz` for readiness. The API includes `x-request-id` on
requests; carry it into API, worker, and provider log searches. In AWS, use the API, worker, web,
and migration CloudWatch log groups. In Compose, start with `docker compose ps` and
`docker compose logs <service>`.

Unknown server failures return a masked `internal_error`; consult server logs for the request id
rather than exposing internals to the client.

## Recovery order

1. Preserve the database and workspace volume or snapshot.
2. Capture the failing request, event, and provider inspection.
3. Fix configuration, credentials, capacity, or the repository contract.
4. Retry the attention item or send a new message.
5. Use clean setup only when environment state is suspect.
6. Delete the workspace only as an explicit last action after recovering valuable files.

For deployment-level failures, continue with the [production operations
guide](../self-host/production.md) or [AWS runbook](../self-host/aws.md).
