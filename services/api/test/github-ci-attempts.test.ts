import { describe, expect, it } from "vitest";
import { restCiSignal } from "../src/github/mirror.js";

const check = (id: number, conclusion: string, appId = 1) => ({
  id,
  name: "verify",
  app: { id: appId },
  status: "completed",
  conclusion,
});

describe("GitHub CI attempts", () => {
  it("uses the latest attempt independently of response order", () => {
    for (const checks of [
      [check(1, "failure"), check(2, "success")],
      [check(2, "success"), check(1, "failure")],
    ]) {
      expect(restCiSignal({ state: "success" }, { check_runs: checks })).toEqual({
        state: "success",
        failureNames: [],
      });
    }
  });

  it("uses completed check runs when the legacy status collection is explicitly empty", () => {
    expect(
      restCiSignal(
        { state: "pending", total_count: 0, statuses: [] },
        { check_runs: [check(1, "success")] },
      ),
    ).toEqual({ state: "success", failureNames: [] });
    expect(
      restCiSignal({ state: "pending", total_count: 0, statuses: [] }, { check_runs: [] }),
    ).toEqual({ state: "pending", failureNames: [] });
    expect(
      restCiSignal(
        { state: "pending", total_count: 1, statuses: [] },
        { check_runs: [check(1, "success")] },
      ),
    ).toEqual({ state: "pending", failureNames: [] });
  });

  it("keeps a newer failed or pending attempt authoritative", () => {
    expect(
      restCiSignal(
        { state: "success" },
        { check_runs: [check(2, "failure"), check(1, "success")] },
      ),
    ).toEqual({ state: "failure", failureNames: ["verify"] });
    expect(
      restCiSignal(
        { state: "success" },
        { check_runs: [check(1, "failure"), { ...check(2, ""), status: "in_progress" }] },
      ),
    ).toEqual({ state: "pending", failureNames: [] });
  });

  it("never lets another app or incomplete identity hide a failed check", () => {
    for (const failure of [check(1, "failure", 2), { ...check(1, "failure"), app: undefined }]) {
      expect(
        restCiSignal({ state: "success" }, { check_runs: [failure, check(2, "success")] }),
      ).toEqual({ state: "failure", failureNames: ["verify"] });
    }
  });
});
