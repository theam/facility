import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkgRoot, "bin", "facility.mjs");

function makeHostileRepo() {
  const dir = mkdtempSync(join(tmpdir(), "facility-escape-"));
  execFileSync("git", ["init", "-b", "release/2026"], { cwd: dir });
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

function runInit(dir) {
  return spawnSync(
    process.execPath,
    [
      cli,
      "init",
      "--yes",
      "--dir",
      dir,
      "--branch",
      "release/2026",
      "--checks",
      'node -e "console.log(1)"',
    ],
    { cwd: dir, encoding: "utf8" },
  );
}

test("init escapes workflow names, check commands, and default branch for their target formats", () => {
  const dir = makeHostileRepo();
  const result = runInit(dir);
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
