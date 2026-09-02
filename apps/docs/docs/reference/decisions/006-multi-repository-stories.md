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
