import { describe, expect, it } from "vitest";
import { costCents, normalizeModel } from "../src/pricing.js";

describe("model pricing", () => {
  it.each([
    ["claude-fable-5-1", 10, 50, 0.25, 12.5, 3.63],
    ["claude-opus-5-5", 4, 20, 0.2, 5, 1.454],
    ["claude-sonnet-5-5", 2, 10, 0.2, 2.5, 0.729],
    ["claude-opus-5", 5, 25, 0.5, 6.25, 1.8225],
  ] as const)("prices each token category and mixed usage for %s", (model, input, output, cacheRead, cacheWrite, mixedCents) => {
    expect(costCents({ model, inputTokens: 1_000_000, outputTokens: 0 })).toBe(input * 100);
    expect(costCents({ model, inputTokens: 0, outputTokens: 1_000_000 })).toBe(output * 100);
    expect(costCents({ model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBe(
      cacheRead * 100,
    );
    expect(costCents({ model, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 })).toBe(
      cacheWrite * 100,
    );
    expect(
      costCents({
        model,
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
      }),
    ).toBe(mixedCents);
    for (const id of [model, `${model}-20260929`, `${model}-2026-09-29`]) {
      expect(normalizeModel(id)).toBe(model);
      expect(costCents({ model: id, inputTokens: 1, outputTokens: 0 })).toBe(input / 10_000);
    }
  });

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
