import { auditEvents, type FacilityDb, githubWebhookEvents, turns } from "@facility/db";
import { describe, expect, it } from "vitest";
import type { CostBudgetService } from "../src/insights/costs.js";
import { InsightsService } from "../src/insights/overview.js";

describe("insights metric projections", () => {
  it("keeps webhook totals exact while refusing unbounded payload reads", async () => {
    const now = new Date("2026-09-10T12:00:00Z");
    const db = {
      select(fields?: Record<string, unknown>) {
        return {
          from(table: unknown) {
            if (table !== auditEvents) {
              expect(fields).toBeDefined();
              expect(Object.keys(fields ?? {})).not.toContain("payload");
              expect(Object.keys(fields ?? {})).not.toContain("manifest");
            }
            if (table === githubWebhookEvents) {
              expect(Object.keys(fields ?? {}).sort()).toEqual(["failed", "total"]);
            }
            const rows =
              table === githubWebhookEvents
                ? [{ total: 26031, failed: 7 }]
                : table === turns
                  ? [{ state: "succeeded", createdAt: now }]
                  : [];
            return {
              where() {
                return Object.assign(Promise.resolve(rows), {
                  orderBy() {
                    return { limit: async () => [] };
                  },
                });
              },
            };
          },
        };
      },
    } as unknown as FacilityDb;
    const costs = {
      async budgetState() {
        return {
          budget: null,
          windowStart: now,
          windowEnd: now,
          spentCents: 0,
          remainingCents: null,
          percentUsed: null,
          state: "not_configured",
        };
      },
    } as unknown as CostBudgetService;
    const result = await new InsightsService(db, costs).overview("org", "project", 30, now);
    expect(result.github.webhookEvents).toBe(26031);
    expect(result.github.failedWebhooks).toBe(7);
    expect(result.turns.succeeded).toBe(1);
    expect(result.health).toBe("degraded");
  });
});
