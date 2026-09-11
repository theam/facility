---
title: Testing
---

# Testing Facility changes

Use the narrowest relevant test while iterating, then run the repository acceptance command before
delivery. Passing tests are necessary evidence, but the acceptance behavior must also match the
change's intent.

## Full acceptance

```bash
pnpm verify
```

The verifier runs formatting and lint checks, removes stale build outputs, performs a clean
cache-disabled build, starts an isolated local PostgreSQL service, runs critical database and API
integration suites with skips forbidden, runs remaining tests without cache, checks unused
references, executes repository guards, and audits dependencies at all configured severities.

Do not weaken, skip, delete, or reclassify an existing test or guard to obtain a pass. Fix the
behavior or explain a genuine external blocker.

## Focused commands

```bash
pnpm --filter @facility/agents test
pnpm --filter @facility/api test
pnpm --filter @facility/mcp test
pnpm --filter @theagilemonkeys/facility test
pnpm --filter @facility/web typecheck
pnpm --filter @facility/web build
pnpm --filter @facility/docs test
pnpm --filter @facility/docs build
node guards/run.mjs
```

Use a package's own `package.json` for additional scripts. A focused command should fail for the bug
or missing behavior before the fix when practical.

## Database integration tests

Database, API authorization, story lifecycle, cost, budget, webhook, and credential behavior belong
in deterministic integration tests. Tests create allowlisted disposable databases and use local
fakes or servers for external systems. The default suite must not require live GitHub, Vercel, model
provider, OAuth, or internet credentials.

Critical security- and money-related changes require unit and integration tests covering success
and relevant denials: malformed, expired, revoked, replayed, and cross-tenant inputs as applicable.
Include a regression that fails under the previous unsafe behavior.

## Docker-backed workspace E2E

Build the runner and execute the workspace tier:

```bash
docker build -f runner/Dockerfile -t facility-runner:dev .
FACILITY_E2E_DOCKER=1 \
DATABASE_URL=postgres://facility:facility@127.0.0.1:5461/facility_ws \
FACILITY_WORKSPACE_TEST_IMAGE=facility-runner:dev \
pnpm test:e2e-workspace
```

This tier must prove that a named volume survives suspension and compute replacement, the worktree
and native engine session files remain, nested Docker works without the host socket in agent
compute, authenticated HTTP/WebSocket preview reaches the live environment, archive retains state,
and explicit deletion removes only the selected volume.

Run it for changes to the runtime interface, Docker/Vercel provider semantics, runner, repository
preparation, credentials, previews, browser artifacts, workspace lifecycle, or deletion. CI applies
the same policy and records path-based skips only when execution boundaries are untouched.

## UI and browser verification

Type checking and rendering tests do not prove a user flow. For a UI change, start `pnpm dev` and
exercise the changed path in a browser. Cover loading, empty, error, denied, and successful states
that the change can produce. For story and preview work, use a disposable repository and the actual
API rather than static fixture-only behavior.

Record the route, setup state, actions, and observed result. Add screenshots when visual review
needs them, while keeping credentials and private repository content out of artifacts.

## Documentation verification

Run both docs tests and the production build. The tests protect links and required contract
coverage; the build validates MDX, sidebar ids, and generated routes. Preview navigation after
adding or moving pages.

Documentation tests should assert durable subjects and schema fields, not prose length. A shorter
page can be complete, while a long page can omit an essential destructive or failure path.

## Terraform and deployment changes

Run formatting, validation, and the module's Terraform tests. Review the plan for replacement or
destruction. Container changes require building the relevant image for the target architecture.
Migration changes require a one-shot migration test against a fresh database and the supported
upgrade boundary.

## Reporting evidence

In the pull request, list exact commands and whether they passed. Include failure output for an
unresolved blocker. Do not claim a command passed if it was not run, and distinguish a deterministic
automated check from a manual browser or provider validation.
