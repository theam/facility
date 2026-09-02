---
title: Authentication modes
---

# Authentication modes

Facility uses GitHub as its human identity source and never stores upstream access tokens.
Every instance is dedicated to one Facility organization, one GitHub account, and one GitHub
App installation. A login succeeds only when the stable numeric GitHub user ID belongs to an
explicit Facility member and the user can access the configured installation.

## Direct GitHub for local and self-hosted instances

Create a GitHub App for the installation, enable user authorization, grant read access to email
addresses, and set its callback URL to the exact web-origin URL
`https://<web-host>/api/auth/callback`. Configure:

```dotenv
AUTH_IDENTITY_PROVIDER=github
AUTH_CALLBACK_URL=https://app.example.com/api/auth/callback
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
# Optional: require active membership in this GitHub organization
GITHUB_OAUTH_ALLOWED_ORGANIZATION=example
```

The organization setting accepts a GitHub organization login, not a URL. When
set, Facility verifies that the authenticated user has an active membership
before resolving their Facility invitation. When blank or unset, any GitHub
user who satisfies the existing explicit-member and App-installation checks can
sign in. The setting is available only in direct `github` mode.

For an unlinked account, Facility compares an explicit email invitation with
every verified email returned by GitHub, not only the primary address. This
allows a company email to remain secondary. Exactly one Facility user must
match; ambiguous matches fail closed. After the first successful login,
Facility binds the member to GitHub's stable numeric user ID.

After migrations and the non-demo seed, run:

```bash
DATABASE_URL=postgres://... facility instance bootstrap \
  --org-name "Example" --org-slug example \
  --owner-email owner@example.com --owner-name "Owner" \
  --github-user-id 123 --github-login owner \
  --github-account-id 456 --github-account-login example \
  --github-installation-id 789 \
  --github-account-type organization
```

The command connects directly to PostgreSQL, is idempotent for the exact same binding, and refuses
to modify a database containing a different instance. When you run the source
CLI rather than the API image's one-shot operator command, reconcile the new
organization immediately afterward:

```bash
DATABASE_URL=postgres://... FACILITY_SEED_DEMO=0 pnpm --filter @facility/db run deploy
```

The API image performs this reconciliation automatically in the same bootstrap
task.

## SaaS OIDC broker

SaaS instances do not hold the shared GitHub App secret. The commercial service completes GitHub
OAuth and acts as an OIDC issuer; each dedicated instance is an OIDC client. Configure the issuer,
client credentials, and stable instance ID. The signed ID token must include verified
`github_user_id`, `github_login`, `email`, `email_verified=true`, `github_account_id`,
`github_installation_id`, and `facility_instance_id` claims. Facility validates signature, issuer,
audience, nonce, instance, account, and installation before creating its own session.

## MCP OAuth

The upstream mode does not change MCP trust. Every instance issues its own MCP tokens so they are
audience-bound and revocable within that instance. Supply a persistent private ES256 JWK set via
`FACILITY_OAUTH_JWKS`; put a new signing key first and retain old signing keys through the maximum
token lifetime when rotating them. The configured set contains private keys; Facility publishes only
their public parameters from `/oauth/jwks`.

Generate a key set with Node alone:

```bash
node -e '
const { generateKeyPairSync, randomUUID } = require("node:crypto");
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = privateKey.export({ format: "jwk" });
console.log(JSON.stringify({ keys: [{ ...jwk, kid: randomUUID(), alg: "ES256", use: "sig" }] }));
'
```

A key exported through WebCrypto (`crypto.subtle.exportKey("jwk", ...)`) also works. It carries
`key_ops` and `ext` members; Facility drops those on load, because a set marked
`"key_ops": ["sign"]` describes the private half and would otherwise be rejected as a verification
key by this instance and by anyone else reading `/oauth/jwks`. A `key_ops` that does not permit
`sign` is refused at startup: this variable holds the keys the instance signs with, so a set that
forbids signing is a contradiction rather than a restriction to honour.
