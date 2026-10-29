import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { assertPatchedVersion, UNDICI_6_SECURITY_FLOOR } from "../runner/verify-package-security.mjs";

const apiRequire = createRequire(new URL("../services/api/package.json", import.meta.url));
const root = resolve(import.meta.dirname, "..");
const lock = apiRequire("yaml").parse(readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8"));
const floors = {
  "@hono/node-server": { 2: "2.1.3" },
  qs: { 6: "6.16.1" },
  zod: { 4: "4.6.6" },
  "body-parser": { 1: "1.20.9", 2: "2.4.0" },
  undici: { 6: UNDICI_6_SECURITY_FLOOR, 7: "7.30.1", 8: "8.12.2" },
  "serialize-javascript": { 7: "7.1.3" },
  "fast-uri": { 3: "3.1.9", 4: "4.2.3" },
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
