import type { FacilityDb } from "@facility/db";
import { describe, expect, it, vi } from "vitest";
import { type BudgetState, CostBudgetService } from "../src/insights/costs.js";

function service(state: BudgetState["state"], enabled = true) {
  const costs = new CostBudgetService({} as FacilityDb);
  const reading = {
    state,
    budget:
      state === "not_configured"
        ? null
        : {
            enabled,
            monthlyLimitCents: 100_000,
          },
    spentCents: state === "exceeded" ? 100_000 : 0,
    remainingCents: 100_000,
  } as BudgetState;
  vi.spyOn(costs, "budgetState").mockResolvedValue(reading);
  return costs;
}

describe("budget accounting admission", () => {
  it.each([
    "gpt-5.5",
    "private-unpriced-model",
  ])("refuses %s while spending is unconfirmed even with available budget", async (model) => {
    await expect(
      service("unconfirmed").assertTurnAllowed("org_test", "proj_test", model),
    ).rejects.toMatchObject({ code: "budget_usage_unconfirmed" });
  });
  it("keeps the explicit disabled-budget escape under administrator control", async () => {
    await expect(
      service("disabled", false).assertTurnAllowed("org_test", "proj_test", "gpt-5.5"),
    ).resolves.toMatchObject({ state: "disabled" });
  });
  it("allows priced work under a confirmed budget", async () => {
    await expect(
      service("ok").assertTurnAllowed("org_test", "proj_test", "gpt-5.5"),
    ).resolves.toMatchObject({ state: "ok" });
  });
  it("preserves denial for unknown model pricing and an exhausted budget", async () => {
    await expect(
      service("ok").assertTurnAllowed("org_test", "proj_test", "private-unpriced-model"),
    ).rejects.toMatchObject({ code: "budget_model_unpriced" });
    await expect(
      service("exceeded").assertTurnAllowed("org_test", "proj_test", "gpt-5.5"),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
  });
});
