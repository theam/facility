---
title: 0.12 database boundary
---

# Moving from 0.11 to 0.12

0.12 is a clean product and schema boundary. It does not migrate governed runs, internal approval
objects, receipts, request envelopes, budget ledgers, registry definitions, disposable sandboxes,
or independent preview deployments.

Before trying 0.12:

1. Stop 0.11 writers.
2. Create and verify a database backup.
3. Preserve any Git branches, pull requests, transcripts, or reports needed outside Facility.
4. Point 0.12 at a new empty database and run its migrations.
5. Bind the instance, reconnect repositories, and merge the new kickstart files.

If the migration command detects a 0.11 `runs` table, it exits with a specific error before
creating a migration ledger or changing schema objects. To roll back the application, stop 0.12
and restart 0.11 against its untouched 0.11 database; do not share one database between versions.
