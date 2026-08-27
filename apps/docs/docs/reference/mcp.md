---
title: MCP
---

# MCP server

Manage Facility from Claude Code, Cowork, Codex, or any MCP client — with
the same RBAC and audit as every other surface.

## Connect

Local (stdio). `@facility/mcp` is not published to a public registry, so build it
from the repo (`pnpm --filter @facility/mcp build`) and point the client at the
built binary (`packages/mcp/dist/bin/facility-mcp.js`). With no subcommand it
speaks MCP over stdio:

```json
{
  "mcpServers": {
    "facility": {
      "command": "node",
      "args": ["/abs/path/to/facility/packages/mcp/dist/bin/facility-mcp.js"],
      "env": {
        "FACILITY_API_URL": "https://facility.yourorg.com",
        "FACILITY_API_KEY": "fak_…"
      }
    }
  }
}
```

Remote: run the same built binary with `node
/absolute/path/to/facility/packages/mcp/dist/bin/facility-mcp.js serve`; the bundled
compose stack already includes it, while other deployments host it next to the
control plane. It exposes streamable HTTP at `https://<mcp-host>/mcp` with
`Authorization: Bearer <credential>`.
Two credential kinds are accepted: a `fak_…` API key (for non-interactive services) or a Facility
OAuth access token (for interactive clients like Claude, Cursor, and ChatGPT). Interactive
clients discover the flow from the RFC 9728 path-aware metadata URL
`/.well-known/oauth-protected-resource/mcp` (advertised on a `401` via
`WWW-Authenticate`). The former `/.well-known/oauth-protected-resource` URL remains a discovery
alias during upgrades, but Facility never advertises that alias or associates it with the legacy
`POST /` transport path. Each instance publishes authorization metadata, dynamic client registration,
PKCE authorization, revocation, and JWKS endpoints. Tokens are bound to the canonical
`MCP_PUBLIC_URL` resource ending in `/mcp`; an origin-only value is accepted and normalized for
backward-compatible deployments. It must use HTTPS unless it names a loopback development host.
Configure the API with `FACILITY_OAUTH_ISSUER` set to the web
origin and `FACILITY_OAUTH_JWKS`, then point the MCP process's `MCP_AUTHORIZATION_SERVER` at that
same issuer. `MCP_AUTHORIZATION_SERVER` must be an HTTPS origin; HTTP is accepted only for a
loopback development origin. The web origin proxies `/.well-known/*` and `/oauth/*` to the API so authorization,
interaction, GitHub login/callback, and resume retain host-only cookies on one browser origin.

### Breaking upgrade: same-origin, path-aware OAuth

This OAuth layout changes both token identity boundaries: the issuer moves from the API origin to
the web origin, and the resource/audience moves from the MCP origin to the canonical `/mcp` URL.
Treat the upgrade as breaking for interactive MCP clients.

1. Update deployment configuration or Terraform **before deploying the new API, web, and MCP
   images**. Set `WEB_URL` and `FACILITY_OAUTH_ISSUER` to the same canonical origin,
   `AUTH_CALLBACK_URL` to exactly `<WEB_URL>/api/auth/callback`, `MCP_PUBLIC_URL` to the MCP origin
   or `/mcp`, and `MCP_AUTHORIZATION_SERVER` to the web origin. Production endpoints require HTTPS.
2. Deploy API, web, and MCP together. Do not leave an API-origin issuer or origin-only token
   audience active behind only part of the new runtime.
3. Reconnect every interactive MCP client. Existing access tokens, refresh flows, and browser OAuth
   sessions must be treated as invalid after the issuer/audience transition; `fak_` API keys are
   unchanged.

For `pnpm dev`, inspect a pre-existing `.env`: older copies used
`FACILITY_OAUTH_ISSUER=http://localhost:4400` and
`MCP_AUTHORIZATION_SERVER=http://localhost:4400`. Change both to
`http://localhost:3400`; keep `AUTH_CALLBACK_URL=http://localhost:3400/api/auth/callback`.
Fresh `.env.example` values are already aligned. The dev launcher preserves non-empty legacy
values rather than rewriting operator configuration.

Remote binds fail closed unless `MCP_ALLOWED_HOSTS` or `MCP_PUBLIC_URL` names a
trusted authority. Browser `Origin` is checked against the same set, request
bodies are bounded, `/healthz` reports the MCP process, and `/readyz` checks the
upstream API. Bearers are validated with the control plane before MCP protocol
admission, so invalid credentials cannot enumerate tools, resources, or prompts.
If validation is unavailable, admission fails closed with `503` and `Retry-After`.
When a known reverse proxy terminates TLS, set `MCP_TRUST_PROXY_HOPS` to its
exact hop count so per-client rate limits use the trusted `X-Forwarded-For`
address; the default `0` ignores forwarded headers.

## Tools

The tool catalog is immutable for the lifetime of a server process and does not
advertise `tools.listChanged`; reconnect after a deployment to discover its catalog.

The 79 tools cover identity, org/members/roles/keys, projects/repos/health,
agents/status/runs/paged events/transcripts, durable conversations, GitHub App
discovery and issue workflows, outcomes, HITL/action types, issues,
budgets/spend/raw LLM envelopes, registry, sandboxes/tasks/virtual keys, KB,
analytics/audit, the capability catalog, kickstart/upgrade, and integration
event/delivery history. Tool inputs and structured outputs are JSON Schema,
descriptions name their required permission, and API errors preserve
status/code/details with MCP `isError` set.

Mutations include run trigger/steer/interrupt/resume/cancel; conversation start
and send; GitHub issue sync and trigger; project/agent/repo/task/KB/registry
creation or transition; issue acknowledgement/resolution; webhook retry;
budgets; kickstart; and upgrade. Every intended mutation is recorded as a
durable proposal first.

## The approval pattern

A write tool creates a human-in-the-loop proposal and does nothing else. A
separate principal with `hitl:decide` reviews the proposal in the HITL inbox
and approves or rejects it through the CLI or API. MCP deliberately exposes no
decision tool: untrusted model output cannot invoke an approval. MCP write keys are refused if they also carry
`hitl:decide`, so the same key cannot propose and approve its own write. Use the
bundled `operator` role for an AI client and an owner/admin human principal for
the decision. The operator grants cover standard project, repository, agent,
run, registry, budget, KB, task, and issue mutations. Tools outside those grants
need a custom role that still omits `hitl:decide`; webhook delivery retry, for
example, additionally requires `integrations:write`. Proposal idempotency hashes the tool, JSON-RPC request id, and
canonical arguments, so retries replay while reused ids with different inputs
cannot collide. Immediately before execution, Facility revalidates that the
original requester still exists, is active, retains the required permission,
remains within the target project scope, and still cannot decide HITL. Revoked
or downgraded requesters therefore produce an explicit failed execution and no
side effect.

This is deliberately the complete **AI-operable** surface, not a credential
administration backdoor. Secret issuance/rotation, member and role changes,
provider credentials, API keys, proposal decisions, and other human-accountability
operations stay in the CLI and API. An MCP client can discover those resources
but cannot bypass the separate human principal required to authorize them.

Clients can enumerate `facility://me`, visible projects, and recent runs;
project/run URI templates support completion and run resources include recent
events. Prompts provide org status, cost review, and run triage with an optional
`runId`.
