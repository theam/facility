---
title: Stories and workspaces
---

# Stories and workspaces

A story is Facility's durable unit of work. It may represent a GitHub issue, a pull request, an ad
hoc request, or one stable schedule. It owns one conversation and one current workspace.

## Story identity

Stories belong to one organization and project. An external provider id links repeated GitHub or
scheduled activation to the same story. An idempotency key protects individual start and message
requests from network retries. These are different concerns: the external id identifies the body
of work, while the key identifies one requested operation.

A project member can continue a story created by another member. The conversation is shared
project state rather than a private chat transcript.

## Durable and replaceable state

The workspace separates durable state from replaceable compute. Its volume contains repository
worktrees, dependencies, engine configuration, Claude and Codex session files, and project-created
artifacts. Suspending stops compute. Waking attaches the same volume. Replacing a failed compute
instance also attaches that volume.

The volume normally contains:

- repositories under `repos/<owner>/<repository>`;
- the story branch, local commits, untracked files, and Git metadata;
- installed dependencies and development data written by the project;
- Claude Code and Codex configuration and native session files; and
- browser-test output and other workspace artifacts.

PostgreSQL separately retains messages, turns, attention items, environment events, catalog
snapshots, costs, audit records, and provider references. Losing either store can make a story
incomplete, so production backup policy must cover both.

## Conversation and turns

Messages are persisted before dispatch. A story permits one queued or running turn; later messages
remain queued in conversation order. Every turn records the exact agent manifest hash, engine,
model, trigger, and native session reference used.

When a message arrives during active work, it stays queued. Facility promotes it only after the
current turn reaches a terminal state. A failed worker can reclaim dispatch work without creating
a second active turn. Retrying a failed attention item creates a new attempt while preserving the
failed attempt as history.

Agents share the conversation and files, but each turn still records which agent ran. Changing
from `architect` to `builder` does not create another workspace or copy a summary into a separate
thread.

Native engine continuation is compatible-session specific. Facility resumes the active session for
the same workspace, agent name, engine, and model. Choosing another agent or changing its engine or
model starts or resumes that configuration's own session while retaining every prior session and
the shared worktree.

## State and retention

Story states are `ready`, `working`, `attention`, `review`, `done`, and `archived`. Archive is
reversible. Merge and archive never call workspace destruction.

Workspace compute may be `creating`, `running`, `sleeping`, `error`, or `destroyed`. A sleeping or
error workspace can retain its durable volume. `destroyed` means the explicit deletion path has
removed that durable workspace and it cannot be resumed.

Facility has no age-based deletion rule. Storage continues to accrue until an operator removes a
workspace. Use budgets and observability to distinguish active compute cost from retained storage,
then set an organizational retention policy outside the agent prompt.

See [The story loop](the-loop.md) for the end-user flow and the [lifecycle
reference](../reference/lifecycle.md) for operation semantics.
