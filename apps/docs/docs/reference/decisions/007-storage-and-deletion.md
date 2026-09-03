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
artifact metadata before deletion. The runtime conformance suite has a provider-independent,
SHA-256-checked workspace archive fixture. It includes repositories, uncommitted files, native
engine sessions, browser artifacts, and project data. It excludes the workspace-scoped Docker layer
cache and runtime identity files because those are rebuilt for the new workspace identity during
restore. A failed validation or extraction deletes only the newly allocated restore target. This
whole-volume base64 transport is not exposed as an operator API in 0.12; production backup and
restore use the provider volume or snapshot facilities.

Workspace storage additionally follows the selected provider's snapshot policy; Vercel snapshots
have no automatic expiry, and Docker operators include named workspace volumes in host backups when
filesystem disaster recovery is required.

Facility reports approximate active compute and retained storage. Project budgets can block new
agent turns after their monthly limit is reached, but never delete, archive, or suspend a workspace
automatically.

## Evidence

Unit and Docker integration tests create an archive, restore it into a fresh workspace identity,
verify untracked work, native session markers, Compose seed data, and the browser fixture, then
explicitly delete the source and restored volumes. Invalid checksums are rejected before extraction;
the restore command rejects archive entries that are absolute or traverse a parent directory.

## Alternatives tested

- Compute-container filesystems were rejected because replacement loses their bytes.
- Provider snapshots alone were rejected as the only recovery contract because they cannot be
  restored across providers or validated by the application-level fixture.
- Automatic age or merge retention was rejected because the requested lifetime belongs to the
  user, not a timer.

## Ownership boundary

Facility owns the explicit lifecycle operation, conformance archive validation, tombstone, and
isolation of the selected workspace. The provider owns snapshot and volume durability. Operators
own backup destinations, encryption, retention, restore drills, and physical cleanup after
migration.

## Revisit when

Revisit the archive format if workspace data exceeds practical command transport limits, if Docker
cache recovery becomes materially important, or if a provider-native export can satisfy the same
cross-workspace restore and checksum tests.
