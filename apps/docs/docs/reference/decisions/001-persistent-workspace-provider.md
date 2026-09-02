---
title: "ADR 001: Persistent workspace providers"
---

# ADR 001: Persistent workspace providers

Status: accepted for Facility 0.12

## Decision

Facility supports two implementations of one `WorkspaceRuntime` contract:

- Docker with a named volume for local development, self-hosting, and deterministic end-to-end
  tests.
- Vercel persistent Sandboxes for the hosted deployment.

The Vercel implementation uses a stable, project-scoped sandbox name, persistence enabled, and
snapshots configured without automatic expiry. The Docker implementation gives the container and
volume different identities. Replacing the container must not replace the volume.

Both providers must pass the same conformance suite:

1. create a workspace;
2. write committed and uncommitted state plus native engine session state;
3. suspend it;
4. remove or replace its compute;
5. wake it; and
6. recover every byte and the same engine session identity.

Provider-specific behavior stays behind the runtime boundary. Stories, turns, MCP, schedules, and
the UI never branch on the provider.

## Why

Vercel Sandbox persistence separates a durable sandbox identity from replaceable sessions. It
supports named get-or-create behavior, automatic filesystem snapshots, configurable snapshot
retention, exposed ports, sudo, and Docker inside an isolated microVM. This satisfies the hosted
runtime contract without requiring Facility to operate a separate VM fleet.

Docker named volumes provide the closest local equivalent and make the destructive boundary easy
to verify: stop and container removal preserve the volume; only explicit workspace deletion removes
it.

Vercel Drives are not selected for 0.12. They remain private beta and their documentation advises
against production data. Persistent Sandbox snapshots are the hosted durability mechanism until a
separately managed volume product is production-ready.

## Consequences

- Facility upgrades `@vercel/sandbox` from the old ephemeral API to the stable persistent API.
- A Vercel sandbox session can end while its Facility workspace remains `sleeping` and recoverable.
- Provider loss remains possible. Conversation metadata and artifacts live in Postgres; workspace
  filesystem recovery follows the provider's snapshot guarantees.
- Facility displays storage and active-compute usage but never deletes for cost control.
- A provider that cannot pass the conformance suite cannot be enabled.

## References

- [Sandbox persistence is GA](https://vercel.com/changelog/sandbox-persistence-is-now-ga)
- [Sandbox duration and persistence](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence)
- [Running Docker on Vercel](https://vercel.com/kb/guide/docker)
