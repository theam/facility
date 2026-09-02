# Verification and workspace E2E policy

Facility has two acceptance tiers. A fast test run is useful feedback, but it is
not release evidence.

## Root acceptance

Run:

```bash
pnpm verify
```

The verifier checks formatting and types, performs a clean uncached build,
recreates only allowlisted test databases, runs database and API integration
suites directly, runs the remaining workspace tests, executes repository
guards, and audits dependencies. Reported skips in critical integration suites
are failures.

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

CI requires this tier for default-branch and release acceptance, and for pull
requests that change workspace execution boundaries. A path-based skip is
recorded only when those boundaries are untouched.
