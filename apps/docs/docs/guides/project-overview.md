---
title: Review Attention and follow project activity
---

# Review Attention and follow project activity

Every project opens in **Attention** (`/projects/{projectId}`). It groups pending
plans, recorded notices and delivery sets by story, with every other observed
open PR in its own paged list. A project with no open notices can still have a
plan or delivery to review. An unavailable read is shown as an error, never as
an empty queue.

**Now** appears for verified project conditions that hold new work, such as
exhausted or unconfirmed spending or an invalid workflow policy. It explains the
observed effect and links to the relevant spending or policy view. A budget
warning is labelled for the next review; it does not by itself stop work. These
conditions appear once for the project. Ordinary reviews appear directly in the
list, with a labelled color accent for plan, delivery or notice. Color does not
imply urgency. **Filters** opens search and category controls; **More views**
contains activity and notice history. **Queue details** contains the full counts
and observation time. Active filters stay visible on arrival and can be cleared.
The view does not infer a recipient, deadline or urgency from agent text.

**Attention** and **Stories** are the primary project navigation. **Activity**,
**Insights** and **Settings** remain one step away under project tools. Settings
links to agents and skills, workflow policy, repositories, and budget and usage.
Agent configuration still uses its existing repository review flow. On narrow
screens, open **Menu** for these same destinations; Escape closes it and returns
to the menu button.

Reading these pages does not inspect a workspace provider, wake a suspended
machine, start a turn or confirm a decision. Attention refreshes on request so
that its rows do not move while being read. Story reviews retain the linked
revision even when a new plan arrives.

## Read every notice

**All notices** (`/projects/{projectId}/attention`) keeps the existing notice
search, kind filters and 25-item pages. It lists recorded questions, failures
and other notices with their own reply, retry or dismiss operations. Those
operations use the same domain and `workspaces:execute` permission as the story.
Plans, delivery reviews and project conditions remain in Attention rather than
being counted again as notices.

**Resolved notices** keeps answered, retried and dismissed notices readable
with how and when each closed. Resolved notices offer no actions; open the story
to continue. Old links to the notice list and the Attention pilot
(`/projects/{projectId}/attention/review`) still work. The pilot uses the same
page as the project entry; filtering and pagination lead to the canonical entry.

## Follow execution and results

**Activity** (`/projects/{projectId}/activity`) preserves the execution, recent
results, backlog, spending and retained-environment views from the previous
Overview. Its activity snapshot lists recorded running and queued turns with
elapsed time and trigger. Queued work has not started; this snapshot does not
establish whether it is waiting for capacity, preparation, policy or another
turn. Open the story for its recorded blocker. An open story with no running
turn is not automatically waiting for a person.

**Recent results** lists finished turns with duration, readable failures, linked
PRs and run details. A finished turn does not establish delivery acceptance.
**Backlog** shows ready stories and phase counts, plus mirrored GitHub issues
without a story. **Stories** remains the complete searchable inventory and the
place to create work. **Attention** is the place to review current plans and
delivery candidates.

## Spend and environments

The agent cost covers the current UTC calendar month, which is also the budget window, plus the
last seven days. It comes from provider usage reports or the price book and is an estimate, not an
invoice. Activity distinguishes:

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

`GET /v1/projects/{projectId}/overview` returns the persisted activity projection used by Activity, MCP and other clients. It
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


## Review pending stories

The project entry groups open notices, pending formal
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

The list shows a short plan summary. Open the review for the recommendation,
risk and sources; expand **Alternatives and sources** for the options and their
comparison or diagram. These are author statements, not independently verified facts.
**Review plan rN** opens that exact saved revision and digest. A newer plan does
not replace the linked content on refresh. Historical or unverifiable revisions
remain read-only; choose **Open current plan** explicitly before deciding the
newer scope. **Open original message and author** reads the source message even
when it is outside the recent conversation, preserving the selected plan. The
existing confirmation flow remains on the story. Each notice keeps its own action there.

### Review the complete delivery

Expand **Delivery details** or open the delivery review to see every registered PR, which ones are required and primary,
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
