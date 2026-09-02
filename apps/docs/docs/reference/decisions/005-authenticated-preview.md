---
title: "ADR 005: Authenticated workspace previews"
---

# ADR 005: Authenticated workspace previews

Status: accepted for Facility 0.12

## Decision

A preview is an authenticated route to a declared port in the story's current workspace. It is not
a separately built image or sandbox.

`facility_open_preview` wakes the workspace, verifies that the requested service is declared by the
project environment contract, and creates a short-lived one-time handoff for the current user. The
handoff becomes a revocable, preview-scoped browser session. HTTP and WebSocket traffic pass through
the same authorization and tenant checks.

An active preview session keeps compute awake. Expiry or revocation only makes the workspace
eligible for suspension; it never deletes storage. Anonymous, expired, revoked, malformed,
undeclared-port, and cross-tenant requests fail closed.

## Routing

The public preview origin is on a registered site separate from the control plane. Local development
uses loopback. Upstream endpoints come only from `WorkspaceRuntime.expose`; callers cannot supply
an arbitrary origin or port.

## Evidence

Local integration tests require a one-time handoff, reject malformed and expired credentials,
re-check active membership, and deny direct provider access. HTTP and WebSocket requests reach a
local backend only with the preview cookie and internal gateway token. The Docker fixture opens the
live Compose application through the host proxy and receives its seeded data.

## Alternatives tested

- Direct provider URLs were tested and rejected because they bypass Facility membership checks.
- A second preview process was rejected because it duplicated the environment and lost the live
  worktree and local database state the user needs to inspect.
- Exposing arbitrary caller-supplied ports was rejected; only named ports in `.facility.yml` reach
  the proxy.

## Ownership boundary

The runtime discovers a provider endpoint. Facility owns handoff, cookie, expiry, revocation,
membership, and project/story/service routing. The project owns service readiness and protocol
declarations.

## Revisit when

Revisit routing if the provider cannot keep endpoints private, if long-lived WebSockets cannot pass
through the proxy, or if a shared deployment needs a different registered preview-domain model.
