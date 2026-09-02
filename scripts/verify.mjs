#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  DEV_COMPOSE,
  TEST_DATABASES,
  recreateTestDatabase,
} from "./verify-test-databases.mjs";

const wasRunning = output("docker", [
  ...DEV_COMPOSE,
  "ps",
  "--status",
  "running",
  "-q",
  "postgres",
]).trim();
let startedPostgres = false;

try {
  step("Lint", "pnpm", ["lint"]);
  step("Clean generated build outputs", "pnpm", ["clean:outputs"]);
  step("Typecheck", "pnpm", ["typecheck"]);
  step("Clean workspace build (Turbo cache disabled)", "pnpm", ["build:clean"]);

  if (!wasRunning) {
    step("Start isolated test Postgres", "docker", [
      ...DEV_COMPOSE,
      "up",
      "-d",
      "--wait",
      "postgres",
    ]);
    startedPostgres = true;
  }
  for (const database of TEST_DATABASES) {
    console.log(`\n==> Recreate isolated database ${database}`);
    recreateTestDatabase(database, run);
  }

  step("Critical integration tests (direct, uncached, skips forbidden)", "pnpm", ["test:critical"]);
  step("Remaining tests (Turbo cache disabled)", "pnpm", ["test:uncached"]);
  step("Removed component references", "pnpm", ["check:unused"]);
  step("Repository guards", "pnpm", ["guards"]);
  step("All-severity dependency audit", "pnpm", ["audit", "--audit-level", "low"]);
} finally {
  if (startedPostgres) {
    run("docker", [...DEV_COMPOSE, "stop", "postgres"], { allowFailure: true });
  }
}

function step(label, command, args) {
  console.log(`\n==> ${label}`);
  run(command, args);
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) process.exit(result.status ?? 1);
}
