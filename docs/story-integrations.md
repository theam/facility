# Story integrations

Facility exposes generic lifecycle facts, a small per-story state store and
coarse GitHub notifications. Project-owned integrations decide what those facts
mean: callback registration, test-data cleanup or another external operation.
Facility has no Auth0-specific fields, credentials or cleanup policy.

## Read current state

`GET /v1/projects/:projectId/workspace-stories/:storyId?evidence=none`
keeps the existing story bundle and adds `lifecycle`. It requires `projects:read`
and normal organization/project authorization. No separate preview-registration
GET is needed. Reading never wakes/executes/destroys/provisions compute.

`lifecycle` contains schemaVersion 1, org/project/story identities, persisted story
status and completion/archive/deletion timestamps, effective backlog phase/reason,
independent activity, source `provider`/`repositoryId`/`externalId`, GitHub issue
and associated PR state/freshness, plus
`workspace: { id, state, sites: [{ id, service, origin }] }` (or null). Sites are
filtered to the exact org/project/workspace; surface credentials are never exposed.
An origin is **configured**, not proof that the application is ready or login works.

For GitHub stories, `externalId` identifies `issue:N` or `pull-request:N` in the
source `repositoryId`. Both issue and PR facts include `repositoryId`, `number`,
`state` and `stale`. Freshness uses the mirror's `syncedAt` (30-minute threshold),
not the last GitHub edit or the time of this GET. A PR-backed story can legitimately
have `issue: null`; use its exact PR evidence. Missing source evidence is unknown,
not permission to fall back to another PR with the same branch or number in a
different repository. Issue-backed stories still require their issue evidence;
if acting on a related PR's state, check that PR's freshness too. A closed,
unmerged PR keeps the story in progress; a merged PR produces the done phase.

`revision` is an opaque content hash; `observedAt` is observation time. A reopened
story may revisit an earlier revision. Missing/stale GitHub data, missing workspace,
an empty site list or HTTP 404 is not a deletion command. A child PR with the same
branch/issue number does not close the parent. Suspension does not finish a story.
Facility may mark a story done when its associated PR is merged; this is not proof
of a downstream production deployment. Consumers must state their cleanup policy.

## Store small integration state

The existing `story` object includes `integrationState` (initially `{}`) and
`integrationStateRevision` (initially 0), also available in the story list. The data
lives in Facility PostgreSQL, not the ephemeral runner or workspace. It survives
suspension, archive and soft deletion. Do not hard-delete a story/its DB records
before dependent cleanup; future hard-deletion workflows must preserve tombstones.

Update one namespace using `stories:write`, scoped to the project:

```http
PATCH /v1/projects/:projectId/workspace-stories/:storyId/integration-state
Content-Type: application/json

{"namespace":"my-integration","expected_revision":0,"value":{"status":"pending"}}
```

Response: `{"namespace":"my-integration","value":{"status":"pending"},"revision":1}`.
`value: null` removes that namespace. Other namespaces are preserved. A stale
expected revision returns 409 `integration_state_revision_conflict`: read/merge
again, do not blindly overwrite. Total story JSON is limited to 16 KiB (UTF-8,
PostgreSQL JSON representation). Namespace names are lowercase letters, digits,
hyphens or underscores, starting with a letter; reserved prototype names fail.

No tokens, credentials, large logs, files or customer data. It is not a secret
store or an authority to execute commands. Record exact owned resources, compact
pending-operation identity and recovery evidence. Facility cannot transact with
an external API; consumers must handle a successful external write followed by a
failed metadata save. Revision checks prevent lost metadata updates, not races on
shared third-party resources. Serialize those writers separately.

State updates are audited but deliberately do not change story.updatedAt or
generate lifecycle notifications; otherwise an integration can trigger itself.
No namespace ACL is promised: `stories:write` can edit all namespaces in scope.

## Lifecycle notifications via GitHub

The Facility worker publishes `repository_dispatch` to the project's **primary
repository**, using that organization's active GitHub App installation. It does
not run a Facility GitHub Action to invoke the project. The App needs Contents:
write, which GitHub requires for repository dispatch.

The event types are `facility.story.updated` and `facility.workspace.updated`.
The workflow filename is not a contract. An interested workflow on the default
branch subscribes as follows:

```yaml
on:
  repository_dispatch:
    types: [facility.story.updated, facility.workspace.updated]
```

`client_payload` includes only schemaVersion 1, eventId (UUID), type (`story.updated`
or `workspace.updated`), orgId, projectId, storyId, workspaceId and occurredAt.
It includes no URLs, credentials, state JSON, code ref or command. Always fetch
the current GET after validating the scope. A response accepting the event does
not prove a matching workflow exists or ran; no listener is a normal condition.
See [GitHub's dispatch API](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event).

The first version uses the existing worker scheduler to observe coarse state
once per minute in fair batches of 100 stories, including closed/soft-deleted
ones. Config-only public site changes are observed too. This is a coalesced
change notification, not an audit stream of every intermediate transition.
Facility never periodically executes project scripts itself. An initial
observation emits both events; unchanged state emits neither.

API and worker must receive the same `FACILITY_PREVIEW_SITES` configuration.
Refresh **both** processes when manually changing a binding; a worker still using
old configuration cannot notify consumers about an API-only site change. Deploy
the migration before the new API/worker. Dynamic provider-backed sites should use
a shared persisted source when that follow-up is implemented.

`story_integration_notifications` persists observed revisions, pending events,
delivery lease, next attempt, sanitized error code and last accepted timestamp.
Workers claim a bounded lease, persist event identity before HTTP, and retry with
backoff (respecting GitHub rate-limit deadlines). A crash after acceptance can
redeliver the same eventId. Delivery is at least once while the destination remains
available, not exactly once; a later observation covers changes during a retry.
Errors do not block story work or count as a successful workflow execution.

Operate the worker and inspect failed cursors/log warnings. A project can also
run the same reconciler manually or on its own schedule, including previously
managed closed stories. This covers failed/missing consumer execution. The project
owns its Secrets, shared-client serialization, retry visibility and business rules.

## Provisioning is separate

This reads [operator-configured stable sites](workspace-preview-sites.md); it does
not create CloudFront distributions, change configuration secrets or prove login.
Automatic site provisioning remains a follow-up. Register a configured origin
before requiring app login readiness to avoid a circular dependency. Keep origins
reserved across sleep/reopen and never recycle them across workspaces.

Tests: `story-integrations.test.ts` and `story-integrations.integration.test.ts`
cover projections, namespace limits/CAS, real scoped authorization, persistence,
dispatch destination, repeated/error delivery, worker concurrency and no loops.
