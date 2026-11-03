import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { assertPatchedVersion, UNDICI_6_SECURITY_FLOOR } from "../runner/verify-package-security.mjs";

const apiRequire = createRequire(new URL("../services/api/package.json", import.meta.url));
const root = resolve(import.meta.dirname, "..");
test("shipped containers pin a consistent Node 24 image above the October security floor", () => {
  const images = [];
  for (const path of ["Dockerfile", "apps/web/Dockerfile", "runner/Dockerfile"]) {
    const source = readFileSync(resolve(root, path), "utf8");
    const image = source.match(/^FROM (node:(\d+\.\d+\.\d+)-trixie-slim@sha256:[a-f0-9]{64}) AS /m);
    assert.ok(image, `${path}: pin the reviewed Node patch and immutable digest`);
    // CVE-2026-111497 and the October TLS/DNS fixes first shipped in 24.22.1.
    assertPatchedVersion(image[2], "24.22.1", `${path} Node`);
    images.push(image[1]);
  }
  assert.equal(new Set(images).size, 1, "API, web and workspace must use the same reviewed Node base");
});

const lock = apiRequire("yaml").parse(readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8"));
const floors = {
  "@hono/node-server": { 2: "2.1.3" },
  qs: { 6: "6.16.1" },
  zod: { 4: "4.6.6" },
  "body-parser": { 1: "1.20.9", 2: "2.4.0" },
  undici: { 6: UNDICI_6_SECURITY_FLOOR, 7: "7.30.1", 8: "8.12.2" },
  "serialize-javascript": { 7: "7.1.3" },
  "fast-uri": { 3: "3.1.9", 4: "4.2.3" },
  "follow-redirects": { 1: "1.16.2" },
  joi: { 17: "17.13.9" },
};
for (const [name, majors] of Object.entries(floors)) {
  test(`every locked ${name} copy meets its reviewed major-specific security floor`, () => {
    const versions = Object.keys(lock.packages).filter(key => key.startsWith(`${name}@`)).map(key => key.slice(name.length + 1));
    assert.ok(versions.length);
    for (const version of versions) {
      // zod 3 has independent advisory/version semantics and is not overridden to v4.
      if (name === "zod" && version.startsWith("3.")) continue;
      const minimum = majors[version.split(".")[0]];
      assert.ok(minimum, `Unreviewed ${name} major ${version}`);
      assertPatchedVersion(version, minimum, name);
    }
  });
}

function isBelow(version, fixed) {
  const [actual, floor] = [version, fixed].map(value => value.split(".").map(Number));
  const index = actual.findIndex((part, position) => part !== floor[position]);
  return index !== -1 && actual[index] < floor[index];
}

// GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249 are audit exceptions only for these
// consumers. Reassess the exception before accepting another one or a new version.
const auditExceptions = {
  glob: { fixed: "14.0.2", consumers: ["@fastify/static@10.1.2"] },
  minimatch: { fixed: "11.0.1", consumers: ["@redocly/openapi-core@1.34.17", "glob@13.0.6", "serve-handler@6.1.7"] },
};
for (const [name, { fixed, consumers }] of Object.entries(auditExceptions)) {
  test(`unpatched ${name} stays limited to the consumers reviewed for its audit exception`, () => {
    const found = new Set();
    for (const [key, entry] of Object.entries({ ...lock.importers, ...lock.snapshots })) {
      for (const dependencies of [entry.dependencies, entry.devDependencies, entry.optionalDependencies]) {
        const locked = dependencies?.[name];
        const version = (locked?.version ?? locked)?.replace(/\(.*$/, "");
        if (version && isBelow(version, fixed)) found.add(key.replace(/\(.*$/, ""));
      }
    }
    assert.deepEqual([...found].sort(), consumers);
  });
}
