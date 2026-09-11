import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const lockName = "facility:migrations";
loadDotenv({ path: join(repoRoot, ".env"), quiet: true });

export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 60_000;
export const MAX_MIGRATION_LOCK_TIMEOUT_MS = 15 * 60_000;

type MigrationOptions = {
  migrationsDir?: string;
  log?: (message: string) => void;
};

type MigrationLockOptions = {
  pollMs?: number;
  timeoutMs?: number;
};

export type MigrationResult = {
  applied: string[];
  backfilled: string[];
  skipped: string[];
};

export class MigrationLockTimeoutError extends Error {
  readonly code = "migration_lock_timeout";
  readonly exitCode = 10;

  constructor(readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for the Facility database deployment lock`);
    this.name = "MigrationLockTimeoutError";
  }
}

export class MigrationChecksumError extends Error {
  readonly code = "migration_checksum_mismatch";
  readonly exitCode = 11;

  constructor(
    readonly file: string,
    readonly storedChecksum: string,
    readonly currentChecksum: string,
  ) {
    super(
      `applied migration ${file} changed: stored sha256 ${storedChecksum}, current sha256 ${currentChecksum}`,
    );
    this.name = "MigrationChecksumError";
  }
}

export class MigrationExecutionError extends Error {
  readonly code = "migration_execution_failed";
  readonly exitCode = 12;

  constructor(
    readonly file: string,
    cause: unknown,
  ) {
    super(`migration ${file} failed`, { cause });
    this.name = "MigrationExecutionError";
  }
}

export class LegacyDatabaseError extends Error {
  readonly code = "legacy_database_unsupported";
  readonly exitCode = 13;

  constructor() {
    super(
      "Facility 0.12 requires a new database; this database contains the Facility 0.11 run model and was not modified",
    );
    this.name = "LegacyDatabaseError";
  }
}

export async function migrate(connectionString = process.env.DATABASE_URL): Promise<void> {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const client = postgres(connectionString, { max: 1 });
  try {
    const release = await acquireMigrationLock(client);
    try {
      await applyMigrations(client);
    } finally {
      // Closing the max:1 client below also releases session locks. Preserve the
      // migration's real outcome if the explicit unlock loses its connection.
      await release().catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

export async function acquireMigrationLock(
  client: postgres.Sql,
  options: MigrationLockOptions = {},
): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
  const pollMs = Math.max(1, options.pollMs ?? 250);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > MAX_MIGRATION_LOCK_TIMEOUT_MS
  ) {
    throw new RangeError(
      `migration lock timeout must be an integer between 0 and ${MAX_MIGRATION_LOCK_TIMEOUT_MS}ms`,
    );
  }

  const startedAt = performance.now();
  while (true) {
    const rows = await client<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext(${lockName})) AS acquired
    `;
    if (rows[0]?.acquired) {
      let released = false;
      return async () => {
        if (released) return;
        await client`SELECT pg_advisory_unlock(hashtext(${lockName}))`;
        released = true;
      };
    }

    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs >= timeoutMs) throw new MigrationLockTimeoutError(timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, timeoutMs - elapsedMs)));
  }
}

export async function applyMigrations(
  client: postgres.Sql,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const log = options.log ?? console.log;
  const migrationsDir = options.migrationsDir ?? join(here, "..", "migrations", "v0.12");
  const legacy = await client<{ table_name: string | null }[]>`
    SELECT to_regclass('runs')::text AS table_name
  `;
  if (legacy[0]?.table_name) throw new LegacyDatabaseError();
  await client`CREATE TABLE IF NOT EXISTS _facility_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  // The metadata ledger is intentionally self-upgrading: adding a migration to
  // add this column would require verifying that migration before the column exists.
  await client`ALTER TABLE _facility_migrations ADD COLUMN IF NOT EXISTS checksum text`;

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const migrations = await Promise.all(
    files.map(async (file) => {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      return { file, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
  const appliedRows = await client<{ checksum: string | null; name: string }[]>`
    SELECT name, checksum FROM _facility_migrations
  `;
  const appliedByName = new Map(appliedRows.map((row) => [row.name, row.checksum]));

  // Validate every established checksum before applying or backfilling anything.
  // Legacy NULL rows are trusted once, because no historical digest exists to compare.
  for (const migration of migrations) {
    const storedChecksum = appliedByName.get(migration.file);
    if (storedChecksum && storedChecksum !== migration.checksum) {
      throw new MigrationChecksumError(migration.file, storedChecksum, migration.checksum);
    }
  }

  const result: MigrationResult = { applied: [], backfilled: [], skipped: [] };
  for (const migration of migrations) {
    if (appliedByName.has(migration.file)) {
      if (appliedByName.get(migration.file) === null) {
        await client`
          UPDATE _facility_migrations
          SET checksum = ${migration.checksum}
          WHERE name = ${migration.file} AND checksum IS NULL
        `;
        result.backfilled.push(migration.file);
        log(`${migration.file} checksum recorded`);
      } else {
        result.skipped.push(migration.file);
        log(`${migration.file} already applied`);
      }
      continue;
    }

    try {
      await client.begin(async (tx) => {
        await tx.unsafe(migration.sql);
        await tx`
          INSERT INTO _facility_migrations (name, checksum)
          VALUES (${migration.file}, ${migration.checksum})
        `;
      });
    } catch (error) {
      throw new MigrationExecutionError(migration.file, error);
    }
    result.applied.push(migration.file);
    log(`applied ${migration.file}`);
  }
  return result;
}
