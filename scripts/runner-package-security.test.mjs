import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertPatchedVersion, overlayCachedUndici } from "../runner/verify-package-security.mjs";

const require = createRequire(import.meta.url);

test("security floors accept patches and reject old, malformed and unreviewed major versions", () => {
  for (const v of ["6.29.1", "6.29.2", "6.30.0"]) assertPatchedVersion(v, "6.29.1", "fixture");
  for (const v of ["6.28.1", "6.29.0", "garbage", "6.29.1-beta", "7.0.0"])
    assert.throws(() => assertPatchedVersion(v, "6.29.1", "fixture"));
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
    ["brace-expansion", "5.0.12"], ["ip-address", "10.7.4"],
    ["tar", "7.5.21"], ["undici", "6.29.1"],
  ]) pkg(join(globals, name), version);
  const copies = ["dist/node_modules/undici", "artifacts/exe/dist/node_modules/undici"]
    .map((path) => join(cache, "v1/pnpm/fixture", path));
  for (const path of copies) pkg(path, "6.29.1");
  const run = () => spawnSync(process.execPath, [
    fileURLToPath(new URL("../runner/verify-package-security.mjs", import.meta.url)), npmRoot, cache,
  ], { encoding: "utf8" });
  assert.equal(run().status, 0);
  for (const path of copies) {
    pkg(path, "6.28.1");
    const rejected = run();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /below security floor/);
    pkg(path, "6.29.1");
  }
  pkg(join(npmRoot, "node_modules/undici"), "6.28.1");
  assert.match(run().stderr, /npm undici: 6.28.1 is below security floor/);
  pkg(join(npmRoot, "node_modules/undici"), "6.29.1");
  assert.equal(run().status, 0);
  pkg(join(npmRoot, "node_modules/ip-address"), "10.7.1");
  assert.match(run().stderr, /npm ip-address: 10.7.1 is below security floor/);
  pkg(join(npmRoot, "node_modules/ip-address"), "10.7.4");
  assert.equal(run().status, 0);
  rmSync(cache, { recursive: true });
  mkdirSync(cache);
  assert.match(run().stderr, /No cached pnpm undici found/);
});

test("cached CLI overlay replaces affected files and retains normal HTTP operation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "facility-cached-undici-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cached = join(root, "v1/pnpm/fixture/dist/node_modules/undici");
  mkdirSync(cached, { recursive: true });
  writeFileSync(join(cached, "package.json"), JSON.stringify({ name: "undici", version: "6.28.1" }));
  writeFileSync(join(cached, "obsolete.js"), "must not remain");
  const patched = join(require.resolve("undici/package.json"), "..");
  overlayCachedUndici(root, patched);
  assert.equal(existsSync(join(cached, "obsolete.js")), false);
  assert.equal(JSON.parse(readFileSync(join(cached, "package.json"), "utf8")).version, "6.29.1");
  overlayCachedUndici(root, patched); // A repeated build step stays safe.
  const cachedRequire = createRequire(join(root, "v1/pnpm/fixture/dist/package.json"));
  const { fetch, Agent } = cachedRequire("undici");
  const server = createServer((_request, response) => response.end("cached CLI works"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const agent = new Agent();
  try {
    const result = await fetch(`http://127.0.0.1:${server.address().port}`, { dispatcher: agent });
    assert.equal(await result.text(), "cached CLI works");
  } finally {
    await agent.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("cache overlay rejects unreviewed majors and preserves newer compatible packages", (t) => {
  const root = mkdtempSync(join(tmpdir(), "facility-cached-undici-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cached = join(root, "dist/node_modules/undici");
  mkdirSync(cached, { recursive: true });
  const patched = join(require.resolve("undici/package.json"), "..");
  writeFileSync(join(cached, "package.json"), JSON.stringify({ version: "7.30.1" }));
  assert.throws(() => overlayCachedUndici(root, patched), /review a new major/);
  writeFileSync(join(cached, "package.json"), JSON.stringify({ version: "6.30.0" }));
  writeFileSync(join(cached, "newer.js"), "keep");
  overlayCachedUndici(root, patched);
  assert.equal(existsSync(join(cached, "newer.js")), true);
  assert.equal(JSON.parse(readFileSync(join(cached, "package.json"), "utf8")).version, "6.30.0");
});
