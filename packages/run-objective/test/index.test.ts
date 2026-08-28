import { describe, expect, it } from "vitest";
import {
  agentDefTriggersBuilder,
  isBuilderAgent,
  isBuilderMode,
  runObjectiveText,
} from "../src/index.js";

describe("run objective policy", () => {
  it("recognizes every governed builder objective source", () => {
    expect(runObjectiveText({ message: "  Fix the builder  " })).toBe("Fix the builder");
    expect(runObjectiveText({ approvedPlan: "Ship the approved plan" })).toBe(
      "Ship the approved plan",
    );
    expect(runObjectiveText({ input: "Fix the CLI builder" })).toBe("Fix the CLI builder");
    expect(runObjectiveText({ input: { objective: "Fix the structured CLI builder" } })).toBe(
      '{\n  "objective": "Fix the structured CLI builder"\n}',
    );
    expect(runObjectiveText({ issue: { number: 42 } })).toBe(
      "Implement the governed GitHub issue #42 described in Scope.",
    );
  });

  it("rejects empty and malformed objective sources", () => {
    for (const trigger of [
      undefined,
      {},
      { message: "   " },
      { approvedPlan: "" },
      { input: {} },
      { input: [] },
      { issue: { number: 0 } },
      { issue: { number: 1.5 } },
    ]) {
      expect(runObjectiveText(trigger)).toBeNull();
    }
  });

  it("recognizes canonical and prefixed builder modes", () => {
    expect(isBuilderMode("builder")).toBe(true);
    expect(isBuilderMode("codex-builder")).toBe(true);
    expect(isBuilderMode("codex_builder")).toBe(true);
    expect(isBuilderMode("architect")).toBe(false);
  });

  it("recognizes renamed Builder definitions from command triggers", () => {
    expect(agentDefTriggersBuilder([{ type: "command", command: "builder" }])).toBe(true);
    expect(agentDefTriggersBuilder([{ type: "command", handle: "/codex_builder" }])).toBe(true);
    expect(isBuilderAgent("implementation-agent", [{ handle: "/codex-builder" }])).toBe(true);
    expect(isBuilderAgent("architect", [{ handle: "/architect" }])).toBe(false);
  });
});
