# Verification and workspace E2E policy

Facility has two acceptance tiers. A fast test run is useful feedback, but it is
not release evidence. Use focused tests during implementation, but finish with
the tier required by the changed boundary. Never skip, relax, delete, or
reclassify an existing test or guard to make a change pass.

## Root acceptance

Run:

```bash
pnpm verify
```

The verifier performs these stages:

1. formatting and lint checks;
2. removal of stale generated outputs;
3. TypeScript checking and a clean cache-disabled build;
4. isolated local PostgreSQL startup;
5. critical database and API integration suites with skips forbidden;
6. the remaining uncached package tests;
7. unused-reference and repository guard checks; and
8. dependency auditing.

Tests use allowlisted disposable databases. Do not override their URLs with a
database that contains useful data.

## Focused feedback

Common commands include:

```bash
pnpm --filter @facility/agents test
pnpm --filter @facility/api test
pnpm --filter @facility/mcp test
pnpm --filter @theagilemonkeys/facility test
pnpm --filter @facility/web typecheck
pnpm --filter @facility/docs test
pnpm --filter @facility/docs build
node guards/run.mjs
```

Use deterministic fakes or local servers for GitHub, OAuth, Vercel, engine, and
other external behavior. The default suite must not need network access or live
credentials.

## Docker-backed workspace E2E

Build the durable development image, then run the workspace acceptance tier:

```bash
docker build -f runner/Dockerfile -t facility-runner:dev .
FACILITY_E2E_DOCKER=1 \
DATABASE_URL=postgres://facility:facility@127.0.0.1:5461/facility_ws \
FACILITY_WORKSPACE_TEST_IMAGE=facility-runner:dev \
pnpm test:e2e-workspace
```

This tier creates a persistent workspace, exercises its nested Docker daemon,
replaces compute while retaining the worktree and native session files, opens
an authenticated preview, and verifies that archive and suspension retain the
volume. Explicit deletion must remove only the selected volume.

Run it when changing workspace provider semantics, runtime interfaces, the
runner, repository checkout and preparation, nested Docker, GitHub credentials,
native engine session persistence, preview HTTP/WebSocket routing, browser
artifacts, suspension, archive/restore, or deletion.

CI requires this tier for default-branch and release acceptance, and for pull
requests that change workspace execution boundaries. A path-based skip is
recorded only when those boundaries are untouched.

## Critical security and money paths

Authentication, authorization, tenant scoping, secrets, cryptography, billing,
budgets, webhook signatures, previews, and privileged external integrations
need both unit and integration coverage. Test success and applicable malformed,
expired, revoked, replayed, and cross-tenant denials. Add a regression that
would fail if the previous unsafe behavior returned.

Cost tests must distinguish a real zero from unavailable usage or pricing.
Scanner and CI mirror tests must distinguish clean/current from unavailable or
stale data.

## Manual verification

UI changes require a browser pass over loading, empty, error, denied, and
successful states. Story-loop changes require the real workspace where the
behavior depends on files, Docker, browser preview, GitHub, or engine sessions.

Record the setup, exact actions, and observed result. Keep private repository
content and credentials out of screenshots and artifacts.

## Documentation

Documentation changes run the docs test suite, Docusaurus production build,
and Markdown link guard. Contract tests should protect required subjects,
fields, and lifecycle warnings rather than line counts.

## Evidence in a pull request

List the exact commands that ran and their results. Distinguish deterministic
automation from manual browser/provider checks. Include the relevant failure
output when a check is blocked. Do not report a check as passing when it was
not run.
