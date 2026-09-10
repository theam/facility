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
