import { describe, expect, it } from "vitest";
import { attentionAction } from "../src/insights/project-overview.js";

describe("attention action projection", () => {
  it.each([
    "review_cycle_ready",
    "review_cycle_decision",
  ])("never advertises a retry for %s", (kind) => {
    expect(attentionAction({ kind, turnId: "reviewer-turn" })).toBe("dismiss");
  });
  it("preserves replies, failure retries and notices without a turn", () => {
    expect(attentionAction({ kind: "agent_waiting", turnId: "turn" })).toBe("reply");
    expect(attentionAction({ kind: "turn_error", turnId: "turn" })).toBe("retry");
    expect(attentionAction({ kind: "runtime_error", turnId: null })).toBe("dismiss");
  });
});
