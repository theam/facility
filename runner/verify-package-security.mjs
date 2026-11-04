import assert from "node:assert/strict";
import { cpSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const UNDICI_6_SECURITY_FLOOR = "6.29.1";

export function assertPatchedVersion(version, minimum, label) {
  assert.match(version, /^\d+\.\d+\.\d+$/, `${label}: invalid version`);
  const actual = version.split(".").map(Number);
  const floor = minimum.split(".").map(Number);
  assert.equal(actual[0], floor[0], `${label}: review a new major before accepting it`);
  assert.ok(
    actual[1] > floor[1] || (actual[1] === floor[1] && actual[2] >= floor[2]),
    `${label}: ${version} is below security floor ${minimum}`,
  );
}

export function verifyRunnerPackages(npmRoot, corepackRoot) {
  const npmRequire = createRequire(join(resolve(npmRoot), "package.json"));
  for (const [name, minimum] of [
    ["brace-expansion", "5.0.12"],
    ["ip-address", "10.7.4"],
    ["tar", "7.5.21"],
    ["undici", UNDICI_6_SECURITY_FLOOR],
  ]) {
    // Resolve as npm does: an old nested copy must not shadow the global overlay.
    const manifest = JSON.parse(readFileSync(npmRequire.resolve(`${name}/package.json`), "utf8"));
    assertPatchedVersion(manifest.version, minimum, `npm ${name}`);
  }

  let copies = 0;
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (entry.name === "undici") {
        const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
        assertPatchedVersion(manifest.version, UNDICI_6_SECURITY_FLOOR, path);
        copies += 1;
      }
      visit(path);
    }
  }
  visit(corepackRoot);
  assert.ok(copies > 0, "No cached pnpm undici found; review the package layout");
}

/** Overlay the reviewed same-major package before making the Corepack cache immutable. */
export function overlayCachedUndici(corepackRoot, patchedRoot) {
  const source = JSON.parse(readFileSync(join(patchedRoot, "package.json"), "utf8"));
  assert.equal(source.name, "undici");
  assertPatchedVersion(source.version, UNDICI_6_SECURITY_FLOOR, "cached pnpm overlay");
  assert.deepEqual(source.dependencies ?? {}, {}, "The reviewed overlay must be self-contained");
  let copies = 0;
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (entry.name === "undici") {
        const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
        // Do not replace an unreviewed major or silently downgrade a newer copy.
        assertPatchedVersion(manifest.version, "6.0.0", path);
        try {
          assertPatchedVersion(manifest.version, source.version, path);
        } catch {
          rmSync(path, { recursive: true });
          cpSync(patchedRoot, path, { recursive: true });
        }
        copies += 1;
      } else visit(path);
    }
  }
  visit(corepackRoot);
  assert.ok(copies > 0, "No cached pnpm undici found; review the package layout");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[4]) {
    assert.equal(process.argv[4], "--overlay-cached-undici");
    overlayCachedUndici(process.argv[3], process.argv[5]);
  }
  verifyRunnerPackages(process.argv[2], process.argv[3]);
  console.log("Runner npm and cached pnpm security floors verified");
}
