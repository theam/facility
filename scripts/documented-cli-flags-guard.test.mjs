import assert from "node:assert/strict";
import { test } from "node:test";
import { documentedFlags, realFlags } from "../guards/documented-cli-flags.mjs";

const SAMPLE_DOC = [
  "## `facility init`",
  "",
  "| Flag | Purpose |",
  "| --- | --- |",
  "| `--dir=<path>` | Configure another repository directory. |",
  "| `--yes`, `-y` | Run without interactive confirmation. |",
  "| `--auth=<mode>` | Set the authentication mode. |",
  "",
  "## `facility doctor`",
  "",
  "Use `--dir=<path>` to inspect another checkout.",
].join("\n");

const SAMPLE_SOURCE = [
  "const allowed = {",
  "    init: new Set([",
  '      "yes",',
  '      "force",',
  '      "dir",',
  "    ]),",
  '    doctor: new Set(["dir", "json", "help"]),',
  "  }[command];",
].join("\n");

test("documentedFlags reads only table cells under a `facility <command>` heading", () => {
  const byCommand = documentedFlags(SAMPLE_DOC);
  assert.deepEqual(
    byCommand.get("init").map((f) => f.flag),
    ["dir", "yes", "auth"],
  );
  // Prose outside a table (the doctor `--dir=<path>` sentence) is not a table row and is ignored.
  assert.equal(byCommand.has("doctor"), false);
});

test("documentedFlags records the doc line number for each flag", () => {
  const byCommand = documentedFlags(SAMPLE_DOC);
  const auth = byCommand.get("init").find((f) => f.flag === "auth");
  assert.equal(auth.line, 7);
});

test("realFlags reads the quoted flag names out of a command's allowlist Set", () => {
  assert.deepEqual([...realFlags(SAMPLE_SOURCE, "init")].sort(), ["dir", "force", "yes"]);
  assert.deepEqual([...realFlags(SAMPLE_SOURCE, "doctor")].sort(), ["dir", "help", "json"]);
});

test("realFlags returns null for a command absent from the allowlist", () => {
  assert.equal(realFlags(SAMPLE_SOURCE, "instance"), null);
});

test("a flag documented but missing from the allowlist is exactly what the guard must catch", () => {
  const documented = documentedFlags(SAMPLE_DOC).get("init");
  const allowlist = realFlags(SAMPLE_SOURCE, "init");
  const undocumented = documented.filter((f) => !allowlist.has(f.flag));
  assert.deepEqual(
    undocumented.map((f) => f.flag),
    ["auth"],
  );
});
