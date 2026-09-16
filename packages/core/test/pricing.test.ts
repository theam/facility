import { describe, expect, it } from "vitest";
import { costCents, MODEL_ALIASES, normalizeModel } from "../src/pricing.js";

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

  // An alias is by definition absent from the price book, so stripping a date
  // suffix has to consult the alias table too. Asserted over the table itself:
  // the invariant is that resolution composes, whatever the aliases happen to be.
  it("resolves every alias whether or not the id carries a date suffix", () => {
    for (const [alias, canonical] of Object.entries(MODEL_ALIASES)) {
      expect(normalizeModel(alias)).toBe(canonical);
      expect(normalizeModel(`${alias}-20260115`)).toBe(canonical);
      expect(normalizeModel(`${alias}-2026-01-15`)).toBe(canonical);
    }
  });
});
