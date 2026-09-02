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
