---
title: Local development
---

# Local development

Install Node.js 24 LTS and pnpm 11.20.0 before running the repository:

```bash
corepack install --global pnpm@11.20.0
```

`pnpm dev` starts PostgreSQL, builds shared packages, applies migrations, and runs the API, worker,
UI, and documentation site. The worker needs access to the local Docker daemon to create persistent
workspace containers and volumes. Development mode seeds a local owner; use **continue locally** on
the login page. This route is restricted to loopback URLs and cannot be enabled in production.

Use these checks while developing:

```bash
pnpm --filter @facility/agents test
pnpm --filter @facility/api test
pnpm --filter @facility/mcp test
pnpm --filter @facility/web typecheck
pnpm verify
```

Set `FACILITY_E2E_DOCKER=1` to run the Docker replacement test. It creates a named volume, writes
state, suspends and replaces compute, then verifies that the same files remain.

GitHub cannot send webhooks to localhost. Use an HTTPS tunnel and set its payload URL to
`https://<api-host>/webhooks/github`. Match `WEB_URL`, `PUBLIC_URL`, OAuth callback URLs, and the
preview origin to the host used by the browser.
