---
title: "ADR 007: Durable storage and explicit deletion"
---

# ADR 007: Durable storage and explicit deletion

Status: accepted for Facility 0.12

## Decision

Workspace files and native engine state persist until an authorized user explicitly deletes them.
Merge, archive, inactivity, compute replacement, agent removal, and disabled schedules may suspend
compute but cannot delete storage.

Postgres stores the durable story record, conversation, turn metadata, engine-session references,
artifacts, preview sessions, and lifecycle events. The workspace provider stores the worktree,
uncommitted changes, installed dependencies, project data, browser artifacts, and native session
files. Provider storage is configured without a destructive TTL.

`facility_delete_workspace` is the only public destructive operation. It requires `confirm: true`
and an idempotency key, reports the exact workspace and sessions affected, revokes previews, stops
compute, removes provider storage, and records a lightweight tombstone. Retrying a partial or
completed deletion is safe. Deleting one workspace cannot select another workspace by a
caller-supplied provider id.

## Backup and recovery

Operators back up Postgres using their normal database policy. A story can export conversation and
artifact metadata before deletion. Workspace storage follows the selected provider's snapshot
policy; Vercel snapshots have no automatic expiry, and Docker operators include named workspace
volumes in host backups when filesystem disaster recovery is required.

Facility reports approximate active compute and retained storage. Cost is information, not a
budget gate or automatic cleanup policy.
