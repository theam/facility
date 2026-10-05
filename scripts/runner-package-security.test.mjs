import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertPatchedVersion } from "../runner/verify-package-security.mjs";

test("security floors accept patches and reject old, malformed and unreviewed major versions", () => {
  for (const v of ["6.28.1", "6.28.2", "6.29.0"]) assertPatchedVersion(v, "6.28.1", "fixture");
  for (const v of ["6.28.0", "6.27.99", "garbage", "6.28.1-beta", "7.0.0"])
    assert.throws(() => assertPatchedVersion(v, "6.28.1", "fixture"));
});

test("image audit executes against real nested npm and both cached pnpm layouts", (t) => {
  const root = mkdtempSync(join(tmpdir(), "facility-package-security-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const globals = join(root, "node_modules");
  const npmRoot = join(globals, "npm");
  const cache = join(root, "corepack");
  function pkg(path, version) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify({ version }));
  }
  pkg(npmRoot, "12.0.2");
  for (const [name, version] of [
    ["brace-expansion", "5.0.12"], ["ip-address", "10.7.1"],
    ["tar", "7.5.21"], ["undici", "6.28.1"],
  ]) pkg(join(globals, name), version);
  const copies = ["dist/node_modules/undici", "artifacts/exe/dist/node_modules/undici"]
    .map((path) => join(cache, "v1/pnpm/fixture", path));
  for (const path of copies) pkg(path, "6.28.1");
  const run = () => spawnSync(process.execPath, [
    fileURLToPath(new URL("../runner/verify-package-security.mjs", import.meta.url)), npmRoot, cache,
  ], { encoding: "utf8" });
  assert.equal(run().status, 0);
  for (const path of copies) {
    pkg(path, "6.28.0");
    const rejected = run();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /below security floor/);
    pkg(path, "6.28.1");
  }
  pkg(join(npmRoot, "node_modules/undici"), "6.28.0");
  assert.match(run().stderr, /npm undici: 6.28.0 is below security floor/);
  pkg(join(npmRoot, "node_modules/undici"), "6.28.1");
  assert.equal(run().status, 0);
  rmSync(cache, { recursive: true });
  mkdirSync(cache);
  assert.match(run().stderr, /No cached pnpm undici found/);
});
