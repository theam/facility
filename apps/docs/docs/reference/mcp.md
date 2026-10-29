---
title: MCP
---

# MCP

Facility serves Streamable HTTP MCP at `POST /mcp` from the control API. OAuth clients discover its
resource metadata at `/.well-known/oauth-protected-resource/mcp`. API keys use the same endpoint
with `Authorization: Bearer <key>`.

With OAuth enabled, the resource metadata names the canonical MCP endpoint and its authorization
server. Authorization-server metadata remains available at `/.well-known/oauth-authorization-server`
and `/.well-known/openid-configuration`; all three discovery endpoints are public. MCP tool requests
still require a valid bearer token.

The server exposes forty-four task-oriented tools:

| Tool | Result |
|---|---|
| `facility_list_projects` | Projects visible to the principal. |
| `facility_list_agents` | Valid `.agents/` catalog with engines, models, and triggers. |
| `facility_list_skills` | Valid skills installed in `.agents/skills/` or `.claude/skills/`. |
| `facility_list_stories` | Stories, optionally filtered by status. |
| `facility_get_story` | Story, workspace, turns, artifacts, attention, delivery PR set, plans/decisions, and ordered evidence timeline. |
| `facility_get_delivery` | Read the declared complete PR set, observed heads, CI/reviews and partial merges; optionally search the project's mirrored PRs. |
| `facility_set_delivery` | Replace delivery links with revision checking and idempotency; does not accept work, merge or run an agent. |
| `facility_get_workflow_policy` | Current opt-in plan/execution and delivery acceptance policy; changes require interactive Settings confirmation. |
| `facility_get_story_workflow` | Plan state, queued agents, hold reason and current/missing/stale delivery acceptance. |
| `facility_get_delivery_acceptance` | Immutable human acceptance receipt and whether it still matches the current exact candidate. |
| `facility_request_delivery_acceptance` | Request an expiring interactive review link for exact candidate and plan revisions; cannot confirm for a person. |
| `facility_get_delivery_integration_policy` | Current post-merge integration policy. |
| `facility_set_delivery_integration_policy` | Configure the integration mode with project and repository write permissions. |
| `facility_get_delivery_notice_policy` | Current in-app delivery notice preference. |
| `facility_set_delivery_notice_policy` | Configure actionable in-app delivery notices. |
| `facility_get_story_completion` | Candidate, integration, source close, compute suspension and retained storage as separate states. |
| `facility_record_delivery_integration` | Record integration evidence for the exact candidate; does not merge or complete a story. |
| `facility_request_story_completion` | Queue source close and compute suspension after all configured gates, including current human acceptance when required. |
| `facility_get_preview_convergence` | Desired/deployed exact candidate, progress and current readiness. |
| `facility_retry_preview_convergence` | Retry the current authorized preview generation; does not authorize a new scope. |
| `facility_get_plan` | Current plan, immutable scope snapshots and paged plan/decision history; optionally read an earlier revision. |
| `facility_propose_plan` | Record a revision with server-resolved repository names and fresh agent configuration; no execution. |
| `facility_request_plan_decision` | Request approval or changes and return an expiring interactive review link; does not record a human confirmation. |
| `facility_get_consultation_options` | Check configured API-text agents and exact source revisions without inference or workspace activity. |
| `facility_get_consultations` | Read saved consultation history or one result, provenance and billing state. |
| `facility_consult_story` | Request a separate paid text consultation with no tools or workspace access. |
| `facility_cancel_consultation` | Cancel a consultation while preserving any submitted usage. |
| `facility_prepare_consultation_handoff` | Return editable implementation context from a completed result; does not queue work. |
| `facility_start_story` | Idempotently create or resume a story and queue its first message. The title and agent are optional. |
| `facility_send_message` | Append a message and queue the selected agent. |
| `facility_get_conversation` | Read the shared ordered conversation. |
| `facility_get_environment` | Read runtime, services, readiness, endpoints, and recent events. |
| `facility_open_preview` | Wake and issue a short-lived authenticated preview handoff. |
| `facility_suspend_story` | Stop compute while preserving durable state. |
| `facility_archive_story` | Archive and suspend without deleting. |
| `facility_restore_story` | Restore the archived story and its existing state. |
| `facility_delete_workspace` | Explicitly destroy compute, volume, worktree, and engine sessions. |
| `facility_get_costs` | Read measured token use and cost by turn for a selected period. |
| `facility_get_budget` | Read the current monthly budget and amount spent. |
| `facility_set_budget` | Enable, change, or disable the project's monthly budget. |
| `facility_get_observability` | Read project health, usage, workspace, GitHub, and audit summaries. |
| `facility_list_backlog` | Read the unified backlog with phases, activity, assignees, search, filters, and pagination. |
| `facility_list_attention` | Read what is waiting on a person, newest first, with the action each notice accepts; filter by status, kind, and text. |
| `facility_sync_github` | Reconcile the project's GitHub mirror immediately. |

## Connect Claude Code or Codex

Register the same Streamable HTTP endpoint in either client. Replace the example origin with the
Facility deployment:

```bash
claude mcp add --transport http facility https://facility.example.com/mcp

codex mcp add facility --url https://facility.example.com/mcp
codex mcp login facility
```

Clients must explicitly request `facility:mcp` for the MCP resource. For offline access, Facility
collects consent and preserves `offline_access` in the refresh grant even when the client omits
`prompt=consent`. See [OAuth scopes and renewal recovery](../self-host/authentication.md#mcp-interactive-oauth)
if a previously authorized connection fails during refresh or rejects the callback issuer.

Claude Code starts its OAuth flow when the server is first used. Codex can also read a service API
key from an environment variable:

```bash
codex mcp add facility \
  --url https://facility.example.com/mcp \
  --bearer-token-env-var FACILITY_API_KEY
```

## Complete story flow

Claude Code, Codex, and any other MCP client send the same tool calls. Start or resume an issue-backed
story:

```json
{
  "name": "facility_start_story",
  "arguments": {
    "projectId": "proj_example",
    "provider": "github",
    "externalId": "issue:272",
    "title": "Persistent story workspaces",
    "agent": "builder",
    "message": "Implement the accepted story and verify it in its development environment.",
    "idempotencyKey": "issue-272-initial"
  }
}
```

Continue the same conversation, optionally choosing another repository-defined agent:

```json
{
  "name": "facility_send_message",
  "arguments": {
    "projectId": "proj_example",
    "storyId": "story_example",
    "agent": "pr-reviewer",
    "message": "Review the current branch and run the relevant checks.",
    "idempotencyKey": "issue-272-review-1"
  }
}
```

Open the running application, suspend compute, and later restore the same workspace:

```json
{"name":"facility_open_preview","arguments":{"projectId":"proj_example","storyId":"story_example","service":"app"}}
{"name":"facility_suspend_story","arguments":{"projectId":"proj_example","storyId":"story_example"}}
{"name":"facility_restore_story","arguments":{"projectId":"proj_example","storyId":"story_example"}}
```

Deletion is deliberately separate and permanent:

```json
{
  "name": "facility_delete_workspace",
  "arguments": {
    "projectId": "proj_example",
    "storyId": "story_example",
    "confirm": true,
    "idempotencyKey": "issue-272-delete-after-export"
  }
}
```

`facility_get_conversation` uses `after` and `limit` as a stable message-sequence cursor.
`facility_get_environment` uses the same fields for ordered workspace events and returns
`next_cursor` and `has_more`. Story and environment responses include typed attention, available
next operations, active-compute status, retained-storage status, provider usage, and an explicit
marker when monetary cost is unavailable.

`facility_list_skills` is an inventory operation. It does not install or upgrade skills. A story's
`timeline` combines Facility turn events, Git snapshots, artifacts, attention, and mirrored GitHub
branches, pull requests, reviews, and checks. `occurred_at` is the source event time and
`observed_at` is when Facility stored it; they can differ after reconciliation.

Execution mutations execute directly after normal authentication and project authorization.
Plan proposals and decision requests record metadata separately; they do not gate or dispatch
execution. Delete requires `confirm: true` and a matching idempotency key.

When a budget is enabled, Facility checks it before starting a provider call. Usage and cost are
recorded after the call from provider-reported values when available, otherwise from the built-in
model price book. A call already running may cross the limit; subsequent turns are blocked. Models
without a known price are rejected while budget enforcement is enabled.

## Propose and review a plan

Use `facility_get_plan` with `projectId` and `storyId` to read `state.revision` and
`state.decisionRevision`. Optional `beforeRevision`, `beforeDecisionRevision` and `limit`
page history; `revision` reads one immutable earlier plan. Reads use the database only.

`facility_propose_plan` accepts `expectedRevision`, exact `markdown` (at most 100,000 characters),
`repositories` (connected `owner/name` values), `agents` (configured names), optional
`sourceMessageId` and `idempotencyKey`. The server records the authenticated proposer and resolves
the repository/agent snapshot from the authorized source. An attributed source message must belong
to this story and contain exactly the proposed text. Editing it requires omitting the source ID.
A changed proposal supersedes earlier approval while preserving the old plan and receipts.

To request a decision, call `facility_request_plan_decision` with `expectedRevision`,
`expectedDecisionRevision`, `intent` (`approve` or `reject`), optional `reason` (required for
rejection), and `idempotencyKey`. Open the returned `request.confirmationUrl` in Facility, review
the exact plan and scope, and confirm explicitly. The locator URL contains no confirmation proof.
The request expires after 15 minutes. OAuth-user requests are bound to that user; service requests
can be reviewed by an authorized project writer.

There is no MCP confirmation tool. API keys and OAuth bearer identity alone cannot create an
interactive receipt. The browser confirmation rechecks membership, session proof, expiry, exact
plan and decision revisions. A concurrent decision or new plan requires a fresh review. Receipts
record the observed `interactive_session` method; software cannot prove physical human presence.

Reads need `projects:read`; proposals and decision requests need `projects:write`. Retry an
uncertain identical request with the same key. These records do not start agents, activate
execution-policy enforcement, merge PRs or accept delivery. Existing execution permissions and
repository merge controls continue to govern those actions.

## Consult without workspace actions

Read `facility_get_consultation_options` with `projectId` and `storyId`. It returns configured
agents, eligibility/reason, `manifestHash`, `catalogSha`, connected repositories and exact commits.
It uses bounded GitHub reads and starts no model call. The selected model must have a compatible
API identifier, reasoning settings and known price, plus its existing project provider API key.
A native CLI subscription login is not reused; Facility never substitutes a provider or model.

Call `facility_consult_story` with the selected `agent`, `expectedAgentHash`, `expectedCatalogSha`,
`message`, optional `sources` and `idempotencyKey`. Each source has `repository_id`, `commit_sha`
and a relative `path`. At most four regular UTF-8 files, 8 KiB each, are read at exact commits.
Symlinks, submodules, external LFS content and arbitrary URLs are rejected. The snapshot includes
bounded saved conversation and summary through the request's message watermark, agent guidance,
and source hashes. It also captures the story's current plan, recorded decision and complete
delivery PR observations in one local repeatable-read snapshot, identified by revisions, digest
and capture time. These are mirrored observations, with their existing freshness/unknown markers.
Plan text above 12,000 bytes is explicitly omitted while its digest/scope remain identified;
structured metadata above 32 KiB is rejected before a paid attempt. The combined prompt is bounded,
so explicit sources may need to be reduced. Confirmation proofs, cookies and pending review links
are excluded. Uncommitted workspace files, native sessions, environment and hooks are excluded.
There is no cross-story knowledge retrieval.

The `provider_api_text` executor sends one bounded request, with no tools, shell, native runtime,
MCP or GitHub capabilities. Reading a result does not rerun it. Use `facility_get_consultations`
with `consultationId`, or page history with `limit` and `offset`. Results distinguish queued,
preparing, running, succeeded, incomplete, failed and canceled. Usage can remain unconfirmed after
a lost response or worker failure; an estimate is not a measured charge. Cancellation cannot
undo already submitted model usage. Started calls are never automatically retried by recovery.
Retry uncertain submissions with the original body and key; changed intent needs a new key.

Options, paid requests and cancellation require `workspaces:execute`. History and handoff require
`projects:read`; monetary amounts also require `costs:read`. Authority and source connections are
rechecked before the call. Admission shares the project's native/title budget and uncertainty
checks; one consultation may be active per story, up to four across a project.

For a succeeded result with confirmed usage, `facility_prepare_consultation_handoff` returns text
with its ID and result hash. Review/edit that text, then explicitly use `facility_send_message`
and choose an implementation agent to start normal work. Preparing text approves no plan, accepts
no delivery and creates no native turn. A consulted answer is not implementation evidence.

## Record all delivery PRs

Read `facility_get_delivery` with `projectId`, `storyId` and `includeAvailable: true` to inspect
the current `scope.revision` and find PRs already in this project's GitHub mirror. Optional `q`,
`limit` and `offset` page the available PRs. Reading does not synchronize GitHub or wake compute.

Declare the full set explicitly, using the revision you just read:

```json
{
  "name": "facility_set_delivery",
  "arguments": {
    "projectId": "proj_example",
    "storyId": "story_example",
    "expectedRevision": 0,
    "declaredComplete": true,
    "pullRequests": [
      { "repository": "example/app", "number": 12, "required": true, "primary": true },
      { "repository": "example/api", "number": 34, "required": true, "primary": false }
    ],
    "idempotencyKey": "delivery-scope-first"
  }
}
```

This operation needs `projects:write`; reads need `projects:read`. A set has at most 50 PRs and
one required primary when nonempty. Related PRs use `required: false`. A legacy source PR alone
does not declare completeness. A concurrent edit returns 409; read the new revision and reconcile
the set before making a new request. Retry an uncertain identical request with the same key.

`candidate.revision` identifies the scope and all required heads. A changed required head changes
that identity; observation times and array order do not. `candidate.state` distinguishes an
incomplete scope, missing heads, stale observations and a recorded revision. GitHub observations
older than 30 minutes are stale. CI for a different head is retained with `checks.current: false`;
missing CI is `unobserved`. Reviews retain their source state and commit; bounded samples are
marked `partial`. Reviews without a commit, or without an observed PR head, remain unverified;
`unverifiedHeadCount` includes these alongside reviews on other commits. GitHub remains
authoritative for required checks, review requirements and
branch protection. Neither the candidate identity nor all PRs being merged constitutes acceptance
or integration verification. Registering this set does not alter the existing source PR lifecycle.
