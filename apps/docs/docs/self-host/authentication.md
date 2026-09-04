---
title: Authentication
---

# Authentication

Facility has three related authentication surfaces: browser sign-in for the UI, Bearer
authentication for the HTTP API, and OAuth or API-key authentication for MCP. They resolve to the
same organization, membership, role, and optional project scope.

## Browser sign-in

The web UI supports GitHub or OIDC sign-in. MCP uses OAuth 2.1 protected-resource discovery or a
Facility API key sent as a Bearer token. The identity resolves to an organization and, for scoped
keys, one project.

For GitHub identity set:

```text
AUTH_IDENTITY_PROVIDER=github
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
GITHUB_OAUTH_ALLOWED_ORGANIZATION=acme
```

The allowed organization is optional and must be a GitHub login, not a URL. Client id and secret
must be configured together. The OAuth callback is the exact
`<WEB_URL>/api/auth/callback` URL registered with GitHub.

For OIDC identity set:

```text
AUTH_IDENTITY_PROVIDER=oidc
OIDC_ISSUER=https://identity.example.com
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
FACILITY_INSTANCE_ID=facility-production
```

OIDC mode requires issuer, client id, and a stable Facility instance id. The client secret depends
on the provider. GitHub organization restriction is not accepted in OIDC mode.

`FACILITY_INSECURE_DEV=1` exposes the local owner shortcut only when both public and web URLs are
loopback. It is rejected under `NODE_ENV=production` and must never be used through a tunnel.

## API keys

An owner or authorized administrator creates API keys through the UI or `/v1/keys`. The plaintext
token is returned once. Keys can be organization-wide according to their role or restricted to one
project. Send the token as:

```http
Authorization: Bearer <facility-api-key>
```

Project-scoped keys cannot call organization-administration endpoints and receive 404 when they ask
for another project. Revoke keys when their automation is retired or compromised; existing
workspace and conversation data remain governed by the project rather than by the key that created
it.

## MCP interactive OAuth

Set all three values to enable Facility's browser authorization server for MCP clients:

```text
FACILITY_OAUTH_ISSUER=https://facility.example.com
MCP_PUBLIC_URL=https://api.facility.example.com/mcp
FACILITY_OAUTH_JWKS={"keys":[...]}
```

The issuer must be the `WEB_URL` origin and the callback must be exactly its
`/api/auth/callback`. Production URLs use HTTPS. Facility publishes protected-resource metadata for
the MCP resource, supports dynamic client registration, uses authorization code with PKCE S256,
and rotates refresh tokens. Access tokens are resource-bound to the configured MCP URL and carry
the `facility:mcp` scope.

MCP access tokens last 15 minutes, authorization codes 10 minutes, and refresh grants and tokens 30
days. Browser sessions last seven days. Treat those defaults as maximum persistence, not a reason
to delay revocation after membership changes.

The [MCP reference](../reference/mcp.md) contains client examples and the full tool contract.

## Signing keys

`FACILITY_OAUTH_JWKS` contains private ES256 signing keys. A WebCrypto export may include `ext` and
`key_ops: ["sign"]`; Facility accepts that shape and removes those annotations before publishing or
using the derived verification keys. A `key_ops` value that does not permit signing is rejected at
startup.

Each JWK must be a private P-256 EC key with `kty: "EC"`, `crv: "P-256"`, `x`, `y`, `d`, and a
unique non-empty `kid`. Facility derives public verification keys from this private set. Keep old
verification keys available for a controlled overlap when rotating signers, then remove them after
all issued access tokens have expired.

Do not store the private JWKS in the database, repository, image, or Terraform state. Supply it to
the API from the deployment secret store.

## Authorization behavior

Any active project maintainer can read and continue the same story. Every project operation checks
organization and project scope. Cross-project lookups return 404 so scoped credentials cannot use
the API as an enumeration oracle.

Roles and route permissions govern humans and API keys. They do not change an agent manifest into
a restricted workspace profile: once a principal is allowed to execute an agent in a project, the
agent receives Facility's uniform maintainer-level project capability.

Successful privileged mutations create durable audit events. Authentication failures and denied
requests remain available in structured service logs and can be correlated with `x-request-id`.

## Preview authentication

Preview cookies are separate from control-plane sessions. A one-time handoff issues an expiring
preview cookie; each proxied request revalidates the user, project membership, workspace, service,
expiry, and revocation status.

The preview origin must be on a different registered site from Facility control origins. Opening a
service creates a one-time handoff; consuming it sets a host-only preview cookie. The preview proxy
rechecks membership on each HTTP request and WebSocket upgrade, so revoking membership, the
session, or the workspace stops continued access.

Never send a Facility API key, OAuth token, or control-plane session cookie to the application
running inside a preview.

## Bootstrap and recovery

Run `facility instance bootstrap` only after migrations and built-in roles exist. It binds the
first owner to one GitHub identity and installation under a database advisory lock. Save the input
identifiers in the operator runbook, not in public logs.

If the identity provider is unavailable, do not enable the insecure development path on a public
instance. Restore provider service or use an already provisioned administrative API key according
to your incident policy, then audit every change made during recovery.
