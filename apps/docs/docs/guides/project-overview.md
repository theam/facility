---
title: Read the project overview
---

# Read the project overview

The overview is the first page of a project. It answers the questions an engineer has when
returning to a project: what is executing, what is waiting on a person, what recently finished,
what is waiting for review, what is still in the backlog, and what the agents are costing.

Opening the overview only reads persisted control-plane state. It never inspects a workspace
provider, wakes a suspended machine, or starts a turn.

## What each section means

**Needs your attention** lists everything that is blocked on a person, in the order to handle it:

- an agent that asked a question and is waiting for a reply;
- a failed or interrupted agent run that can be retried or dismissed;
- an open pull request whose checks failed; and
- a monthly budget that is exhausted or near its warning threshold.

Only open notices appear. Resolved and dismissed notices stay in each story's history. Reply,
retry, and dismiss use the same operations as the story page and require the
`workspaces:execute` permission.

**Running now** shows agent turns in the `running` state, how long they have been running, and
what activated them. Queued turns are listed separately: a queued turn is waiting for the
dispatcher and is not executing. A story in the `working` phase without a running or queued turn
does not appear here, because no agent is executing for it.

**Waiting for review** lists open pull requests from the GitHub mirror, linked to their Facility
story when the story recorded the pull request or was created from it. Failing checks come first,
then reviewable pull requests, then pending checks; drafts come last. A story that recorded a pull
request the mirror does not know yet is listed from the story with an unknown check state.

**Recent results** lists the last finished turns by completion time, with their duration, a link to
the run details on the story page, the linked pull request, and a readable summary of a failure.

**Backlog** shows the stories that are ready to start, the story counts by phase, and how many open
mirrored GitHub issues have no story yet. Start new work from the Stories page or from MCP.

## Spend and environments

The agent cost covers the current UTC calendar month, which is also the budget window, plus the
last seven days. It comes from provider usage reports or the price book and is an estimate, not an
invoice. The overview distinguishes:

- a real zero: no agent turns in the window;
- an unknown cost: turns ran, but none could be priced;
- a partial cost, shown as "at least": some turns were not priced or reported no usage; and
- a known cost: every turn in the window was priced.

The cost and budget sections follow the `costs:read` and `budgets:read` permissions. Members
without them see that the section is not visible for their role rather than a zero.

Workspace figures are the last recorded compute state, not a live inspection. A workspace recorded
as running may have been replaced or stopped by the provider since. Provider compute and storage
charges are not included; each story's environment view reports what the provider makes available.

## API

`GET /v1/projects/{projectId}/overview` returns the same projection for MCP and other clients. It
requires `projects:read`; the `spend.agents` and `spend.budget` sections report
`available: false` with `reason: "permission"` when the principal lacks the matching read
permission. Every list is scoped to the project and organization of the principal.
