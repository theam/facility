import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// README documents running the installer straight from a checkout:
//
//   git clone https://github.com/theam/facility.git /absolute/path/to/facility
//   cd your-repository
//   node /absolute/path/to/facility/packages/cli/bin/facility.mjs init
//
// There is no install step, and the installer is described as not requiring
// Facility to be deployed at all. Copying the published files somewhere with no
// node_modules reproduces that: the CLI depends on `postgres` and nothing else,
// so any command that eagerly loads it dies here with ERR_MODULE_NOT_FOUND.
function plainCheckout() {
  const dir = mkdtempSync(join(tmpdir(), "facility-plain-"));
  for (const entry of ["bin", "src", "templates", "modules", "package.json"]) {
    cpSync(join(pkgRoot, entry), join(dir, entry), { recursive: true });
  }
  return join(dir, "bin", "facility.mjs");
}

function targetRepo() {
  const dir = mkdtempSync(join(tmpdir(), "facility-target-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "demo-app", private: true, scripts: { test: "vitest run" } }, null, 2)}\n`,
  );
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  return dir;
}

test("informational commands run from a checkout with no dependencies installed", () => {
  const cli = plainCheckout();
  for (const args of [["--version"], ["--help"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /ERR_MODULE_NOT_FOUND|Cannot find package/,
      `facility ${args.join(" ")} must not require an installed dependency`,
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  }
});

test("init installs the method from a checkout with no dependencies installed", () => {
  const cli = plainCheckout();
  const dir = targetRepo();
  const result = spawnSync(process.execPath, [cli, "init", "--yes", `--dir=${dir}`], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /ERR_MODULE_NOT_FOUND|Cannot find package/,
    "facility init must not require an installed dependency",
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
