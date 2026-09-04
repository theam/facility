---
title: Operate a story
---

# Operate a story

MCP is the primary way to automate a Facility story. The web UI exposes the same state and remains
useful for browsing conversations, inspecting environments, opening previews, and taking lifecycle
actions.

## Start a story

Before starting, identify the project, the agent, and the body of work. For GitHub work, use a
stable external id such as the issue id. For an ad hoc request, Facility can create a manual id from
the idempotency key.

An MCP client normally follows this sequence:

1. `facility_list_projects`
2. `facility_list_agents`
3. `facility_list_skills` when the task depends on project-installed capabilities
4. `facility_start_story`
5. `facility_get_story` or `facility_get_conversation` until the first turn settles

Use a new idempotency key for a new start request. Reuse the same key only when retrying the exact
same request after an uncertain network result.

The selected agent must be enabled and include an `mcp` trigger. A story started from the web UI
requires a `ui` trigger. Facility records the source rather than treating them as separate story
types.

## Continue the shared conversation

Send another message with `facility_send_message`. You can select a different configured agent for
the next turn; the conversation, worktree, and native engine state remain attached to the story.
Messages sent while a turn is active wait in order.

Use `facility_get_story` to inspect status and `next_operations`. Use
`facility_get_conversation` with its cursor for durable message history. The UI renders the same
conversation and can continue it under the current user's project membership.

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
retains files written there as story artifacts. Use an authenticated preview to interact with a
declared service from your own browser. Preview sessions are expiring and revocable; they do not
make the workspace port public.

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
