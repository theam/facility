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
