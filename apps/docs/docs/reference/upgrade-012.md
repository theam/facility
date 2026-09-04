---
title: 0.12 database boundary
---

# Moving from 0.11 to 0.12

0.12 is a clean product and schema boundary. It does not migrate governed runs, internal approval
objects, receipts, request envelopes, legacy gateway ledgers, registry definitions, disposable sandboxes,
or independent preview deployments.

Configure 0.12 budgets again after connecting each project. Cost and budget data starts with the
new story-turn model; the release does not import historical gateway usage.

## Back up 0.11

Stop every 0.11 API, worker, scheduler, and maintenance process before taking the backup. Replace
the example URL and destination with operator-controlled values:

```bash
pg_dump --format=custom --no-owner \
  --file=facility-011.dump \
  'postgres://facility@database.example.com/facility_011'
sha256sum facility-011.dump > facility-011.dump.sha256
sha256sum --check facility-011.dump.sha256
pg_restore --list facility-011.dump > facility-011.contents
```

Preserve Git branches, pull requests, transcripts, and reports that must remain available outside
the old Facility database. Keep the dump and its checksum until the 0.12 pilot, retention run, and
rollback window have closed.

## Update repository contracts

Regenerate or update `.agents/*.md` before connecting a repository. The 0.12 schema accepts only
`reasoning_effort` under `options`; remove the former `max_turns` field. Permission, sandbox, and
tool-allowlist fields are also rejected because every agent now receives the same full workspace
and project GitHub capability. One invalid manifest prevents that repository's catalog from being
activated, so run kickstart validation before the setup pull request is merged.

Names listed in `.facility.yml` under `environment.secrets` or `environment.variables` now resolve
only from `FACILITY_PROJECT_<PROJECT_ID>_<NAME>` in the API and worker environment. Move existing
engine and project values into that namespace; Facility never reads a repo-declared name directly
from the control-plane environment.

## Install 0.12 beside it

Create a different, empty database. Do not rename or reuse the 0.11 database:

```bash
createdb facility_012
DATABASE_URL='postgres://facility@database.example.com/facility_012' \
  pnpm --filter @facility/db migrate
```

Then bind the 0.12 instance, reconnect the selected repositories, inspect the full-maintainer GitHub
App permissions, and merge each repository's kickstart configuration pull request. Run one
disposable story through MCP and the UI before moving normal work.

The clean-install and rejection guarantees are executable:

```bash
pnpm --filter @facility/db test
FACILITY_E2E_DOCKER=1 \
  FACILITY_WORKSPACE_TEST_IMAGE=facility-runner:dev \
  pnpm --filter @facility/api test:e2e-workspace
```

If the migration command detects a 0.11 `runs` table, it exits with a specific error before
creating a migration ledger or changing schema objects. Its integration test compares schema state
before and after the refusal.

## Validate 0.12 workspace recovery

Facility's runtime archive is separate from the Postgres dump. The Docker and fake conformance tests
export a checksummed archive, restore it under a new workspace identity, and compare the worktree,
untracked files, native Claude/Codex session markers, and project seed data. The archive excludes
the rebuildable nested-Docker cache and provider identity files. This archive transport is a runtime
conformance fixture in 0.12, not a public operator API; it intentionally avoids presenting a
whole-volume base64 transfer as production backup infrastructure. Operators must include Docker
named volumes or Vercel snapshots in their infrastructure backup policy and test that provider's
restore path.

Never use `facility_delete_workspace` until the database backup and provider-volume backup have
been verified. Archive and suspend are reversible and are not substitutes for a disaster-recovery
backup.

## Roll back

Stop all 0.12 writers and restart the 0.11 release against the untouched 0.11 database. Restore the
verified dump to a new database only when the original 0.11 database is unavailable:

```bash
createdb facility_011_restored
pg_restore --no-owner \
  --dbname='postgres://facility@database.example.com/facility_011_restored' \
  facility-011.dump
```

Do not point 0.11 at the 0.12 database or 0.12 at the 0.11 database. Physical cleanup of either
database or any workspace volume is a later explicit operator action.
