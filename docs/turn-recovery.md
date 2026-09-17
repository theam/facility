# Turn evidence and recovery

Facility records execution evidence in its database, outside the workspace VM.
The story's **Run details** and turn-events API expose the same scoped timeline.

## What is retained during a run

- `turn.phase` identifies credential preparation, workspace initialization,
  project setup, and agent execution. A long gap identifies the phase to investigate.
- Engine events are written while the command runs, in ordered transactions.
  Native session identifiers are checkpointed in the same transaction as their
  initialization event. A failed first turn can therefore resume its retained
  native session on the next requested turn.
- Vercel workspaces emit `workspace.health` approximately every 30 seconds, also
  during project setup. Each sample records provider state and VM identity,
  available memory, cgroup memory usage/limit and OOM kills, load, disk space,
  boot identity, uptime, Git HEAD, and the number of modified tracked files when
  available. Missing counters mean unavailable, not zero. These are diagnostic
  samples, not billing measurements or a backup of source files.
- `workspace.ready` records the VM and retained volume used after initialization.
  The dispatcher initializes transient services again before preparing each turn,
  including turns that waited in the queue while a VM was replaced.
- Observation failures carry a structured category and HTTP status when available.
  HTTP 410 is recorded as `workspace_session_lost`; it is not retried as though
  the original process were still running.
- Failed setup, seed, and service-start commands retain their exit code and bounded,
  redacted output in the environment timeline before reporting failure.

Health probes bind to the current Vercel session without resuming stopped compute.
They have an eight-second observation deadline and a five-second remote command
limit, never overlap, and do not fail the agent when a probe is unavailable.
They collect allowlisted counters and identifiers, not environment variables,
process arguments, repository contents, filenames, or network destinations.
Engine events use the existing project-secret redaction before storage.
Infrastructure job logs contain turn identifiers and state, not agent transcripts.

## Investigating an interruption

1. Find the last `turn.phase` and engine events. They show whether work reached
   the agent and what it reported before the interruption.
2. Compare `workspace.health` samples. A changed VM/boot identity establishes a
   replacement; OOM counters or exhausted memory/disk support a resource diagnosis.
   Healthy counters from a replacement cannot rule out OOM in the previous VM.
3. Inspect `probe: unavailable` and `missedSamples`. The latter counts failed
   database writes since the last successful sample. The worker also emits
   `turn.health_persistence_failed` if database storage fails.
4. For an internal provider failure without an exposed cause, retain the VM
   identifier and sample timestamps for provider support. Do not infer the root
   cause solely from an HTTP status.
5. Review partial changes and external effects before requesting continuation.
   The next turn retains the worktree, reinitializes transient services, and uses
   the compatible native session checkpoint when its files remain usable.

A provider failure does not authorize blindly replaying agent commands. Transient
observation reads reconnect to the original command; terminal failures remain
visible and require a continuation. Corrupt native sessions retain the existing
explicit replacement workflow. No automatic Git reset, workspace deletion, clean
setup, or replay of external writes is performed.

## Failed commands and idle compute

Long-running Vercel agent commands write a private, ordered output journal under
`/workspace/.facility/command-output/` before publishing each log frame. Sequence
numbers and byte encoding make reconnection independent of provider log history
and chunk boundaries. If the stream disconnects or is truncated, observation reads
the journal on the original VM and continues without submitting another command.
A final journal read includes output lost at command completion. These files contain
raw engine output, have mode `0600`, and remain with the workspace: treat them as
sensitive recovery evidence, not public issue attachments. Include them in the
workspace's storage retention policy.

Terminal observation failures request termination of the original command. Process
cleanup never resumes stopped compute. A failed turn with no active turn, queued
turn, or pending message suspends its workspace while retaining the volume. The
worker reconciles missed or failed suspensions on its minute schedule, recording
`workspace.suspended` or `workspace.suspend_failed` with the failed turn identifier.
A provider error leaves suspension eligible for retry, rather than reporting a
machine as stopped. A deliberate operator wake after failure takes precedence;
successful previews keep their existing lifecycle.

Suspension and new message submission share a story lock. New work is either
already present and prevents suspension, or starts after suspension and resumes
the retained workspace. Cleanup uses organization and project scope throughout.

Health/event writes do not renew the worker lease. A final telemetry flush failure
is reported as `turn.final_events_persistence_failed` and cannot prevent closing an
otherwise failed turn. `worker.turn_dispatch_failed` exposes failures that escape
terminal handling, without including transcript or database error text.

## Operational limits

Dispatch jobs use a 23-hour queue expiration, below pg-boss's 24-hour ceiling.
The default 15-minute queue timer can stop awaiting a callback without canceling
its agent; it must not be used for long turns. Database turn leases remain the
crash-recovery authority. Queue expiration is not an engine cancellation deadline;
configure total preparation and execution budgets within this queue window.


Database lease writes run every two seconds without overlapping. Job logs report
`turn.heartbeat_unconfirmed` on failed writes or a write pending for 30 seconds,
at most once every 30 seconds while confirmation is missing. The record includes
the turn ID, failure count and time since the last confirmation, not database
error text. `turn.heartbeat_recovered` records recovery; `turn.lease_lost` means
the database no longer confirms ownership and the observer cancels the turn.

ECS workers acquire the maximum 48-hour task-protection lease before claiming a
turn, renew it while running, and release it when dispatch finishes. The initial
lease covers agent execution plus preparation even when ECS
rejects renewal during a deployment with `DEPLOYMENT_BLOCKED`. Protection responses
must confirm the requested duration. Renewal and release failures log an allowlisted
reason, HTTP status, and remaining lease time, without provider response bodies.
This protects against deployment scale-in, not process crashes or infrastructure
loss. If release fails, an idle task can remain protected until the lease expires;
operators should verify it has no active work before clearing protection.

See [AWS task scale-in protection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-scale-in-protection.html)
for deployment constraints and lease limits.

Evidence is durable once its database transaction commits. Worker loss can still
lose an in-flight batch, and a database outage prevents new evidence from becoming
durable. Event writes retry pending batches in order; turn completion fails visibly
if the final evidence cannot be saved. Workspace files require retained provider
storage and the existing backup workflow; session checkpoints do not replace it.

Vercel commands have a five-hour provider limit. Observation also has a local
deadline (the command limit plus 30 seconds) so repeated bounded waits cannot keep
a failed command and its worker lease alive indefinitely.

Health samples add at most two regular probes per minute per active Vercel turn.
Include turn-event tables in database backup, capacity, retention, and access-control
policies. Sampling is currently implemented for Vercel; other runtimes still retain
live engine events and native session checkpoints.

The dispatcher records wake intent before contacting the workspace provider. A lost wake acknowledgement or failed environment setup therefore remains eligible for failed-turn suspension, including when the workspace was previously recorded as sleeping.
