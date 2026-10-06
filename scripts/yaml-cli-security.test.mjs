import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

const docsRequire = createRequire(new URL("../apps/docs/package.json", import.meta.url));
const coreRequire = createRequire(docsRequire.resolve("@docusaurus/core/package.json"));
const utilsRequire = createRequire(coreRequire.resolve("@docusaurus/utils"));
const matterRequire = createRequire(utilsRequire.resolve("gray-matter"));
const yamlRequire = createRequire(matterRequire.resolve("js-yaml/package.json"));
const yaml = matterRequire("js-yaml");
const cli = join(dirname(matterRequire.resolve("js-yaml/package.json")), "bin/js-yaml.js");

test("legacy YAML consumer uses official argparse 2 without sprintf-js", () => {
  assert.equal(yamlRequire("argparse/package.json").version, "2.0.1");
  const lockfile = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(lockfile, /^\s+sprintf-js(?:@|:)/m);
  assert.deepEqual(yaml.safeLoad("title: Example\nitems: [one, two]\n"), {
    title: "Example", items: ["one", "two"],
  });
});

test("real js-yaml CLI retains input, help, version and invalid-option behavior", () => {
  const run = (args, input = "") => spawnSync(process.execPath, [cli, ...args], {
    input, encoding: "utf8", timeout: 5000,
  });
  const converted = run(["--to-json"], "title: Example\nitems: [one, two]\n");
  assert.equal(converted.status, 0, converted.stderr);
  assert.deepEqual(JSON.parse(converted.stdout), { title: "Example", items: ["one", "two"] });
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--compact/);
  const version = run(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^3\.15\.2\s*$/);
  const invalid = run(["--not-a-real-option"]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /unrecognized arguments/);
});
