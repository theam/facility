# External preview registration lifecycle

Operators integrating an identity provider (for example, application callback
allowlists) need the **story lifecycle**, not the machine power state. A story
can finish while its files and database remain in a suspended workspace.

`GET /v1/projects/:projectId/workspace-stories/:storyId/preview-registration`
requires `previews:read`, including the normal organization/project scope checks.
It is a read-only projection of persisted Facility/GitHub state. It never wakes,
suspends, destroys, executes in, or provisions a workspace. It returns:

- Exact organization, project, story and workspace identity.
- `registration.state`: `active`, `closed`, or `unknown`, with a reason.
- Story phase and independent agent activity.
- Configured stable `sites`: public id, service and origin only. No surface
  credential, preview grant, project variable or model credential is exposed.
- `observedAt` and an opaque content `revision`. The revision is **not** a
  monotonic event sequence: reopening can return a previously seen revision.

| Persisted observation | External registration |
| --- | --- |
| Open story, including sleeping/error compute | Keep/register |
| Closed primary issue, completed story or archived story; no active turn | Remove owned entries |
| Running/queued turn on a completed story | Keep until the turn settles |
| Explicitly deleting/destroyed workspace | Remove owned entries |
| Reopened story whose effective phase is active | Register the same binding again |
| Missing workspace, missing/stale GitHub evidence, HTTP failure or 404 | No inferred deletion; retry or request operator attention |

The phase reuses the backlog's repository-scoped association. A merged child
repository PR does not finish the parent story merely because branch names or
issue numbers match. Restoring an archived **completed** story does not by itself
make it active; the effective phase must actually reopen. Suspension never closes
a story. Deleting data still requires the existing explicit deletion action.

This is a **reconciliation contract**, not a webhook service or an exactly-once
hook. An external operator periodically fetches the current state for every
binding it owns, compares it with its durable registration ledger, and applies
idempotent changes. Re-fetch just before writing; reconcile again after failures.
Do not consume a saved snapshot as an authorization to delete days later. Do not
infer removals from a paginated list, an omitted site, a missing story, or a 404.
An empty `sites` array means no stable site is configured, not that every old
callback is safe to remove. Keep failed/pending work visible in the operator's
ledger; absence of an event delivery must not silently leak registrations forever.

## Identity provider adapter requirements

Run privileged adapters **outside agent workspaces**, using operator-managed
credentials. Pin the tenant/client and the exact Facility scope/site binding;
never accept an arbitrary callback from an issue body, manifest or agent output.
Read/merge allowlists, preserve unrelated and pre-existing entries, record only
entries the adapter added, and remove only those owned entries on `closed`.
Do not add broad wildcard origins. Serialize all writers to a shared OAuth client,
including tenant configuration deployments, and verify the result after writes.

Closing a story removes registrations independently of retained storage. Keep the
stable origin reserved for that workspace, even after closure; never recycle its
browser origin for another workspace. Reopening can restore its registration.

## Provisioning remains separate

This endpoint reports the existing operator-configured bindings from
[`FACILITY_PREVIEW_SITES`](workspace-preview-sites.md). It **does not create** a
CloudFront distribution, update the configuration secret, redeploy the API,
register Auth0 callbacks, or install an external scheduler. Those actions need
separate reviewed operator configuration. An empty site list is not an automated
preview. Dynamic provider provisioning and webhook delivery remain follow-up work.

Tests: `preview-registration.test.ts` covers the lifecycle projection;
`preview-registration.integration.test.ts` exercises real database state, API-key
authorization, tenant isolation, issue close/reopen, child-PR isolation and
credential-free output with a deterministic, unused workspace runtime.
