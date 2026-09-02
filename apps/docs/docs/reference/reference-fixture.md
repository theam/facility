---
title: Reference fixture and measurements
---

# Reference fixture and measurements

The Facility 0.12 reference project is in
`services/api/test/fixtures/reference-project`. It contains a browser-facing application, a JSON
API, a file-backed database service, deterministic seed data, a Compose file, a Chromium flow, and
sample builder and scheduled-security agents. It has no network or credential dependency.

From a clean checkout, run:

```bash
corepack install --global pnpm@11.20.0
pnpm install --frozen-lockfile
docker build -f runner/Dockerfile -t facility-runner:dev .
FACILITY_E2E_DOCKER=1 \
  FACILITY_WORKSPACE_TEST_IMAGE=facility-runner:dev \
  pnpm --filter @facility/api exec vitest run \
  --fileParallelism=false --disableConsoleIntercept \
  test/workspace-runtime.integration.test.ts
```

The command creates isolated temporary workspaces and deletes them in `finally` blocks. It proves:

- the app, API, database, seed, and Chromium run through nested Compose;
- a caller outside the workspace needs the internal preview credential;
- cancellation stops one command without stopping the live application;
- replacing compute reattaches the same files and native session marker;
- Compose can rebuild after replacement without losing project data;
- a checksummed backup restores untracked work, session state, and seed data into a fresh workspace;
  and
- explicit deletion removes both source and restored test volumes.

## Recorded local result

Run on 2 September 2026 with the Docker provider and `facility-runner:dev`:

| Measurement | Result |
|---|---:|
| Workspace create | 542 ms |
| Compose build and start | 1,401 ms |
| Chromium flow | 1,023 ms |
| Wake after compute replacement | 1,315 ms |
| Active compute cost | Not metered by local Docker |
| Suspended storage cost | Not metered by local Docker |

These values are evidence from one machine, not performance targets. Hosted active and suspended
costs remain provider data. Facility exposes usage when the provider reports it and marks monetary
cost unavailable instead of inventing a price.

The broader deterministic journey runs kickstart, the embedded MCP endpoint, both fake engines,
all six standard agents, GitHub and schedule events, preview routing, archive/restore, and explicit
deletion:

```bash
pnpm --filter @facility/api exec vitest run --fileParallelism=false \
  test/facility-012.e2e.integration.test.ts
```

The hosted pilot and 14-calendar-day retention run are separate release gates. A local pass must
not be used to mark either one complete.
