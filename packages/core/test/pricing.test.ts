import { describe, expect, it } from "vitest";
import { costCents, normalizeModel } from "../src/pricing.js";

describe("model pricing", () => {
  it("prices input, output, and cache tokens without rounding away small turns", () => {
    expect(
      costCents({
        model: "gpt-5.6-sol",
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
      }),
    ).toBe(2.0725);
  });

  it("normalizes dated provider model ids and reports unknown models", () => {
    expect(normalizeModel("claude-opus-4-8-20260101")).toBe("claude-opus-4-8");
    expect(costCents({ model: "private-model", inputTokens: 1, outputTokens: 1 })).toBeNull();
  });
});
