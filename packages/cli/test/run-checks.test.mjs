import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCommands, runPlatformChecks } from "../templates/receipts/run-checks.mjs";

test("parseCommands accepts a JSON array of shell commands", () => {
  assert.deepEqual(parseCommands('["pnpm test","pnpm lint"]'), ["pnpm test", "pnpm lint"]);
  assert.deepEqual(parseCommands(""), []);
});

test("runPlatformChecks records configured checks and guards as platform evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facility-run-checks-"));
  const output = join(dir, "platform-checks.jsonl");
  mkdirSync(join(dir, "guards"), { recursive: true });
  writeFileSync(join(dir, "guards", "run.mjs"), 'console.log("ok");\n', "utf8");

  const results = runPlatformChecks({
    FACILITY_RECEIPT_PLATFORM_CHECKS_FILE: output,
    FACILITY_RECEIPT_CHECKS_COMMANDS: JSON.stringify(['node -e "process.exit(0)"']),
    GITHUB_WORKSPACE: dir,
  });

  assert.equal(results.length, 2);
  assert.equal(results[0]?.status, "passed");
  assert.equal(results[1]?.command, "node guards/run.mjs");
  assert.match(readFileSync(output, "utf8"), /"self_reported":false/);
});
