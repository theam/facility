#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const compose = ["compose", "-f", "docker-compose.dev.yml"];
const wasRunning = output("docker", [...compose, "ps", "--status", "running", "-q", "postgres"]).trim();
let startedPostgres = false;

try {
  step("Lint", "pnpm", ["lint"]);
  step("Typecheck", "pnpm", ["typecheck"]);
  step("Clean workspace build (Turbo cache disabled)", "pnpm", ["build:clean"]);

  if (!wasRunning) {
    step("Start isolated test Postgres", "docker", [...compose, "up", "-d", "--wait", "postgres"]);
    startedPostgres = true;
  }
  for (const database of ["facility_test", "facility_gw"]) ensureDatabase(database);

  step("Critical integration tests (direct, uncached, skips forbidden)", "pnpm", ["test:critical"]);
  step("Remaining tests (Turbo cache disabled)", "pnpm", ["test:uncached"]);
  step("Repository guards", "pnpm", ["guards"]);
  step("High-severity dependency audit", "pnpm", ["audit", "--audit-level", "high"]);
} finally {
  if (startedPostgres) run("docker", [...compose, "stop", "postgres"], { allowFailure: true });
}

function ensureDatabase(name) {
  const exists = output("docker", [
    ...compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "facility",
    "-d",
    "postgres",
    "-tAc",
    `SELECT 1 FROM pg_database WHERE datname='${name}'`,
  ]).trim();
  if (exists === "1") return;
  step(`Create isolated database ${name}`, "docker", [
    ...compose,
    "exec",
    "-T",
    "postgres",
    "createdb",
    "-U",
    "facility",
    name,
  ]);
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
