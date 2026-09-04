import { describe, expect, it } from "vitest";
import { resolveMeteredCost } from "../src/metering.js";
import type { RequestRecord } from "../src/types.js";

describe("resolveMeteredCost", () => {
  it("uses the preflight estimate when provider-charged errors have incomplete usage", () => {
    expect(
      resolveMeteredCost(
        baseRecord({
          status: "error",
          providerMayHaveCharged: true,
          usageComplete: false,
          estimatedCents: 1800,
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        }),
      ),
    ).toBe(1800);
  });

  it("uses the preflight estimate when a successful stream ends with incomplete usage", () => {
    expect(
      resolveMeteredCost(
        baseRecord({
          status: "ok",
          providerMayHaveCharged: true,
          usageComplete: false,
          estimatedCents: 1800,
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        }),
      ),
    ).toBe(1800);
  });

  it("preserves zero-usage conservative fallback for provider-charged errors", () => {
    expect(
      resolveMeteredCost(
        baseRecord({
          status: "error",
          providerMayHaveCharged: true,
          estimatedCents: 10,
        }),
      ),
    ).toBe(10);
  });

  it("reconciles to measured usage for completed successful requests", () => {
    expect(
      resolveMeteredCost(
        baseRecord({
          status: "ok",
          providerMayHaveCharged: true,
          usageComplete: true,
          estimatedCents: 1800,
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        }),
      ),
    ).toBe(1800);
  });
});

function baseRecord(overrides: Partial<RequestRecord>): RequestRecord {
  return {
    requestId: "evt_test",
    provider: "anthropic",
    model: "claude-sonnet-5",
    status: "ok",
    statusCode: 200,
    startedAt: Date.now(),
    key: {
      id: "key_test",
      orgId: "org_test",
      projectId: "prj_test",
      runId: null,
      taskId: null,
      allowedModels: null,
      budgetId: null,
      agentDefId: null,
      engine: null,
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    priced: true,
    requestBody: {},
    responseBody: {},
    budgets: [],
    ...overrides,
  };
}
