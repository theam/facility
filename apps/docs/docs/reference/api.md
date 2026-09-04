---
title: API
---

# Control-plane API

REST, OpenAPI-described, permission-gated per route. In development the
interactive reference lives at `http://localhost:4400/docs`; the machine
spec is generated into `packages/sdk/openapi.json` and the typed TypeScript
client is `@facility/sdk`. The SDK is currently a private workspace package,
not an npm distribution; the examples below run inside this monorepo. External
clients can generate from the committed OpenAPI document until SDK distribution.

## Authentication

- **Session cookie** — browser sign-in backed by a verified GitHub identity.
- **API key** — `Authorization: Bearer fak_…`, issued with
  `facility keys issue` or `POST /v1/keys`; each key binds a role, so RBAC is identical for
  humans and machines. Use a project-scoped key wherever possible.

## Conventions

- Base path `/v1`. JSON is the default representation. Run transcripts are
  `application/x-ndjson`; live run streams are `text/event-stream`.
- Errors: `{ "error": { "code", "message", "details?" } }` with meaningful
  status codes; `403` includes the permission you lacked. Signed webhook
  endpoints intentionally answer invalid signatures with only `{ "ok": false }`
  to avoid exposing authentication diagnostics to an unauthenticated sender.
- Privileged v1 mutations (protected, non-GET routes that declare an audit action)
  are recorded in the append-only, hash-chained audit log on success; verify the
  org's chain with `GET /v1/audit/verify`. Webhook deliveries and run-lifecycle
  events are captured separately in their own event logs (`inbound_events`,
  `run_events`) — durable evidence, but not part of the audit hash chain.
- Streams (run events) are SSE: `GET /v1/runs/:id/stream`.
- Growing list routes use bounded `limit`/`offset` or cursor pagination. Run
  event reads support `afterSeq` and a true `tail`; SSE resumes through
  `Last-Event-ID` or `afterSeq`.
- Creation routes that advertise `Idempotency-Key` accept 8–200 characters.
  The same principal/method/path/key, query parameters, and body replays the
  stored response for 24 hours; a changed body or query parameter is a
  `409 idempotency_key_reused`. Query parameters are canonicalized so ordering
  differences do not create false conflicts. An active first request returns
  `409 idempotency_in_progress` with `Retry-After`; pending claims older than 15
  minutes may be reclaimed after a crashed request.

## Resource map

The committed contract currently contains 138 `/v1` operations. Its domains are:

- identity and policy: `/me`, `/org`, `/members`, `/roles`, `/keys`;
- project delivery: `/projects`, repositories, GitHub App discovery and issue
  sync/trigger, project health, kickstart, upgrade, and outcomes;
- agent work: agents and status, sessions/runs, durable transcripts, exact-SHA
  pull-request delivery inspection/retry, interrupt, resume, live events, and
  conversations;
- knowledge and governance: KB, tasks, registry, action types, proposals, inbox,
  operational issues, and the audit chain;
- infrastructure and cost: providers, virtual keys, budgets, spend, raw LLM
  envelopes, analytics, sandbox profiles, and the capability catalog;
- integrations: signed inbound events, outbound webhooks, inbound event history,
  delivery history, secret rotation, and manual delivery retry.

`/health`, `/readyz`, browser authentication, `/webhooks/github`, and
`/webhooks/inbound/:integrationId` are documented alongside `/v1`. Runner-only
transport endpoints under `/internal` are deliberately absent from the public
contract. The one runner callback under `/v1`, `runs/:id/kb-checkpoint`, is
explicitly marked with runner-token security and is not offered as an operator
SDK or CLI method.

The generated OpenAPI document is the authoritative, always-current
reference — CI compares the committed paths and components with the live
Fastify document. The SDK exports both generated `paths`/`components` types and
ergonomic methods:

```ts
import { FacilityClient } from "@facility/sdk";

const facility = new FacilityClient({ baseUrl, apiKey });
for await (const run of facility.iterateAllRuns({ status: "running" })) {
  console.log(run.id);
}
const stream = facility.watchRun(runId, ({ data }) => console.log(data));
const transcript = await facility.runTranscript(runId); // raw NDJSON text
```

GETs retry transient failures. POSTs retry only when the caller supplies an
idempotency key; non-idempotent writes are never retried automatically.
For ordinary JSON requests, non-2xx responses become `FacilityApiError` with
the HTTP `status`, the server's `code` and `details`, and the parsed error
`payload` when available. A non-empty 2xx body that is not valid JSON becomes
`FacilityApiError` with the response status and code `invalid_response`. If the
SDK's deadline aborts a request before a response arrives, it reports status
`408` and code `request_timeout`; a caller-supplied `AbortSignal` instead
preserves the rejection produced by `fetch` rather than wrapping it.

Streams do not turn every termination into `FacilityApiError`. A
non-retryable HTTP response rejects `done` with that type; retryable HTTP and
transport failures are passed to `onError` while reconnecting. Calling
`close()` or aborting the stream's caller signal stops it and fulfills `done`.

## Facility-signed webhooks

Inbound and outbound Facility webhooks carry `X-Facility-Timestamp`,
`X-Facility-Delivery`, `X-Facility-Event`, and `X-Facility-Signature`. The
signature is `sha256=` plus HMAC-SHA256 over the exact bytes:

```text
timestamp + "." + deliveryId + "." + eventType + "." + body
```

Inbound timestamps have a five-minute acceptance window and delivery ids are
deduplicated per integration. Outbound delivery is at least once, never follows
redirects, and durably retries network failures and HTTP 408/425/429/5xx up to
eight attempts. See the OpenAPI integration routes for delivery inspection and
manual retry.

The full wire contract — integration types, the `facility.signal.v1` envelope
for lifecycle telemetry, and outbound delivery semantics — is in the
[webhooks reference](webhooks.md).

## Troubleshooting

- `facility doctor [--json]` checks the local installation; `facility doctor
  --platform [--profile <name>] [--allow-insecure] [--json]` checks deployment
  readiness. Both modes print actionable remediation and preserve the JSON
  contract.
- HTTP 401 / CLI exit 2 means missing, invalid, expired, or revoked credentials.
- HTTP 403 identifies the needed permission in `error.details`.
- HTTP 409 means current resource state or idempotency ownership conflicts.
- MCP HTTP 421 means the request `Host` or browser `Origin` is not trusted.
- Outbound webhooks require HTTPS in production, reject private/reserved DNS
  answers, pin the validated address for delivery, sign timestamp plus body,
  never follow redirects, and retry transient failures durably.
