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

**Needs your attention** counts everything that is blocked on a person and shows the latest five:

- an agent that asked a question and is waiting for a reply;
- a failed or interrupted agent run that can be retried or dismissed;
- an open pull request whose checks failed; and
- a monthly budget that is exhausted or near its warning threshold.

A budget alert comes first because it stops every agent; everything else is newest first. Each
entry keeps its verb inline: reply, retry, dismiss, or open the pull request or budget. **View all**
opens the attention page with every notice. Reply, retry, and dismiss use the same operations as
the story page and require the `workspaces:execute` permission.

## Read every notice

The attention page (`/projects/{projectId}/attention`) lists every notice newest first, 25 per page.
Search matches the notice and its story title; kind filters narrow it to, for example, agents
waiting for a reply or failed runs. The **Open** view starts with the pull requests whose checks
failed and any budget alert, so it holds everything the overview counts. Those entries are live
state and clear on their own once the checks pass or the budget allows new turns.

The **Resolved** view keeps answered, retried, and dismissed notices readable with how and when
each one closed. Resolved notices offer no actions; open the story to continue the work.

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

`GET /v1/projects/{projectId}/attention` returns the notices behind the attention page, newest
first. It accepts `status` (`open` by default, `resolved`, or `all`), repeatable or comma-separated
`kind`, `q` for words, and `limit`/`offset` pagination (25 by default, at most 100). The response
carries `total` for the filtered set, `counts` of open and resolved notices matching the search
and kind filters, and `facets.kinds` for the chosen status and search. Each open notice names the
action it accepts (`reply`, `retry`, or `dismiss`); resolved notices carry `resolution` and
`resolvedAt` instead. It requires `projects:read`. MCP clients use `facility_list_attention`.


## Review pending stories (preview)

From Attention, choose **Review pending stories**. The preview at
`/projects/{projectId}/attention/review` groups open notices, pending formal
plans and delivery sets by story, oldest pending item first. A plan can appear
without a notice. An approved or rejected current plan is not pending; a newer
proposal appears again. Several notices in one story remain separate actions.

Counters describe the entire filtered set, not just the visible page. Search
matches story titles, open notice text, PR titles and repository references,
then keeps all pending information for each matching story. Categories select
stories with plans, notices or deliveries, or the other open PR inventory.
Deleted stories are excluded. Delivery sets in done or archived
stories remain on their history, outside this queue. No recipient, severity or
deadline is inferred.

Expand the saved author's plan brief for the recommendation, alternatives, risk
and sources. These are the author's statements, not independently verified facts.
**Open current plan** reads the current story: compare its revision with the
observed revision before deciding. The exact original and existing confirmation
flow remain on the story. Each notice keeps its own action there.

### Review the complete delivery

The delivery card shows every registered PR, which ones are required and primary,
the observed heads, and whether the recorded checks belong to those heads.
A registered candidate does not mean CI passed. Drafts, stale observations,
unobserved checks and checks from a previous head stay distinguishable.
Legacy primary PRs do not silently become a declared complete delivery set.

Acceptance is shown separately as missing, current or stale. Its binding uses
the same domain rules as the existing request and confirmation flow: required
heads, delivery scope, plan, policy and current authority of the accepting member.
Changed heads or revoked authority make a prior receipt historical. Suspending
compute alone does not invalidate acceptance. When policy requires it, requesting
acceptance still needs the exact current candidate recorded as ready and served.
The card distinguishes the desired preview, last recorded served preview and
accepted candidate. It neither wakes the environment nor claims a live inspection.

A delivery remains in this queue while its active story has open or unobserved
PRs, an incomplete or stale candidate, or outstanding required acceptance. This
is an inspection inventory, not a claim that every row requires immediate human
action. An eligible candidate does not grant the viewer permission to accept it.
**Review delivery** opens the current story and its existing authorized actions.
PR links open GitHub's current state; compare the heads before deciding.

### Project limits

An exhausted budget or unconfirmed spending appears once above the story list,
with the effect on new model calls. Work already running is separate. A warning
threshold remains a warning. Missing budget permission is shown as unavailable,
not as zero, and unconfirmed spending is not presented as a complete known cost.
An invalid workflow policy directs the reader to project settings without
inventing acceptance eligibility.

### Other open pull requests

The same snapshot includes every observed open PR outside the active delivery
sets. Those PRs have their own count and pagination, without the overview's
latest-item limit. PRs in active delivery cards are excluded from this list
before filtering or pagination. A PR linked to a done, archived or deleted story
still appears here if the mirror says it is open. Deleted story details are
excluded. Existing source or delivery associations remain readable as context;
a source association does not declare a complete delivery set.

Drafts, unobserved checks, outdated observations and checks at an old head remain
distinct. Each row shows its observed head and update/observation times. The list
uses the recorded GitHub mirror, not a live provider refresh or a claim that all
repository PRs have been synchronized. Search treats `%` and `_` literally.
Story and PR pages retain each other's position. Changing filters starts both
at the first page. On explicit refresh, a PR moves between the two populations
if its story's delivery becomes active or historical.

Opening the queue creates no confirmation request, model call, turn or workspace
operation. Refresh explicitly after reading; the page does not reorder while
reviewing a brief. An empty selection does not mean all project work is complete;
open Stories to follow ongoing work. The existing notice list retains resolved
history. A failed or denied read is shown as an error, not an empty queue. An
older response without the other-PR inventory shows it as unavailable, not zero.

`GET /v1/projects/{projectId}/attention/stories` and MCP
`facility_list_attention_stories` share this projection and require
`projects:read`. Parameters: `category` (`all`, `plans`, `notices`, `deliveries`,
`pulls`), `q`, `limit` (default 10, maximum 25 items per list), `offset` (stories)
and `pullOffset` (other PRs, default 0). The existing top-level `total`, `items`
and `counts` remain story counts and details. `otherPullRequests` has its own
`total`, `limit`, `offset` and `items`. Both populations and revision details
come from one read-only database snapshot. Delivery metadata
is fetched in batches for complete counts; only the page's plan Markdown is
loaded. The response includes the project budget only with `budgets:read`.
Existing notice API and MCP contracts are unchanged.
