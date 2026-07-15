# Verification and sandbox E2E policy

Facility has two acceptance tiers. A green fast test run is not release evidence.

## Root acceptance

Run:

```bash
pnpm verify
```

This command fails unless all of the following execute successfully:

1. repository lint and typecheck;
2. every declared build output removed, then every workspace rebuilt with the
   Turbo cache disabled;
3. database, API, and gateway integration suites invoked directly (not through
   Turbo), against `facility_test` and `facility_gw`; any reported skip is a
   failure;
4. all remaining workspace tests with the Turbo cache disabled;
5. deterministic repository guards; and
6. `pnpm audit --audit-level high`.

The verifier starts the development Postgres container when needed, creates only
the isolated test databases, and stops the container afterward when it started it.
Tests must never point at the `facility` development tenant or a production URL.

CI also runs `docker compose build --pull` from a clean checkout. This is the gate
for the documented self-host images and catches missing workspace build artifacts
that a host build can accidentally hide.

## Docker-backed sandbox E2E

The sandbox E2E provisions a real runner container, sends steering through the
API, waits for the governed session to finish, checks its receipt/events, verifies
credential revocation, and confirms the container was destroyed.

It may be skipped only for:

- local feedback where Docker or the runner image is unavailable; or
- a pull request whose diff does not touch `runner/`, the API sandbox
  orchestrator/driver, the root service Dockerfile, `runner/Dockerfile`, either
  Compose file, or the sandbox E2E itself. The web-only Dockerfile does not alter
  sandbox execution boundaries and is covered by the self-host image gate.

It is required for:

- every push to the default branch and every release candidate; and
- every pull request that changes any sandbox execution boundary listed above.

The CI policy step enforces those rules and records the reason for every allowed
skip. A release must never be cut from a run where the sandbox E2E was required but
skipped.

To run the tier locally after preparing the runner image and `facility_sbx`
database:

```bash
FACILITY_E2E_DOCKER=1 \
DATABASE_URL=postgres://facility:facility@127.0.0.1:5461/facility_sbx \
pnpm test:e2e-sandbox
```
