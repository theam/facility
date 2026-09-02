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

## Evidence

The Docker conformance test uses the disposable reference project under
`services/api/test/fixtures/reference-project`. On 2 September 2026 it created a workspace in 542
ms, built and started the Compose project in 1,401 ms, completed its Chromium flow in 1,023 ms, and
woke replacement compute in 1,315 ms. The same run restored an untracked file, seed data, and a
native session marker from backup before deleting both test volumes.

The fake runtime passes the same persistence and explicit-deletion tests without Docker. It is kept
for deterministic application tests, not as a deployment option. The Vercel adapter uses the same
contract, but the hosted pilot and 14-day retention run remain release gates; local Docker evidence
does not stand in for those checks.

## Alternatives tested

- The in-process fake was tested and rejected for deployment because it provides no process or
  tenant isolation.
- A Docker container with storage tied to compute was exercised during runtime development and
  rejected because container replacement also made recovery depend on the container filesystem.
  The selected Docker design gives the named volume its own identity.

No other hosted provider has been run through this repository's conformance suite. The decision
does not claim comparative evidence that was not collected.

## Ownership boundary

Facility owns workspace identity, lifecycle intent, conformance tests, and the provider adapter.
Docker or Vercel owns compute isolation and durable-storage implementation. Operators own provider
credentials, storage policy, backups, capacity, and the decision to enable a provider.

## Revisit when

Revisit the hosted provider if its pilot cannot run nested Docker and Chromium, if non-expiring
snapshots fail the retention run, or if a production-grade independently attachable volume becomes
available and materially improves recovery or cost.

## References

- [Sandbox persistence is GA](https://vercel.com/changelog/sandbox-persistence-is-now-ga)
- [Sandbox duration and persistence](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence)
- [Running Docker on Vercel](https://vercel.com/kb/guide/docker)
