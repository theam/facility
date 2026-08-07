import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const guide = readFileSync(resolve(repoRoot, "apps/docs/docs/self-host/github-app.md"), "utf8");

test("the GitHub App guide grants every platform security-sweep evidence permission", () => {
  for (const permission of [
    "Code scanning alerts",
    "Dependabot alerts",
    "Secret scanning alerts",
  ]) {
    assert.match(
      guide,
      new RegExp(`\\| ${permission} \\| Read-only \\|`),
      `${permission} must remain read-only`,
    );
  }
  assert.match(guide, /records a scanner as unavailable rather than clean/);
});
