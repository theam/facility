import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkgRoot, "bin", "facility.mjs");

function makeHostileRepo(branch) {
  const dir = mkdtempSync(join(tmpdir(), "facility-escape-"));
  execFileSync("git", ["init", "-b", branch], { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "hostile-app",
        private: true,
        scripts: { lint: "eslint .", test: "vitest run" },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(dir, ".github/workflows/ci.yml"),
    'name: CI: Build\non: push\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
  );
  return dir;
}

function runInit(dir, branch) {
  return spawnSync(
    process.execPath,
    [
      cli,
      "init",
      "--yes",
      "--dir",
      dir,
      "--branch",
      branch,
      "--checks",
      'node -e "console.log(1)"',
    ],
    { cwd: dir, encoding: "utf8" },
  );
}

function assertWorkflowShellUsesBranchEnv(workflowText, branch) {
  assert.doesNotMatch(
    workflowText,
    new RegExp(`origin/${escapeRegExp(branch)}:`),
    "default branch must not be embedded in privileged shell command text",
  );
  assert.match(
    workflowText,
    /origin\/\$\{FACILITY_DEFAULT_BRANCH\}:/,
    "trusted script fetch must read the branch from an environment variable",
  );
  assert.match(
    workflowText,
    /ref=\$\{FACILITY_DEFAULT_BRANCH\}/,
    "gh api ref must read the branch from an environment variable",
  );
}

test("init escapes workflow names, check commands, and default branch for their target formats", () => {
  const dir = makeHostileRepo("release/2026");
  const result = runInit(dir, "release/2026");
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
  assert.ok(
    settings.permissions.allow.includes('Bash(node -e "console.log(1)")'),
    "settings.json must stay valid JSON with quoted check commands",
  );

  const doctor = readFileSync(join(dir, ".github/workflows/facility-doctor.yml"), "utf8");
  assert.ok(doctor.includes('"CI: Build"'), "doctor watch list must quote YAML-significant workflow names");
  assert.doesNotMatch(doctor, /^      - CI: Build/m, "unquoted workflow name would break YAML");

  const protectBranch = readFileSync(join(dir, ".claude/hooks/protect-branch.mjs"), "utf8");
  assert.ok(
    protectBranch.includes("release\\/2026"),
    "protect-branch regex must escape slash metacharacters in the default branch",
  );
});

test("init keeps hostile but valid branch refs out of workflow shell source", () => {
  for (const branch of ['$(id)', 'foo"bar']) {
    const dir = makeHostileRepo("main");
    const result = runInit(dir, branch);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const doctor = readFileSync(join(dir, ".github/workflows/facility-doctor.yml"), "utf8");
    assertWorkflowShellUsesBranchEnv(doctor, branch);
    assert.match(doctor, /FACILITY_DEFAULT_BRANCH: /, "receipt steps must bind the branch through env");

    const crew = readFileSync(join(dir, ".github/workflows/facility-crew.yml"), "utf8");
    assertWorkflowShellUsesBranchEnv(crew, branch);
    assert.match(crew, /DEFAULT_BRANCH: /, "delivery verify must bind the branch through env");
  }
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
