---
title: "ADR 008: Agent edits use pull requests"
---

# ADR 008: Agent edits use pull requests

Status: accepted for Facility 0.12

## Decision

The Facility UI writes an edited `.agents/<name>.md` file to a Facility-owned branch and opens or
updates a pull request. It never writes directly to the default branch. The editor shows this
behavior before submission and links to the resulting pull request.

The control service accepts the fields owned by the shared agent schema, renders canonical Markdown
frontmatter, validates the complete file with `@facility/agents`, and compares the default-branch
commit with the commit shown to the editor. A stale edit fails and asks the user to refresh. The
database projection is updated only after the repository change reaches the default branch and the
catalog is read again.

## Evidence

The GitHub adapter already uses a branch and pull request for kickstart, refuses default-branch
writes, and works with normal protected-branch review. Agent-edit integration tests cover canonical
rendering, stale revisions, unchanged files, branch creation and replacement, and pull-request
creation.

## Alternatives considered

Direct commits to the default branch remove one review step, but bypass the repository's normal
branch protection and make an accidental prompt or schedule change immediately active. Storing an
override in Facility would create a second source of truth and was rejected by the `.agents/`
contract.

## Ownership boundary

The repository owns agent configuration and review policy. Facility owns validation and the
mechanical Git proposal. GitHub owns branch protection, review, and merge. Facility never merges the
configuration pull request.

## Revisit when

Revisit this decision only if repositories gain an explicit, repository-owned policy for safe
direct configuration commits. A direct mode must still use the shared validator and may not create
a database override.
