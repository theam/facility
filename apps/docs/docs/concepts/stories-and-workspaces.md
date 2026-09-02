---
title: Stories and workspaces
---

# Stories and workspaces

A story is Facility's durable unit of work. It may represent a GitHub issue, a pull request, an ad
hoc request, or one stable schedule. It owns one conversation and one current workspace.

The workspace separates durable state from replaceable compute. Its volume contains repository
worktrees, dependencies, engine configuration, Claude and Codex session files, and project-created
artifacts. Suspending stops compute. Waking attaches the same volume. Replacing a failed compute
instance also attaches that volume.

Messages are persisted before dispatch. A story permits one queued or running turn; later messages
remain queued in conversation order. Every turn records the exact agent manifest hash, engine,
model, trigger, and native session reference used.

Story states are `ready`, `working`, `attention`, `review`, `done`, and `archived`. Archive is
reversible. Merge and archive never call workspace destruction.
