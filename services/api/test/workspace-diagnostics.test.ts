import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseWorkspaceHealth, WORKSPACE_HEALTH_COMMAND } from "../src/workspaces/diagnostics.js";

describe("workspace health evidence boundary", () => {
  it("keeps only explicitly allowed counters and identifiers, preserving zero", () => {
    expect(
      parseWorkspaceHealth(
        JSON.stringify({
          oomKills: 0,
          memoryAvailableBytes: 0,
          environment: { SECRET: "private" },
          command: "secret command",
          arbitrary: "private",
        }),
      ),
    ).toEqual({ oomKills: 0, memoryAvailableBytes: 0 });
  });
  it.each([
    "invalid",
    '{"oomKills":-1}',
    '{"load1":"private"}',
    '{"gitHead":"private"}',
    " ".repeat(8193),
  ])("rejects malformed, sensitive or unbounded telemetry", (input) => {
    expect(() => parseWorkspaceHealth(input)).toThrow();
  });
  it("runs the read-only probe without disclosing environment or repository paths", () => {
    const output = execFileSync(process.execPath, ["-e", WORKSPACE_HEALTH_COMMAND, process.cwd()], {
      env: { ...process.env, FACILITY_TEST_SECRET: "private-test-secret" },
      encoding: "utf8",
      timeout: 5000,
    });
    const parsed = parseWorkspaceHealth(output);
    expect(parsed.gitHead).toMatch(/^[a-f0-9]{40}$/);
    expect(output).not.toContain("private-test-secret");
    expect(output).not.toContain(process.cwd());
  });
});
