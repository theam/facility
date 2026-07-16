# CLI, REST API, TypeScript SDK, and MCP

Facility does not require the web application for operation. All authoritative
state lives behind the v1 API; the CLI, SDK, and MCP server are clients of that
same RBAC-, scope-, idempotency-, and audit-enforced boundary.

## Start the control plane

```bash
export SECRET_MASTER_KEY="$(openssl rand -base64 32)"
docker compose up -d postgres minio createbuckets migrate api worker gateway mcp
curl --fail http://localhost:4400/health
curl --fail http://localhost:4420/healthz
```

The MCP container listens on `4420`. For a public deployment set
`MCP_PUBLIC_URL`, `MCP_ALLOWED_HOSTS`, and `MCP_AUTHORIZATION_SERVER`, terminate
TLS at the edge, and configure the API's WorkOS issuer/audience settings. A
non-loopback MCP bind fails closed unless a trusted authority is configured.

## CLI

```bash
facility login --url https://facility.example --profile production
facility profiles use production
facility status
facility projects list --json
facility runs get run_01H… --json
facility runs events run_01H… --tail 100 --json
facility runs watch run_01H… --json > run-events.jsonl
facility integrations deliveries int_01H… --status dead --json
facility --help
facility agents --help
```

Interactive API-key input is masked. Saved configuration is mode `0600`.
Remote plain HTTP is rejected unless `--allow-insecure` is explicitly supplied
for a trusted development endpoint; the same rule applies to `doctor --platform`
and ad-hoc doctor targets. Every platform command accepts `--profile`,
`--json`, `--timeout`, and `--help`; unknown flags fail instead of being ignored.
Destructive commands require `--yes`. JSON failures use the same stdout channel
as JSON successes and keep stderr empty, making shell pipelines deterministic.
Exit status is `0` for success, `1` for command/API/terminal-run failure, and `2`
for authentication failure. Piped login consumes URL and key as two lines from
one stdin stream. A closed stdin at an interactive prompt is an explicit
`prompt_eof` error, never a false success; JSON login never prompts and instead
returns a structured `credentials_required` error.

Human tables adapt to terminal width and fall back to a vertical field layout
instead of hard-wrapping. `NO_COLOR` and non-TTY output are ANSI-free. Validation
commands (`kb validate`, `audit verify`) exit non-zero when their report is not
valid, and every destructive credential/resource removal requires `--yes`.

The CLI covers project/repository bootstrap; GitHub App discovery, issue sync,
triggering, and outcomes; sessions, transcripts, live steering, interrupt and
resume; durable conversations; approvals and issues; org access; provider,
sandbox, agent and schedule configuration;
budgets, spend and raw model requests; registry, KB and tasks; virtual keys;
integrations and delivery retries; analytics, health and audit verification.

## REST and OpenAPI

The interactive reference is served at `/docs`; its JSON document is available
at `/docs/json` and committed at `packages/sdk/openapi.json`. The document has a
stable `operationId`, tags, request/response schemas, permission extensions,
security schemes, standard error envelopes, and `Idempotency-Key` parameters on
replay-safe creation operations.

Authenticate machines with `Authorization: Bearer fak_…`. Use a project-scoped
key wherever possible. List routes that can grow accept bounded pagination.
Run events support ordinary pages, a true tail, and resumable SSE:

```bash
curl -N \
  -H "Authorization: Bearer $FACILITY_API_KEY" \
  -H "Last-Event-ID: 120" \
  https://facility.example/v1/runs/run_01H…/stream
```

Errors are `{ "error": { "code", "message", "details"? } }`. Treat `code` as
the machine contract. Health returns 503 when its database dependency is down.

Creation routes documented with an `Idempotency-Key` parameter accept keys of
8–200 characters. The key is scoped to the authenticated principal, method,
and path for 24 hours. Replaying the same body returns the stored status/body;
reusing it with a different body returns `idempotency_key_reused`; an active
first request returns `idempotency_in_progress` with `Retry-After`. Pending
claims older than 15 minutes may be reclaimed after a crashed request.

## TypeScript SDK

```ts
import { FacilityClient } from "@facility/sdk";

const facility = new FacilityClient({
  baseUrl: process.env.FACILITY_API_URL!,
  apiKey: process.env.FACILITY_API_KEY!,
  timeoutMs: 30_000,
  maxRetries: 2,
});

const projects = await facility.projects();
for await (const run of facility.iterateAllRuns({ status: "running" })) {
  console.log(run.id, run.project.slug);
}
const stream = facility.watchRun("run_01H…", (event) => console.log(event.data));
await stream.done;
const transcript = await facility.runTranscript("run_01H…");
```

The SDK is generated-contract-backed and exposes typed route/body/response
helpers plus ergonomic methods for every domain, async pagination iterators,
and a typed, resumable run stream. Safe GETs retry transient network, 429, and
5xx responses with `Retry-After`. POSTs retry only when the caller supplied an
idempotency key; other writes are never retried implicitly. Timeouts, aborts,
malformed success bodies, and API failures become `FacilityApiError` with
status, code, details, and original payload.

## MCP

For stdio:

```json
{
  "mcpServers": {
    "facility": {
      "command": "facility-mcp",
      "env": {
        "FACILITY_API_URL": "https://facility.example",
        "FACILITY_API_KEY": "fak_…"
      }
    }
  }
}
```

For streamable HTTP, connect to `https://mcp.facility.example/mcp`. Send an API
key as a Bearer credential for service use, or configure the advertised OAuth
2.1 authorization server for interactive clients. The API validates the token;
the MCP proxy does not possess an elevated service credential.

Tools return both text and protocol-valid structured content. Errors set
`isError` and retain API status/code/details. Read tools declare read-only and
idempotent annotations. Mutating tools create a durable proposal and perform no
side effect until a different human principal with `hitl:decide` approves it.
The bundled `operator` role can use MCP reads and propose writes but cannot
decide them.
Execution revalidates the allowlisted tool, permission, organization/project
target, and arguments before the side effect. Decisions are intentionally absent
from MCP and must be made through a separately authenticated CLI or API principal.

Clients can enumerate `facility://me`, visible projects, and recent runs; run
resources include a bounded transcript window, while the paged run-events tool
continues from `afterSeq`. The server also provides status,
run-triage (with optional `runId`), and cost-review prompts. The current surface
contains 79 tools covering identity/access discovery, projects/repos/health,
agents/status/runs/transcripts, conversations, GitHub App discovery and issue
workflows, outcomes, HITL, issues, budgets/spend/raw LLM envelopes, registry,
sandboxes, tasks, virtual keys, KB, analytics/audit, the capability catalog, and
integrations. Conversation, GitHub issue, project, task, KB, registry, repo,
operational issue, webhook-delivery, and run mutations all use the same durable
approval path.

## Integration webhook wire contract

Create `generic_inbound` integrations for events entering Facility and
`webhook` integrations for Facility events leaving it. The plaintext signing
secret is returned only when the integration is created or rotated.

Inbound requests use `POST /webhooks/inbound/:integrationId`, an unmodified JSON
body, and these required headers:

```text
X-Facility-Timestamp: <10-digit Unix seconds>
X-Facility-Delivery: <sender-unique delivery id>
X-Facility-Event: <event type>
X-Facility-Signature: sha256=<hex HMAC-SHA256>
```

Compute the HMAC over this exact byte sequence, where `body` is the exact body
sent on the wire:

```text
timestamp + "." + deliveryId + "." + eventType + "." + body
```

Facility rejects signatures outside a five-minute clock-skew window. A valid
delivery is deduplicated per integration and delivery id; a repeat returns
`202 {"ok":true,"replayed":true}` without processing twice.

Outbound webhook integrations receive the same four headers and signing
formula. Supported events are `run.finished` and `proposal.decided`; set
`config.events` to an array to subscribe to a subset, or omit it for both.
Delivery is at least once. A durable outbox claims with row locks, recovers
five-minute-stale claims, times out requests after ten seconds, follows no
redirects, and retries network errors plus HTTP 408/425/429/5xx up to eight
attempts. Backoff begins at 30 seconds, honors bounded `Retry-After`, and caps at
24 hours. Other non-2xx responses become dead immediately. Operators can list
deliveries, inspect the last status/error, and retry `failed` or `dead` entries
through CLI/API.

## Troubleshooting

- `facility doctor [--json]` checks the local installation; `facility doctor
  --platform [--profile <name>] [--allow-insecure] [--json]` checks deployment readiness. Both
  modes print actionable remediation and preserve the JSON contract.
- HTTP 401 / CLI exit 2 means missing, invalid, expired, or revoked credentials.
- HTTP 403 identifies the needed permission in `error.details`.
- HTTP 409 means current resource state or idempotency ownership conflicts.
- MCP HTTP 421 means the request `Host` or browser `Origin` is not trusted.
- Outbound webhooks require HTTPS in production, reject private/reserved DNS
  answers, pin the validated address for delivery, sign timestamp plus body,
  never follow redirects, and retry transient failures durably.
