import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pkgRoot, "../..");

// This repo dogfoods the guard runner it ships. The copies under guards/
// (repo root — they guard the whole monorepo) must stay byte-identical to
// the templates, or adopters get a different runner than the one we test on
// ourselves.
test("dogfooded guards match the shipped templates", () => {
  for (const file of [
    "run.mjs",
    "_kit.mjs",
    "actions-pinned.mjs",
    "workflow-untrusted-interpolation.mjs",
  ]) {
    const shipped = readFileSync(join(pkgRoot, "templates/guards", file), "utf8");
    const ours = readFileSync(join(repoRoot, "guards", file), "utf8");
    assert.equal(ours, shipped, `guards/${file} drifted from templates/guards/${file} — copy it over`);
  }
});
