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
| `queued` | A persisted request or scheduled follow-up is waiting for dispatch. |
| `running` | A worker has claimed the turn and the engine is active. |
| `succeeded` | The engine completed normally. |
| `failed` | Dispatch, environment preparation, or engine execution failed. |
| `canceled` | An authorized user canceled the active work. |

Only one queued or running turn is permitted per story. Later messages remain pending in
conversation order and are promoted after the active turn settles. Retrying creates another
attempt; it does not erase the failed turn.

## Agent progress and follow-ups

The conversation shows saved agent updates under the original request as the engine emits them.
Open **Run details** for commands, tool activity, and other execution evidence.

Interactive Claude Code and Codex turns with a current execution authorizer have a built-in
`schedule_followup` tool. Use it when an assignment depends on asynchronous work. Supply
`delay_seconds` (30 to 3,600), a short user-visible `reason`, and `context` with the next action
and any non-secret job references. Keep links, credentials, and command output out of the handoff.
Wait for the tool's confirmed timestamp before wrapping up the turn.

After the current turn succeeds, the conversation shows **Waiting…** and the next check time.
The worker checks due follow-ups on its normal recovery tick and on startup. Facility resumes the
same agent's native session in the same retained workspace and displays its updates and response
under the original request. Scheduling keeps the workspace awake. A workspace suspended while
waiting wakes through normal dispatch.

A request can schedule one automatic follow-up. Facility checks the original authorizer, agent
identity, workflow gates, and budget again at admission. It stops attempting dispatch 15 minutes
after the due time. A follow-up that fails requires a person to continue the assignment. Use
**Cancel** while waiting, or send a new request to take over. Archiving cancels a pending
follow-up and restoring the story leaves it canceled. A closed story is ineligible for dispatch.
Read-only Reviewer turns and the automatic review cycle retain their existing workflow.

The runner needs network access to the API's `/internal/turn-tools` path. By default it uses
`PUBLIC_URL` over HTTPS. Set `FACILITY_RUNNER_API_URL` on the worker if runners use a separate
reachable API origin. For isolated local development with `FACILITY_INSECURE_DEV=1`, Docker
Desktop can use `http://host.docker.internal:4400`. Use a host address reachable from the
workspace on other Docker installations.

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

When a Vercel workspace resumes, Docker startup distinguishes a live daemon from a stale PID file
retained in the snapshot. It waits for a live daemon, or removes stale PID and socket files before
starting one. A recycled PID is never signaled. Bootstrap preserves ownership inside Docker layers
and volumes so container data survives the resume.

New daemons use an execution-state directory tied to the kernel boot ID. Restoring a snapshot
therefore cannot reuse runc process state from an earlier VM, while Docker's persistent data stays
in `/workspace/.facility/docker`. Container restart policies still apply: a container deliberately
stopped with `unless-stopped` remains stopped. A missing or malformed boot ID prevents startup.

Vercel agent commands start once and emit sequenced output and exit events to both a live stream
and a durable journal in their workspace. An exit event can complete observation even when the
provider's status endpoint is unavailable. If streaming disconnects, Facility reads the journal
and skips events already delivered, preserving output order without restarting the command.

Each journal read and completion wait is limited to 30 seconds. An expired completion wait is
renewed; transient read failures retry with backoff until the command's overall deadline or an
explicit cancellation. A read timeout alone does not stop the agent. Permanent access failures
and invalid journal data remain errors. Run details record when observation is recovering or
restored, including the operation, retry count, elapsed time, and next sequence number.

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

### Open preview

Opens the service in the same persistent workspace used by the story's agents. Once prepared,
preview access preserves the current Git branch, uncommitted files, native sessions, and local
data. It does not fetch or switch Git, rerun setup, or reseed. A declared `environment.ready`
command lets Facility reuse healthy services; otherwise it runs `environment.start` on each open.
A sleeping workspace wakes with its retained files. First-time preparation still runs normally;
use **Clean setup** to apply repository or setup changes that require preparation again.

Opt-in native Vercel previews (`FACILITY_NATIVE_PREVIEWS=1`) use the Sandbox URL
and Facility login. A user with `previews:read` can open an already-running,
prepared native preview without execution permission; that action never wakes
compute or runs setup/start. `workspaces:execute` retains preparation/wake behavior.
There is no per-story preview ACL. Application authentication remains separate.
Native URL stability across suspend/resume must be verified with the provider;
the story lifecycle reports the latest verified origin for callback reconciliation.

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

Vercel resume removes stale Docker/containerd runtime files only when the recorded
Docker daemon is absent. A retained preview PID is signaled only when its command
line matches the gateway and both ports. Docker readiness failures identify the
retained daemon log. Existing container-file ownership is preserved, not repaired.
