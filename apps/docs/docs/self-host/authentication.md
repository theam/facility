---
title: Authentication
---

# Authentication

The web UI supports GitHub or OIDC sign-in. MCP uses OAuth 2.1 protected-resource discovery or a
Facility API key sent as a Bearer token. The identity resolves to an organization and, for scoped
keys, one project.

`FACILITY_OAUTH_JWKS` contains private ES256 signing keys. A WebCrypto export may include `ext` and
`key_ops: ["sign"]`; Facility accepts that shape and removes those annotations before publishing or
using the derived verification keys. A `key_ops` value that does not permit signing is rejected at
startup.

Any active project maintainer can read and continue the same story. Every project operation checks
organization and project scope. Cross-project lookups return 404 so scoped credentials cannot use
the API as an enumeration oracle.

Preview cookies are separate from control-plane sessions. A one-time handoff issues an expiring
preview cookie; each proxied request revalidates the user, project membership, workspace, service,
expiry, and revocation status.
