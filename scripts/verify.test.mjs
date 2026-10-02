import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";

test("verify.mjs initializes and starts verification without ReferenceError", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "facility-verify-test-"));
  try {
    if (isWin) {
      writeFileSync(join(tempDir, "docker.cmd"), "@echo off\nexit /b 0\n");
      writeFileSync(join(tempDir, "pnpm.cmd"), "@echo off\necho MOCK_PNPM_LINT\nexit /b 1\n");
    } else {
      writeFileSync(join(tempDir, "docker"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tempDir, "docker"), 0o755);
      writeFileSync(join(tempDir, "pnpm"), "#!/bin/sh\necho MOCK_PNPM_LINT\nexit 1\n");
      chmodSync(join(tempDir, "pnpm"), 0o755);
    }

    const envPath = tempDir + delimiter + process.env.PATH;
    const result = spawnSync(process.execPath, [join(root, "scripts", "verify.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: envPath },
    });

    assert.doesNotMatch(
      result.stderr,
      /ReferenceError/,
      "verify.mjs must not crash on startup with a ReferenceError",
    );
    assert.match(
      result.stdout,
      /==> Lint/,
      "verify.mjs must reach the first verification step",
    );
    assert.match(
      result.stdout,
      /MOCK_PNPM_LINT/,
      "verify.mjs must invoke the resolved pnpm executable",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("test-critical.mjs invokes resolved pnpm across platforms", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "facility-crit-test-"));
  try {
    if (isWin) {
      writeFileSync(join(tempDir, "pnpm.cmd"), "@echo off\necho MOCK_CRITICAL_PNPM\nexit /b 0\n");
    } else {
      writeFileSync(join(tempDir, "pnpm"), "#!/bin/sh\necho MOCK_CRITICAL_PNPM\nexit 0\n");
      chmodSync(join(tempDir, "pnpm"), 0o755);
    }

    const envPath = tempDir + delimiter + process.env.PATH;
    const result = spawnSync(process.execPath, [join(root, "scripts", "test-critical.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: envPath },
    });

    assert.equal(
      result.status,
      0,
      `test-critical.mjs must exit cleanly with mock pnpm: ${result.stderr}`,
    );
    assert.match(
      result.stdout,
      /MOCK_CRITICAL_PNPM/,
      "test-critical.mjs must invoke the resolved pnpm executable",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("test-critical.mjs detects and rejects test suites that report skipped tests", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "facility-crit-skip-"));
  try {
    if (isWin) {
      writeFileSync(join(tempDir, "pnpm.cmd"), "@echo off\necho 1 skipped\nexit /b 0\n");
    } else {
      writeFileSync(join(tempDir, "pnpm"), "#!/bin/sh\necho '1 skipped'\nexit 0\n");
      chmodSync(join(tempDir, "pnpm"), 0o755);
    }

    const envPath = tempDir + delimiter + process.env.PATH;
    const result = spawnSync(process.execPath, [join(root, "scripts", "test-critical.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: envPath },
    });

    assert.equal(
      result.status,
      1,
      "test-critical.mjs must exit with code 1 when skipped tests are reported",
    );
    assert.match(
      result.stderr,
      /Critical integration suite for facility_test reported a skip/,
      "test-critical.mjs must log error message when skips are detected",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
