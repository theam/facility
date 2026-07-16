# Spec: platform MCP server (packages/mcp) + CLI platform commands (packages/cli)

**Scope**: the AI-operable management surface. An MCP server exposing governed platform tools (same RBAC as everything else) over stdio and streamable HTTP, and the `facility` CLI gaining platform commands next to its vendored-install commands. Both consume `@facility/sdk`.

Read first: control-plane.md (routes + permissions), discovery/tam-os.md (§MCP — the write-confirmation pattern is binding), ARCHITECTURE.md ADR 9/20.

## packages/mcp (`@facility/mcp`)

`@modelcontextprotocol/sdk` (official TS SDK). Two transports:
- stdio (`facility-mcp` bin): auth from `FACILITY_API_KEY` + `FACILITY_API_URL` env.
- streamable HTTP (`facility-mcp serve --port 4420`): `Authorization: Bearer <credential>` per
  request. Two credential kinds: `fak_…` API keys (non-interactive services) and WorkOS-issued
  OAuth 2.1 access-token JWTs (interactive clients — Claude, Cursor, ChatGPT). The server advertises
  the authorization server at `/.well-known/oauth-protected-resource` (RFC 9728) and returns
  `WWW-Authenticate: Bearer resource_metadata=…` on 401; the control plane validates the JWT against
  WorkOS's JWKS (RS256, issuer + expiry + audience). Audience is REQUIRED: OAuth JWT auth is
  enabled only when `MCP_OAUTH_AUDIENCE` is configured, so `aud` is always validated. API keys stay
  supported forever.

Tools (names `facility_*`; JSON Schema inputs from Zod; every description is written for an operator LLM and states the permission needed):

Read tools cover identity/org/access policy, projects/repos/health,
agents/status/runs/events/transcripts, conversations, GitHub installations/repos/
issues, outcomes, HITL/action-type discovery, issues, budgets/spend/raw LLM
envelopes, registry, sandboxes/tasks/virtual keys, KB, analytics/audit
verification, integrations and event/delivery history, the capability catalog,
and kickstart preview. List inputs are bounded and paginated where the API
supports it; `facility_get_run` can inline up to 200 recent events.

Raw metering corpus: `/v1/llm-requests` lists durable LLM request rows for data mining. `/v1/llm-requests/:requestId/envelope` returns the stored request/response envelope for one row, scoped to the caller's org and project. The envelope endpoint requires `audit:read` (the full transcript is audit-grade, not spend data); project-scoped keys get 404 for another project's request.

Writes create HITL proposals and do not execute directly: run trigger/cancel/
steer/interrupt/resume; conversation start/send; GitHub issue sync/trigger;
project and agent creation/update/retirement; repo connection; issue
acknowledge/resolve; webhook retry; task create/transition/propose; KB amendment;
registry draft/publish/deprecate; budget setting; kickstart; and upgrade. MCP
exposes no proposal-decision operation: approval always comes from a separate
human principal through the CLI or API.

HITL proposal flow: a write tool strips any legacy `confirm_token`, stores the
intended API call as a proposal, and returns the proposal id, inbox route, and
summary. API idempotency is derived from the MCP request id, so transport replay
cannot create duplicate proposals. A different principal with `hitl:decide`
approves or rejects the proposal from the HITL inbox. MCP callers cannot
complete their own destructive writes. The bundled `operator` role is the
recommended AI-client role.

Resources: `facility://me`, `facility://projects/{id}`, `facility://runs/{id}`
(transcript window). Projects and recent runs are enumerable and their template
IDs are completable, so clients do not need to guess URIs. Prompts:
`facility-status`, `facility-run-triage` (optional `runId`), and
`facility-cost-review`.

Server never talks to the DB — SDK/HTTP only, so RBAC/audit apply identically (the API is the boundary). Map API errors → MCP tool errors with the `needed` permission surfaced.

## packages/cli additions

New commands (zero-dep rule stays — use global fetch; no SDK dep here to keep the npx footprint tiny; a small hand-rolled client mirroring sdk paths is fine):
- `facility login` — prompts for API URL + masked key (or `--url --key`), refuses remote plaintext HTTP unless explicitly overridden, verifies via /v1/me, and stores `~/.facility/config.json` with mode 0600 and named profiles.
- `facility status` — org overview: live runs, open inbox, spend MTD, issues (the CLI twin of the web overview).
- `facility projects list|get <slug>`
- `facility sessions list [--project] [--status]`, `facility sessions get <id>`,
  `facility sessions events <id> [--after-seq] [--tail]`, `facility sessions
  transcript <id>`, `facility sessions watch <id>`
  (resumable SSE tail rendering events as colored lines), `facility runs trigger
  <project> <agent> [--input] [--idempotency-key]`, `facility runs steer <id>
  <message>`, `facility sessions interrupt|resume|cancel <id>` (`runs` remains a
  compatibility alias)
- `facility conversations list|get|start|send`
- `facility github installations|repos|issues|issue|sync|trigger`
- `facility outcomes`, `facility catalog`, `facility agents status`, and
  `facility integrations events`
- `facility inbox` (list) and `facility inbox decide <id> approve|reject [--note]`
- `facility kickstart <project> --repo owner/name [--yes]` — remote kickstart (answers via flags/prompts, preview table, confirm)
- `facility upgrade <project> [--to <version>]`
- `facility keys issue|revoke|list`
- `facility llm-requests list [--project <id>] [--from <iso>] [--to <iso>] [--limit <n>] [--cursor <iso>]`
- `facility llm-requests get <id>` — export the stored request/response envelope; use `--json` to include row metadata and envelope together.
- Existing `init|add|doctor` untouched (vendored lane).
The CLI now also covers org/members/roles, repositories, agent definitions and
schedules, providers, budgets, registry, sandboxes, tasks, virtual keys, KB,
analytics, audit verification, integrations/events/deliveries, spend, proposals,
action-type discovery, and project health. Human tables are the default;
`--json` emits one stable JSON value (or JSONL for a watched stream), with no
diagnostics mixed into stdout. Exit codes: 0 success, 1 command/API error, 2 auth.

Keep the CLI testable: extract command handlers to functions taking {fetch, config, stdout}; node:test suites with a stub fetch. The e2e init tests keep passing untouched.

## Mechanical floor

```
pnpm install && pnpm build && pnpm typecheck && pnpm test && pnpm lint && node guards/run.mjs
```

Tests: MCP — spin the real server (stdio transport, in-proc) against a stubbed
SDK layer: exact tool list and schemas, reads, structured errors, proposal-only
writes, direct human decision, resources, prompts, replay idempotency, HTTP
Bearer/OAuth discovery, authority/origin validation, body bounds, health and
readiness. CLI — login and 0600 config, help without side effects, global flags,
status/runs/inbox/admin workflows, resumable and open-ended SSE, JSON/JSONL,
prompt EOF, exact request bodies, strict flags, structured failures and exit
codes.

## Judgment criteria

Tool descriptions read like a good API doc (an LLM must pick correctly among 79
tools); no tool bypasses confirmation; CLI stays zero-dep and its existing UX
voice; config never logged; every write path lands in the platform audit (verify
one in a test via stub assertion of the API call, the API side already audits).
