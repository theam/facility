---
title: "ADR 006: Multi-repository story semantics"
---

# ADR 006: Multi-repository story semantics

Status: accepted for Facility 0.12

## Decision

A project has one primary repository and zero or more related repositories. Every configured
repository is checked out into the workspace and receives the same maintainer-level GitHub access.
Facility does not implement repository-specific or agent-specific permission profiles.

Facility 0.12 links one canonical pull request on the primary repository to a story. Agents may
create branches and pull requests in related repositories with `git` and `gh`, and those links are
recorded as artifacts, but coordinated multi-PR merge workflows are outside the 0.12 core.

Branch names derive from the stable story identity and are used across repositories when available.
A collision is resolved deterministically without rewriting an existing unrelated branch.

## Why

One primary pull request gives merge webhooks and story completion an unambiguous source while
preserving full access for work that crosses repository boundaries. Facility can add an explicit
multi-PR completion policy later without changing workspace permissions or agent manifests.

## Evidence

The project-environment integration test clones a primary and related local bare repository into
one workspace and checks that both survive compute replacement. Credential tests issue one
installation token for every configured repository and deny credential-helper requests for any
other host or repository. The maintainer workflow test creates and pushes a real branch while a
deterministic `gh` fake records issue, comment, workflow, pull-request, and check operations.

## Alternatives tested

- Treating every repository as primary was rejected because merge events could not identify the
  story's canonical completion signal.
- Per-repository agent permission calculation was removed and guarded by regression tests. It
  conflicts with the one-capability model and still leaves cross-repository stories half-operable.

## Ownership boundary

The repository contract names the primary and related repositories. Facility owns checkout layout,
credential routing, the canonical PR link, and story completion from that PR. Agents own ordinary
Git operations on related repositories; GitHub owns branch protection and merge policy.

## Revisit when

Add coordinated multi-PR completion only when a real project needs atomic status across
repositories. Do not change access semantics as part of that work.
