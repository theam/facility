import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import workflowPermissionsGuard, {
  hasTopLevelPermissions,
} from "../guards/workflow-permissions.mjs";

const runnerScript = fileURLToPath(new URL("../guards/run.mjs", import.meta.url));

function createFixtureRepository(t, name) {
  const repoDir = mkdtempSync(join(tmpdir(), `facility-workflow-permissions-${name}-`));
  t.after(() => rmSync(repoDir, { recursive: true, force: true }));
  mkdirSync(join(repoDir, ".github", "workflows"), { recursive: true });
  return repoDir;
}

function writeWorkflow(repoDir, filename, content) {
  writeFileSync(join(repoDir, ".github", "workflows", filename), content, "utf8");
}

function runGuardRunner(repoDir, flags = ["--only=workflow-permissions", "--json"]) {
  return spawnSync(process.execPath, [runnerScript, ...flags], {
    cwd: repoDir,
    encoding: "utf8",
  });
}

// ---------------------------------------------------------------------------
// Unit tests: hasTopLevelPermissions
// ---------------------------------------------------------------------------

test("unit: accepts explicit top-level block mapping permissions", () => {
  const content = [
    "name: ci",
    "on:",
    "  push:",
    "    branches: [main]",
    "",
    "permissions:",
    "  contents: read",
    "  pull-requests: write",
    "",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo build",
  ].join("\n");

  assert.equal(hasTopLevelPermissions(content), true);
});

test("unit: accepts explicit top-level inline permissions", () => {
  const cases = [
    "permissions: contents: read",
    "permissions: {}",
    "permissions: { contents: read }",
    "permissions: { contents: read, issues: write }",
    "permissions: read-all",
    "permissions: write-all",
  ];

  for (const statement of cases) {
    const content = [
      "name: ci",
      statement,
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
    ].join("\n");

    assert.equal(hasTopLevelPermissions(content), true, `Failed for statement: "${statement}"`);
  }
});

test("unit: accepts top-level permissions with comments and document headers", () => {
  const withComments = [
    "---",
    "# Preceding comment header",
    "name: ci",
    "permissions: contents: read # inline comment",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
  ].join("\n");
  assert.equal(hasTopLevelPermissions(withComments), true);

  const withBlockComments = [
    "name: ci",
    "permissions: # declare minimal permissions",
    "  # read contents",
    "  contents: read",
    "  # write issues",
    "  issues: write",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
  ].join("\n");
  assert.equal(hasTopLevelPermissions(withBlockComments), true);
});

test("unit: rejects workflows missing permissions entirely", () => {
  const content = [
    "name: ci",
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo \"no permissions declared\"",
  ].join("\n");

  assert.equal(hasTopLevelPermissions(content), false);
});

test("unit: rejects workflows declaring permissions only at the job level", () => {
  const singleJob = [
    "name: ci",
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    "    steps:",
    "      - run: echo \"job-level only\"",
  ].join("\n");
  assert.equal(hasTopLevelPermissions(singleJob), false);

  const multipleJobs = [
    "name: ci",
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    "  deploy:",
    "    runs-on: ubuntu-latest",
    "    permissions: contents: write",
    "  unrestricted:",
    "    runs-on: ubuntu-latest",
  ].join("\n");
  assert.equal(hasTopLevelPermissions(multipleJobs), false);
});

test("unit: rejects commented-out top-level permissions", () => {
  const content = [
    "name: ci",
    "# permissions: contents: read",
    "# permissions: {}",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
  ].join("\n");

  assert.equal(hasTopLevelPermissions(content), false);
});

test("unit: rejects empty top-level permissions blocks without declared scopes", () => {
  const content = [
    "name: ci",
    "permissions:",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
  ].join("\n");

  assert.equal(hasTopLevelPermissions(content), false);
});

test("unit: ignores 'permissions:' in strings, step names, or environment variables", () => {
  const inString = [
    'name: "permissions: contents: read"',
    "on: push",
    "env:",
    '  MSG: "permissions: write-all"',
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: \"permissions: check\"",
    "        run: echo ok",
  ].join("\n");

  assert.equal(hasTopLevelPermissions(inString), false);
});

// ---------------------------------------------------------------------------
// Integration tests: fixture-based execution through the guard runner
// ---------------------------------------------------------------------------

test("integration: guard runner passes a fixture repository with explicit top-level block permissions", (t) => {
  const repoDir = createFixtureRepository(t, "explicit-block");
  writeWorkflow(
    repoDir,
    "ci.yml",
    [
      "name: ci",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo ok",
    ].join("\n"),
  );

  const result = runGuardRunner(repoDir);
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].name, "workflow-permissions");
  assert.equal(report.results[0].status, "pass");
  assert.deepEqual(report.results[0].violations, []);
});

test("integration: guard runner passes a fixture repository with explicit top-level inline permissions", (t) => {
  const repoDir = createFixtureRepository(t, "explicit-inline");
  writeWorkflow(
    repoDir,
    "ci.yml",
    [
      "name: ci",
      "permissions: {}",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo ok",
    ].join("\n"),
  );

  const result = runGuardRunner(repoDir);
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.results[0].status, "pass");
  assert.deepEqual(report.results[0].violations, []);
});

test("integration: guard runner rejects a fixture repository missing top-level permissions", (t) => {
  const repoDir = createFixtureRepository(t, "missing-permissions");
  writeWorkflow(
    repoDir,
    "unprotected.yml",
    [
      "name: unprotected",
      "on: [push]",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo insecure",
    ].join("\n"),
  );

  const result = runGuardRunner(repoDir);
  assert.equal(result.status, 1, result.stdout);

  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.results[0].status, "fail");
  assert.equal(report.results[0].violations.length, 1);

  const violation = report.results[0].violations[0];
  assert.match(violation.file, /unprotected\.ya?ml$/);
  assert.equal(violation.line, 1);
  assert.match(
    violation.message,
    /workflow does not declare explicit top-level permissions/,
  );
});

test("integration: guard runner rejects a fixture repository with job-only permissions", (t) => {
  const repoDir = createFixtureRepository(t, "job-only-permissions");
  writeWorkflow(
    repoDir,
    "job-only.yml",
    [
      "name: job-only",
      "on: [push]",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    permissions:",
      "      contents: read",
      "    steps:",
      "      - run: echo ok",
      "  deploy:",
      "    runs-on: ubuntu-latest",
      "    permissions: contents: write",
      "    steps:",
      "      - run: echo deploy",
    ].join("\n"),
  );

  const result = runGuardRunner(repoDir);
  assert.equal(result.status, 1, result.stdout);

  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.results[0].status, "fail");
  assert.equal(report.results[0].violations.length, 1);

  const violation = report.results[0].violations[0];
  assert.match(violation.file, /job-only\.ya?ml$/);
  assert.equal(violation.line, 1);
  assert.match(
    violation.message,
    /workflow does not declare explicit top-level permissions/,
  );
});

test("integration: guard runner flags only non-compliant workflows in a multi-workflow fixture", (t) => {
  const repoDir = createFixtureRepository(t, "multi-workflow");

  writeWorkflow(
    repoDir,
    "valid-block.yml",
    "name: valid-block\npermissions:\n  contents: read\njobs:\n  b:\n    runs-on: ubuntu-latest\n",
  );
  writeWorkflow(
    repoDir,
    "valid-inline.yml",
    "name: valid-inline\npermissions: {}\njobs:\n  b:\n    runs-on: ubuntu-latest\n",
  );
  writeWorkflow(
    repoDir,
    "invalid-missing.yml",
    "name: invalid-missing\njobs:\n  b:\n    runs-on: ubuntu-latest\n",
  );
  writeWorkflow(
    repoDir,
    "invalid-job-only.yml",
    "name: invalid-job-only\njobs:\n  b:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n",
  );

  const result = runGuardRunner(repoDir);
  assert.equal(result.status, 1, result.stdout);

  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.results[0].violations.length, 2);

  const files = report.results[0].violations.map((v) => v.file);
  assert.ok(files.some((f) => f.includes("invalid-missing.yml")), "missing.yml must be flagged");
  assert.ok(files.some((f) => f.includes("invalid-job-only.yml")), "job-only.yml must be flagged");
  assert.ok(!files.some((f) => f.includes("valid-block.yml")), "valid-block.yml must not be flagged");
  assert.ok(!files.some((f) => f.includes("valid-inline.yml")), "valid-inline.yml must not be flagged");
});

test("integration: guard runner formats output cleanly in human-readable mode", (t) => {
  const repoDir = createFixtureRepository(t, "human-output");
  writeWorkflow(
    repoDir,
    "ci.yml",
    "name: ci\njobs:\n  build:\n    runs-on: ubuntu-latest\n",
  );

  const result = runGuardRunner(repoDir, ["--only=workflow-permissions"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /✗ workflow-permissions/);
  assert.match(result.stdout, /workflow does not declare explicit top-level permissions/);
  assert.match(result.stdout, /1 guard ran, 1 failed\./);
});

test("all repository workflows in Facility pass the workflow-permissions guard", () => {
  const violations = workflowPermissionsGuard.run();
  assert.deepEqual(violations, []);
});
