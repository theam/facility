import { describe, expect, it } from "vitest";
import {
  DatabaseDeployConfigError,
  databaseDeployExitCode,
  databaseDeployIncludesDemoData,
  databaseDeployLockTimeout,
  MigrationChecksumError,
  MigrationExecutionError,
  MigrationLockTimeoutError,
} from "../src/index.js";

describe("database deploy configuration", () => {
  it("defaults the production deploy entry point to demo data off", () => {
    expect(databaseDeployIncludesDemoData(undefined)).toBe(false);
    expect(databaseDeployIncludesDemoData(false)).toBe(false);
    expect(databaseDeployIncludesDemoData(true)).toBe(true);
  });

  it("accepts only bounded integer lock timeouts", () => {
    expect(databaseDeployLockTimeout(undefined)).toBe(60_000);
    expect(databaseDeployLockTimeout("0")).toBe(0);
    expect(databaseDeployLockTimeout("900000")).toBe(900_000);
    for (const value of ["-1", "1.5", "900001", "not-a-number"]) {
      expect(() => databaseDeployLockTimeout(value)).toThrow(DatabaseDeployConfigError);
    }
  });

  it("maps actionable deploy failures to stable process exit codes", () => {
    expect(databaseDeployExitCode(new DatabaseDeployConfigError("bad config"))).toBe(2);
    expect(databaseDeployExitCode(new MigrationLockTimeoutError(10))).toBe(10);
    expect(databaseDeployExitCode(new MigrationChecksumError("0001.sql", "old", "new"))).toBe(11);
    expect(databaseDeployExitCode(new MigrationExecutionError("0001.sql", new Error("bad")))).toBe(
      12,
    );
    expect(databaseDeployExitCode(new Error("unknown"))).toBe(1);
  });
});
