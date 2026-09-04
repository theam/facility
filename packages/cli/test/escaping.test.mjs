import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeRegExp, yamlQuotedScalar } from "../src/escaping.mjs";

test("escapeRegExp treats branch slashes and dots literally", () => {
  assert.equal(escapeRegExp("release/2026"), "release\\/2026");
  assert.equal(escapeRegExp("v1.2"), "v1\\.2");
});

test("yamlQuotedScalar survives YAML-significant characters", () => {
  assert.equal(yamlQuotedScalar("CI: Build"), '"CI: Build"');
  assert.equal(yamlQuotedScalar('say "hi"'), '"say \\"hi\\""');
});
