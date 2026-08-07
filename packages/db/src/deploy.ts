import postgres from "postgres";
import {
  acquireMigrationLock,
  applyMigrations,
  DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  MAX_MIGRATION_LOCK_TIMEOUT_MS,
} from "./migrate.js";
import { seedWithClient } from "./seed.js";

export type DatabaseDeployPhase = "deploy" | "lock" | "migrations" | "reconciliation";

export type DatabaseDeployEvent = {
  event: "facility.db.deploy";
  phase: DatabaseDeployPhase;
  status: "started" | "completed" | "failed";
  durationMs?: number;
  errorCode?: string;
  message?: string;
  migrationsApplied?: number;
  migrationsBackfilled?: number;
  migrationsSkipped?: number;
};

export type DatabaseDeployOptions = {
  includeDemoData?: boolean;
  lockPollMs?: number;
  lockTimeoutMs?: number;
  log?: (event: DatabaseDeployEvent) => void;
};

export class DatabaseDeployConfigError extends Error {
  readonly code = "database_deploy_config_invalid";
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "DatabaseDeployConfigError";
  }
}

function defaultLogger(event: DatabaseDeployEvent): void {
  console.log(JSON.stringify(event));
}

function durationMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "database_deploy_failed";
}

export function databaseDeployExitCode(error: unknown): number {
  if (
    error &&
    typeof error === "object" &&
    "exitCode" in error &&
    typeof error.exitCode === "number"
  ) {
    return error.exitCode;
  }
  return 1;
}

// `seed` remains convenient for local demo setup, but the production-shaped
// deploy entry point must never create a privileged demo tenant by omission.
export function databaseDeployIncludesDemoData(value: boolean | undefined): boolean {
  return value === true;
}

export function databaseDeployLockTimeout(
  value = process.env.FACILITY_DB_DEPLOY_LOCK_TIMEOUT_MS,
): number {
  if (value === undefined || value === "") return DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_MIGRATION_LOCK_TIMEOUT_MS) {
    throw new DatabaseDeployConfigError(
      `FACILITY_DB_DEPLOY_LOCK_TIMEOUT_MS must be an integer between 0 and ${MAX_MIGRATION_LOCK_TIMEOUT_MS}`,
    );
  }
  return parsed;
}

export async function deployDatabase(
  connectionString = process.env.DATABASE_URL,
  options: DatabaseDeployOptions = {},
): Promise<void> {
  if (!connectionString) throw new DatabaseDeployConfigError("DATABASE_URL is required");
  // The entry point emits newline-delimited JSON only; expected IF NOT EXISTS
  // notices would otherwise inject non-JSON objects into deployment logs.
  const client = postgres(connectionString, { max: 1, onnotice: () => undefined });
  try {
    await deployDatabaseWithClient(client, options);
  } finally {
    await client.end();
  }
}

export async function deployDatabaseWithClient(
  client: postgres.Sql,
  options: DatabaseDeployOptions = {},
): Promise<void> {
  const log = options.log ?? defaultLogger;
  const deployStartedAt = performance.now();
  let phase: DatabaseDeployPhase = "lock";
  let phaseStartedAt = deployStartedAt;
  let release: (() => Promise<void>) | undefined;
  log({ event: "facility.db.deploy", phase: "deploy", status: "started" });
  log({ event: "facility.db.deploy", phase, status: "started" });

  try {
    const lockTimeoutMs = options.lockTimeoutMs ?? databaseDeployLockTimeout();
    release = await acquireMigrationLock(client, {
      pollMs: options.lockPollMs,
      timeoutMs: lockTimeoutMs,
    });
    log({
      event: "facility.db.deploy",
      phase,
      status: "completed",
      durationMs: durationMs(phaseStartedAt),
    });

    phase = "migrations";
    phaseStartedAt = performance.now();
    log({ event: "facility.db.deploy", phase, status: "started" });
    const migrationResult = await applyMigrations(client, { log: () => undefined });
    log({
      event: "facility.db.deploy",
      phase,
      status: "completed",
      durationMs: durationMs(phaseStartedAt),
      migrationsApplied: migrationResult.applied.length,
      migrationsBackfilled: migrationResult.backfilled.length,
      migrationsSkipped: migrationResult.skipped.length,
    });

    phase = "reconciliation";
    phaseStartedAt = performance.now();
    log({ event: "facility.db.deploy", phase, status: "started" });
    await seedWithClient(client, {
      includeDemoData: databaseDeployIncludesDemoData(options.includeDemoData),
      log: () => undefined,
    });
    log({
      event: "facility.db.deploy",
      phase,
      status: "completed",
      durationMs: durationMs(phaseStartedAt),
    });
    log({
      event: "facility.db.deploy",
      phase: "deploy",
      status: "completed",
      durationMs: durationMs(deployStartedAt),
    });
  } catch (error) {
    log({
      event: "facility.db.deploy",
      phase,
      status: "failed",
      durationMs: durationMs(phaseStartedAt),
      errorCode: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
    });
    log({
      event: "facility.db.deploy",
      phase: "deploy",
      status: "failed",
      durationMs: durationMs(deployStartedAt),
      errorCode: errorCode(error),
    });
    throw error;
  } finally {
    // deployDatabase() closes its max:1 client immediately afterwards, which
    // also releases the session lock. Do not replace a useful 10/11/12 result
    // with a generic unlock error if that connection has already gone away.
    await release?.().catch(() => undefined);
  }
}
