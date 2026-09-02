import { describe, expect, it } from "vitest";
import { billableCostCents } from "../src/metering.js";

describe("billableCostCents", () => {
  it("uses measured cost for successful requests even when usage was incomplete", () => {
    expect(
      billableCostCents(
        { status: "ok", providerMayHaveCharged: true, usageComplete: false, estimatedCents: 400 },
        120,
      ),
    ).toBe(120);
  });

  it("uses the estimate for provider-charged errors with zero measured usage", () => {
    expect(
      billableCostCents(
        { status: "error", providerMayHaveCharged: true, usageComplete: false, estimatedCents: 400 },
        0,
      ),
    ).toBe(400);
  });

  it("uses the estimate for provider-charged errors with incomplete partial usage", () => {
    expect(
      billableCostCents(
        { status: "error", providerMayHaveCharged: true, usageComplete: false, estimatedCents: 400 },
        30,
      ),
    ).toBe(400);
  });

  it("uses measured cost for provider-charged errors with complete usage", () => {
    expect(
      billableCostCents(
        { status: "error", providerMayHaveCharged: true, usageComplete: true, estimatedCents: 400 },
        220,
      ),
    ).toBe(220);
  });

  it("releases reservations for errors before the provider could charge", () => {
    expect(
      billableCostCents(
        { status: "error", providerMayHaveCharged: false, usageComplete: false, estimatedCents: 400 },
        0,
      ),
    ).toBe(0);
  });
});
