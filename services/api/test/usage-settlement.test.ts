import type { FacilityDb } from "@facility/db";
import { describe, expect, it, vi } from "vitest";
import { CostBudgetService } from "../src/insights/costs.js";

describe("manual charge validation", () => {
  it.each([
    NaN,
    Infinity,
    -Infinity,
    -1,
    2_000_000_001,
  ])("rejects invalid charge %s before touching the database", async (costCents) => {
    const transaction = vi.fn();
    const costs = new CostBudgetService({ transaction } as unknown as FacilityDb);
    await expect(
      costs.settleUsage({
        orgId: "org",
        projectId: "proj",
        turnId: "turn",
        costCents,
        reference: "receipt-1",
        actor: { type: "user", id: "admin" },
      }),
    ).rejects.toMatchObject({ code: "invalid_settlement" });
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([
    "",
    "  ",
    "x".repeat(501),
  ])("requires a bounded receipt reference", async (reference) => {
    const transaction = vi.fn();
    const costs = new CostBudgetService({ transaction } as unknown as FacilityDb);
    await expect(
      costs.settleUsage({
        orgId: "org",
        projectId: "proj",
        turnId: "turn",
        costCents: 0,
        reference,
        actor: { type: "user", id: "admin" },
      }),
    ).rejects.toMatchObject({ code: "invalid_settlement" });
    expect(transaction).not.toHaveBeenCalled();
  });
});
