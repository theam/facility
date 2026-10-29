---
title: Operate a story
---

# Operate a story

MCP is the primary way to automate a Facility story. The web UI exposes the same state and remains
useful for browsing conversations, inspecting environments, opening previews, and taking lifecycle
actions.

## Find work

The Stories page is the project's backlog. It lists mirrored GitHub issues that nobody has started
next to work started from a request, one entry per unit of work, and groups open entries by phase:
needs attention, in progress, in review, not started. Done and archived work stay one filter away.
Search accepts a ticket number (`#42`) or words; labels, assignees (including "assigned to me" and
"unassigned"), repository, and sort combine, and every combination is a shareable URL. Listing the
backlog never starts an agent or wakes a machine. `facility_list_backlog` returns the same view.

Each entry shows the phase, what is actually happening (a running or queued agent, a waiting
question, failing checks, a review decision), who is involved, and links to the issue, pull
request, story, and active run. Assignees from GitHub and people who started or continued the
story in Facility appear together; neither source removes the other.

## Start a story

Describe what you need in the request box. A title is optional: Facility stores the request at
once under a provisional title and generates a short title afterwards with the project's
configured provider credentials, honouring the project budget. If generation is slow or fails, the
provisional title stays and the page says so; the request is never lost or duplicated.

Choosing an action is optional too. Actions are the agents the repository defines in `.agents/`;
each runs on an engine (Claude Code or Codex) from a provider (Anthropic or OpenAI). Without a
choice, the project's default runs: the enabled agent that accepts requests from that surface,
`builder` when present. Starting from a not-started issue keeps the issue's title and links the
story to it, so the issue does not appear twice.

For MCP, identify the project and the body of work. For GitHub work, use a stable external id such
as the issue id and, for a related repository, its `repositoryId`. For an ad hoc request, Facility
can create a manual id from the idempotency key.

An MCP client normally follows this sequence:

1. `facility_list_projects`
2. `facility_list_agents`
3. `facility_list_skills` when the task depends on project-installed capabilities
4. `facility_start_story`
5. `facility_get_story` or `facility_get_conversation` until the first turn settles

Use a new idempotency key for a new start request. Reuse the same key only when retrying the exact
same request after an uncertain network result.

The selected agent must be enabled and include an `mcp` trigger. A story started from the web UI
requires a `ui` trigger. When no agent is named, the same rule picks the default for that surface.
Facility records the source rather than treating them as separate story types.

## Continue the shared conversation

Send another message with `facility_send_message`. You can select a different configured agent for
the next turn; the conversation, worktree, and native engine state remain attached to the story.
Messages sent while a turn is active wait in order.

In the web UI, **Reply** reveals the story composer, selects the requested available agent and
focuses the message without sending it. It preserves text already being written. **Close** hides
the composer and retains the draft; **discard draft** explicitly clears it. Reopening the composer
returns to the same text.

When tab storage is available, unsent drafts can be restored for up to 24 hours after their last
edit in that browser tab. They are scoped to the signed-in person, organization, project and story;
another person's session or another story does not restore that draft. They are not synchronized
between devices or tabs. Closing the tab clears its session storage. If browser storage is
unavailable, the draft remains in memory while the page stays open. Only **send to agent** submits
it to Facility. Successful sends clear only the exact submitted draft; a late receipt cannot erase
newer edits restored after navigation. Explicit discard clears the current draft. Reopening retains
the recipient you selected; only another explicit Reply changes its target.

If the selected agent is removed or disabled, the draft remains available and sending requires
choosing an available agent. A failed send preserves the text and recipient. Retrying the same
unchanged request reuses its idempotency key, including after restoring the draft; editing the
message or choosing a different recipient creates a new request.

Use `facility_get_story` to inspect status and `next_operations`. Use
`facility_get_conversation` with its cursor for durable message history. Each agent message is the
run's final response; progress messages and logs live in the run's activity
(`/turns/:turnId/activity`). The UI renders the same conversation as request-and-response
exchanges and can continue it under the current user's project membership.

The story timeline is the review path across the whole delivery. It shows which agent, model,
session, workspace, branch, and initial SHA started each turn; the final SHA, commits, files, and
dirty state; artifacts and attention; and the mirrored branch, pull request, reviews, and checks.
An entry linked to a `turn_id` has an exact Facility attribution. An `external` GitHub actor means
Facility associated the event with the story but could not prove that a particular turn produced
it.

When the story needs attention:

- reply when the agent is waiting for information;
- retry an attention item after its external cause is fixed;
- dismiss it when it is no longer relevant; or
- cancel the active turn if continuing would be wasteful or unsafe.

Canceling a turn does not roll back files or commits already written in the workspace.

## Ask a read-only consultation

In **Ask about this task**, choose **New consultation**, review the configured agent/model and
enter a question. You can select up to four committed source files, each at an exact SHA. Refreshing
options does not move a selected commit. The paid text executor uses saved task context and those
files; it cannot access workspace files, native sessions, hooks or tools. A compatible project
provider API key is required. An unavailable configuration stays unavailable without a substitute.
The agent definition prompt and the larger saved task/source context have separate size limits.

**Close consultation draft** keeps a separate draft for the same person, task and browser tab,
using the same 24-hour storage limit as the normal composer. A failed submission preserves its
original body/key for **Retry original consultation**. **Edit as a new request** explicitly creates
a new intent. Refreshing history or preparing implementation starts no model or native turn.

Inspect the saved result and **Snapshot and provenance** for source commits, hashes, watermark
and omissions. Results render as text. **Cancel consultation** records cancellation; submitted
usage may still be billed. An unconfirmed charge stays unknown, including when an admission
estimate exists. Incomplete, failed or canceled consultations are not completed implementation.

**Prepare implementation request** opens a separate editable composer with the completed result's
ID and hash. Review the text and recipient, then choose **send to agent** to queue normal work.
This action follows the existing execution permissions; preparing the draft itself starts nothing
and does not confirm a plan or accept delivery.

## Agree on a versioned plan

The story's **plan and decisions** panel shows the proposed text, repositories and configured
agents. Choose **Propose plan** or **Propose revision**, or **Propose as plan** on an agent response.
Using a response asks before replacing an open draft. Editing its text removes source-message
attribution. Select scope by readable names and save the proposal; no agent is started.

Choose **Review approval** or **Request changes** (with a reason). The next page shows the exact
revision, text and scope before the explicit confirmation button. An approval applies to that
revision only. A newer proposal retains the old receipt as history and awaits its own decision.
Concurrent edits and decisions require a fresh review; failed saves preserve the draft and reuse
the same retry key. Open **Plan and decision history** to inspect earlier revisions and receipts.

Decision requests from MCP return the same interactive review link. Open it with an authorized
Facility browser session before its 15-minute expiry. A service key or OAuth token alone does not
confirm it. Confirmation records the session's user and server time. Under the project's workflow
policy, an approval can immediately release queued agents whose exact configuration and full
repository scope match the plan. It does not approve a GitHub review or accept final delivery.

### Require approval before execution

In **Project settings → workflow approvals**, choose the configured agents that need an approved
plan. Review the settings, then confirm them in your Facility browser session. Configuration needs
both project and repository write access; an API key or OAuth bearer token cannot confirm it.
Existing projects retain their prior behavior until a policy is explicitly enabled.

The common native admission boundary checks the current approved plan before reserving budget
or starting native execution. A new story cannot create or wake a builder workspace without its
required approval; start with an ungated analyst or propose the plan on an existing story first.
All native agents retain access to every connected project repository, so an execution-approved
plan must include the full current project repository set and exact selected agent configuration.
This policy does not create per-agent tool permissions or verify semantic code-to-plan alignment.

Held messages stay queued with a visible reason. A new approval can release them; the durable
worker recovery sweep retries if queue publication is unavailable. New plans, rejected decisions,
changed agent/repository scope or revoked authority invalidate the old execution authorization.
Running turns recheck it through their heartbeat. Optionally require a new plan approval after
failed or canceled work before the next agent can proceed. Policy changes wait for running native
turns to finish or be canceled, and explicitly disclose their effect on queued work.

Enable policies only after API, worker, MCP and web have all completed the coordinated upgrade.
An older worker does not implement the new admission gate.

### Accept the exact final delivery

The story's **approvals and acceptance** panel separates plan approval from final delivery
acceptance. Declare the complete required PR set and refresh its heads, then choose **Request
delivery acceptance**. Open the returned review link, inspect every required PR and exact head,
and explicitly choose **Accept this exact delivery**. The request expires after 15 minutes.
MCP can request that same link and read its status; it cannot confirm acceptance for a person.

The receipt binds the candidate, PR-set scope, plan and decision revisions, and project policy.
Concurrent confirmations create one current receipt. New heads or scope/plan/policy changes make
earlier acceptance historical; they do not delete it. Revoked acceptor authority also prevents
using the receipt for completion. When configured, a ready preview must match this exact candidate
at request and confirmation. Suspending retained compute afterwards preserves an otherwise
current acceptance. This is an interactive review record, not proof that a person opened a preview.

When acceptance is required, the server checks it both when completion is requested and again at
the worker's protected source-issue close boundary. Acceptance itself does not merge PRs, deploy
software, close an issue or delete storage.

## Review the complete PR set

The story's **delivery** panel lists every registered PR, its required or related role, the
primary, observed head, merge state, CI and review commits. A legacy source PR is shown as an
association until someone explicitly declares the full set. One merged primary does not prove
that all required PRs merged.

With project write access, choose **Edit PR set**, find PRs in the project's GitHub mirror and
select one required primary. Mark which PRs are required and confirm **These are all the PRs
required to deliver this story**. Saving records metadata and history. With workspace execution permission, **Save PR set and update preview** also authorizes Git updates and app rebuild/restart for this scope revision, retaining data. Saving does not start an AI agent, accept work or merge a PR. Changing links clears the editor's completeness confirmation.

An automatic page refresh preserves unsaved selections. If somebody changes the saved set, a
save reports a conflict and retains your edits. **Reload saved set (discard edits)** explicitly
replaces them with the current saved set. Retrying an unchanged failed save reuses its request key.

The panel uses mirrored GitHub observations. CI on an older commit is labelled separately from
CI on the current head; missing CI remains unobserved. Expand reviews to inspect their source
states and commits. Stale observations require GitHub reconciliation before delivery can be
evaluated. The observed revision identifies the required heads without requiring you to enter
commit hashes. GitHub still controls required checks and branch protection.

`facility_get_delivery` and `facility_set_delivery` provide the same register over MCP. See the
[MCP reference](../reference/mcp.md#record-all-delivery-prs) for revision, completeness and retry
semantics. The register preserves the existing source PR association and lifecycle; a source PR
merge can still mark the story done while the delivery panel shows other required PRs outstanding.
Acceptance, integration and all required merges remain separate facts.

Preview execution requires `workspaces:execute`. Saving a delivery with that permission delegates
convergence for that scope revision; a metadata-only writer can register the set, then an executor
must review it and use **Retry preview**. A changed set needs fresh execution authorization.
Webhook head updates retain the authorization for the same set; workers recheck the authorizer's
current role or key before executing and while refreshing.

Facility reconstructs each candidate from the configured development branch (default branch when
unset) and the complete current required heads. Superseded or removed heads are excluded. Displaced
local commits remain reachable under `refs/facility/retained/`; tracked local edits block publication
until saved. Checkout refuses to overwrite ignored or untracked retained paths. Suspension and
recovery preserve the volume and native sessions. Recovery retires abandoned compute and binds each attempt to its immutable provider identity, so delayed commands or stops cannot target a replacement. The next builder attaches to the converged revision, preserving the displaced branch under the retained refs. Dependency setup may rerun for new code; creation-only seed runs only on initial preparation or explicit clean setup.


## Complete the source issue

The completion panel separates the merged delivery, the configured post-merge integration and
the source issue. Manual integration remains a human-recorded result. Repository dispatch waits
for a result from the exact dispatched event. Completion requires both `projects:write` and
`github:write`; changing integration policy requires both `projects:write` and `repos:write`.
Ordinary project preferences preserve these policies.

Repository-dispatch callbacks must set `event_id` to the `eventId` received in the
`facility.delivery.merged` payload (`eventId` in MCP). A destination change or policy re-enable
creates a new event. Identical terminal retries preserve the original receipt; conflicting
terminal results are rejected. Manual integration uses a null event ID.

Before the bounded GitHub close request, Facility rechecks the current candidate, integration,
source binding and requesting principal. Delivery/policy mutations and local mirror updates are
fenced through that request. A close response cannot replace a newer source observation, including a same-timestamp reopen. When the source changes, completion fails visibly and requires a fresh explicit request; automatic recovery cannot close it again. Closing an issue, suspending compute and retaining storage remain
separate recorded results; this action does not merge PRs or delete persistent storage.

## Inspect and test the environment

The environment view reports workspace state, provider inspection, setup and wake timing, events,
retained storage, and any usage values available from the provider. A missing cost value means
provider pricing is unavailable, not that the workspace is free.

Use clean setup when you need to prove that the declared setup works without its previous setup
cache. It may rebuild dependencies or development data, but it does not delete the worktree.

Use browser test to run `environment.browser_test`. Facility sets `FACILITY_ARTIFACT_DIR` and
retains files written there as story artifacts. The operation reuses the agent's prepared
workspace, starts services only when needed, and does not synchronize Git or rerun setup or seed
when the agent changes HEAD. A missing test command or an unprepared workspace is rejected
before execution; use clean setup explicitly when preparation is needed.

Use an authenticated preview to interact with a
declared service from your own browser. Preview sessions are expiring and revocable; they do not
make the workspace port public.

## Share development environment variables

Open **project settings → project environment variables** to add or replace a value, remove a
variable, or paste a `.env` file. These defaults apply to every current and future workspace in
that project, for both agents and app services. Keep workspace-specific database addresses and
credentials in each workspace instead of sharing them across projects.

Open **environment variables** in a story to configure workspace overrides. An override takes
priority over its project default; removing it restores the inherited value. The editor lists the
inherited names and links to project settings. Imports replace only the provided names.

Values are encrypted in Facility's database and never returned to the browser. Reading requires
`workspaces:read`; changes require `workspaces:execute` in the project. Runtime and agent
credential names are reserved. Ordinary project settings cannot read or replace this secret store.

Defaults and overrides are delivered to new agent runs, app service starts, and browser tests,
including names not declared in `.facility.yml`. They take precedence over operator-declared
project variables. Saving does not rewrite repository files, run setup, reseed data, or interrupt
a running agent. Existing processes retain their environment: after the active turn has finished,
use **suspend compute** followed by **open app** to start the app with new values in the same
retained workspace.

The API supports `GET` and `PATCH` at:

- `/v1/projects/{projectId}/environment/variables` for project defaults.
- `/v1/projects/{projectId}/workspace-stories/{storyId}/environment/variables` for overrides.

Read the current `revision`, then PATCH `{ revision, variables: { NAME: "value", OLD_NAME: null } }`
or `{ revision, dotenv: "NAME=value" }`. An outdated revision returns 409 to prevent overwriting
another editor's changes. Responses contain names and revision metadata only.

## Work with GitHub

Agents use Git and `gh` inside the workspace. A normal delivery leaves a reviewable branch and pull
request. The GitHub mirror shows current issues, branches, pull requests, reviews, checks, and
workflow runs after webhooks or periodic reconciliation. Use `facility_sync_github` when waiting
ten minutes for the next scheduled pass would slow an investigation. Reconciliation also records
changes made directly in GitHub or by tools outside Facility.

Facility does not merge on behalf of the story lifecycle. A merged pull request marks a linked
story done and suspends compute. Branch protection and required review remain the merge boundary.

## Suspend, archive, restore, and delete

- **Suspend** stops compute and retains the active story, volume, and conversation. The next turn
  wakes it.
- **Archive** retains the same data but removes the story from the active workflow.
- **Restore** makes an archived story active again and wakes compute when work requires it.
- **Delete workspace** permanently removes the durable workspace. It requires explicit
  confirmation and a matching idempotency key.

Archive a completed story when it may still be useful. Delete only after the pull request, commits,
artifacts, and any uncommitted files have been preserved elsewhere. See the [lifecycle
reference](../reference/lifecycle.md) for exact state transitions.

## Watch cost and budget state

Story work produces usage and cost records when the provider reports them. Project cost and budget
views aggregate this history, while workspace environment metrics distinguish running compute from
retained storage. Set project budgets as an operating control and investigate missing pricing or
usage data instead of interpreting it as zero.
