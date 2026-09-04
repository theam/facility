---
title: Story lifecycle
---

# Story, turn, and workspace lifecycle

Facility separates delivery state, agent execution state, and compute state. A done story can have
a sleeping retained workspace; a failed turn can leave a running environment; an archived story
can later be restored with the same conversation.

## Story states

| State | Meaning |
| --- | --- |
| `ready` | The story exists and can accept work. |
| `working` | A turn is queued or running. |
| `attention` | Work needs a user reply, retry decision, or dismissal. |
| `review` | Delivery is waiting on pull-request review or checks. |
| `done` | The linked delivery has completed, normally after merge. |
| `archived` | The story is retained outside the active workflow. |

The API returns `needs_attention` plus `next_operations` so clients do not have to infer every
action from the state string. Attention items are retained as history after retry or dismissal.

## Turn states

| State | Meaning |
| --- | --- |
| `queued` | The persisted message is waiting for dispatch. |
| `running` | A worker has claimed the turn and the engine is active. |
| `succeeded` | The engine completed normally. |
| `failed` | Dispatch, environment preparation, or engine execution failed. |
| `canceled` | An authorized user canceled the active work. |

Only one queued or running turn is permitted per story. Later messages remain pending in
conversation order and are promoted after the active turn settles. Retrying creates another
attempt; it does not erase the failed turn.

## Turn evidence

After environment preparation and before the engine starts, Facility records the selected agent,
engine, model, Facility session id, resumable native session id when one exists, workspace and
provider, branch, and initial Git SHA. The session id is allocated before execution so a failed
engine start still has a stable identity.

When execution returns, fails, or is canceled, Facility reads the workspace again and records the
final branch and SHA, commits since the initial SHA, tracked and untracked changed files, and dirty
worktree state. Evidence capture failure is recorded separately and does not replace the engine's
own outcome. Limits protect the control plane from unbounded histories: at most 500 commits and
2,000 changed files are stored for one turn, with truncation marked in the event.

GitHub branches, pull requests, reviews, and checks are observed through webhooks and periodic
reconciliation. A matching final SHA links the fact to an exact turn. Facts that can be associated
only through the story's branch, pull request, or closing issue remain story-level external changes
rather than being attributed to an agent.

Before the engine starts, Facility also compares the changed files recorded for this story with
the changed files of every other active story in the project that has an open branch. Stories that
are done, archived, deleted, or whose branch belongs to a merged pull request are ignored. When two
stories touched the same paths, a `story.collision_detected` fact is recorded on the timeline for
each overlapping story, with up to 20 overlapping paths and the total count, and the prompt tells
the agent which paths other open branches are changing. The check is advisory: it never blocks or
fails a turn, does not create attention, and a story with no completed evidence yet cannot collide
because its files are not known. A detection failure is recorded as `turn.collision_check_failed`.

The story response orders these facts with turn activity, artifacts, attention, and creation in a
single timeline. Source time and observation time are both retained because an event discovered by
reconciliation may be older than the time Facility first saw it.

## Workspace states

| State | Meaning |
| --- | --- |
| `creating` | Provider compute and durable storage are being prepared. |
| `running` | Compute is available and the environment can be prepared or exposed. |
| `sleeping` | Compute is stopped; durable storage and provider references remain. |
| `error` | A provider or preparation operation failed; retained state may still be recoverable. |
| `destroyed` | Explicit deletion removed the durable workspace. |

The runtime provider implements create, wake, execute, expose, inspect, suspend, and destroy. A
Docker workspace uses a named volume independent of its replaceable container. Vercel uses durable
snapshot-backed state while renewing finite compute leases.

## Operations

### Send message

Persists a user message and either queues a turn or leaves it waiting behind active work. The agent
may differ from the prior turn. A sleeping workspace wakes as part of dispatch.

### Cancel turn

Stops active engine work and records a canceled turn. It does not revert files, commits, commands,
or external GitHub effects that already occurred.

### Retry or dismiss attention

Retry asks Facility to attempt recoverable work again. Dismiss closes an obsolete attention item.
A waiting-agent item is normally resolved by a user reply.

### Clean setup

Prepares the existing workspace with setup forced even when the checksum matches. It does not
discard the repository worktree. The seed command runs after forced setup when declared.

### Browser test

Prepares the environment, runs the declared browser test, and records files from
`FACILITY_ARTIFACT_DIR`. It does not create a separate deployment.

### Suspend

Stops replaceable compute and retains story state, worktree, environment files, artifacts, and
native engine sessions. A later turn wakes the workspace.

### Archive and restore

Archive changes workflow visibility and may suspend compute. Restore returns the retained story to
active use. Neither operation destroys the workspace.

### Merge transition

A merged linked pull request marks the story done and suspends compute. Facility retains the
conversation and workspace so follow-up work remains possible. Facility does not perform the merge
as a lifecycle side effect.

### Delete workspace

Permanently destroys the selected story workspace. The HTTP operation requires `confirm: true` and
an `Idempotency-Key` header identical to the body `idempotency_key`. MCP applies the same explicit
confirmation contract. Deletion does not mean deleting the GitHub branch or pull request, but local
uncommitted files and native engine session data on the volume are lost.

## Retention policy

Facility does not automatically delete workspaces after merge, archive, error, or inactivity.
Operators must monitor active compute and retained storage, define backup and retention rules, and
use deletion deliberately. Project budgets and cost views support that decision but do not turn
unknown provider pricing into zero.
