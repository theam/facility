import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_USAGE_PROCESS, parseUsageJournal } from "../src/turns/usage-journal.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 2 };
const native = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 2,
};
function journal(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    turnId: "turn_test",
    engine: "codex",
    complete: true,
    usage,
    ...overrides,
  });
}
async function run(engine: string, events: unknown[], loseObserver = false) {
  const root = await mkdtemp(join(tmpdir(), "facility-usage-unit-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const fake = `const events=${JSON.stringify(events)};for(const event of events)process.stdout.write(JSON.stringify(event)+'\\n');`;
  const child = spawn(
    process.execPath,
    ["-e", ENGINE_USAGE_PROCESS, process.execPath, "-e", fake],
    {
      env: { ...process.env, HOME: home, FACILITY_TURN_ID: "turn_test", FACILITY_ENGINE: engine },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (loseObserver) child.stdout.destroy();
  else child.stdout.resume();
  const errors: Buffer[] = [];
  child.stderr.on("data", (data) => errors.push(data));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  expect(Buffer.concat(errors).toString()).toBe("");
  expect(code).toBe(0);
  return readFile(join(root, "engine-usage", "turn_test.json"), "utf8");
}

describe("durable per-turn usage", () => {
  it.each([
    false,
    true,
  ])("books Codex terminal counters even with lost observer=%s", async (lost) => {
    const raw = await run("codex", [{ type: "turn.completed", usage: native }], lost);
    expect(parseUsageJournal(raw, "turn_test", "codex")).toEqual({ complete: true, usage });
  });
  it("deduplicates Claude message counters and keeps partial usage unconfirmed", async () => {
    const message = {
      type: "assistant",
      message: { id: "msg-1", usage: native, content: [{ text: "private-output" }] },
    };
    const raw = await run("claude_code", [message, message]);
    expect(parseUsageJournal(raw, "turn_test", "claude_code")).toEqual({ complete: false, usage });
    expect(raw).not.toContain("private-output");
    expect(raw).not.toContain("msg-1");
  });
  it("uses Claude's final provider total instead of adding it to partial counters", async () => {
    const raw = await run("claude_code", [
      { type: "assistant", message: { id: "msg-1", usage: native } },
      { type: "result", usage: native, total_cost_usd: 0.03 },
    ]);
    expect(parseUsageJournal(raw, "turn_test", "claude_code")).toEqual({
      complete: true,
      usage: { ...usage, reportedCostCents: 3 },
    });
  });
  it("does not claim zero spending when a CLI exits without usage", async () => {
    expect(
      parseUsageJournal(
        await run("codex", [{ type: "thread.started", thread_id: "thread" }]),
        "turn_test",
        "codex",
      ),
    ).toEqual({ complete: false });
  });
  it.each([
    "",
    "null",
    "[]",
    "{",
    "x".repeat(4097),
    journal({ version: 2 }),
    journal({ turnId: "turn_other" }),
    journal({ engine: "claude_code" }),
    journal({ usage: { ...usage, inputTokens: -1 } }),
    journal({ usage: { ...usage, outputTokens: 1.5 } }),
    journal({ usage: { ...usage, reportedCostCents: -1 } }),
  ])("rejects malformed or unrelated evidence %#", (raw) => {
    expect(parseUsageJournal(raw, "turn_test", "codex")).toEqual({ complete: false });
  });
  it("rejects malformed terminal counters rather than treating them as a paid zero", async () => {
    expect(
      parseUsageJournal(
        await run("codex", [
          { type: "turn.completed", usage: { input_tokens: -1, output_tokens: 0 } },
        ]),
        "turn_test",
        "codex",
      ),
    ).toEqual({ complete: false });
  });
});
