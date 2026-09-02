---
title: "ADR 003: MCP and UI authentication"
---

# ADR 003: MCP and UI authentication

Status: accepted for Facility 0.12

## Decision

The API is the OAuth authorization server and the MCP resource server. Streamable HTTP MCP is
mounted at `/mcp` in the API process. Browser sessions and interactive MCP clients use the same
human identity. Non-interactive clients use revocable service API keys.

Authorization remains tenant and project scoped. A project maintainer can create, continue,
suspend, archive, restore, preview, or explicitly delete that project's stories. A caller scoped to
another project receives a not-found response so the API does not become a cross-tenant existence
oracle.

Agent manifests do not contain permissions. Once Facility authorizes a turn for a project, every
agent receives the same workspace and GitHub capability.

## Consequences

- The standalone MCP HTTP service is removed.
- MCP mutations execute after ordinary authentication and authorization; they do not create HITL
  proposals.
- OAuth expiry, API-key revocation, malformed credentials, and cross-project access remain covered
  by unit and integration tests.
- Destructive workspace deletion requires a fresh explicit request, `confirm: true`, and an
  idempotency key. It does not introduce a general approval engine.

## Evidence

OAuth tests exercise PKCE, audience and scope checks, refresh-token rotation, and replay rejection.
API-key and membership tests cover revocation and cross-tenant denial. The reference journey calls
the embedded MCP endpoint with a signed token and compares its story response with the UI API
response for the same record.

## Alternatives tested

- Browser cookies work for the UI but were rejected as the MCP credential because non-browser
  clients need OAuth or service credentials.
- API keys work for unattended clients but were rejected as the only interactive mechanism because
  they cannot carry the browser login flow.
- A standalone MCP process was tested by the earlier deployment and removed because it duplicated
  authentication and application routing without adding a trust boundary.

## Ownership boundary

The identity provider proves the person. Facility maps that identity to an organization and project
role, issues or validates the MCP credential, and authorizes the operation. The MCP layer does not
reimplement project authorization.

## Revisit when

Revisit this split if MCP transport requirements change, if the control API can no longer act as
the OAuth authorization server, or if a deployment needs machine identity that service API keys
cannot represent.
