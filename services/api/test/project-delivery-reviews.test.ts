import { describe, expect, it } from "vitest";
import {
  deliveryNeedsReview,
  type ProjectDeliveryReview,
} from "../src/insights/project-delivery-reviews.js";

// This predicate defines which story cards cover PRs in the complementary list.
// CI cannot move a PR out of both lists or turn an archived story into active work.
function review(
  input: {
    status?: string;
    state?: string;
    candidate?: string;
    required?: boolean | null;
    accepted?: string;
  } = {},
) {
  return {
    storyStatus: input.status ?? "working",
    pullRequests: [{ state: input.state ?? "open", checks: { state: "failure" } }],
    candidate: { state: input.candidate ?? "recorded" },
    acceptance: {
      required: input.required === undefined ? true : input.required,
      status: input.accepted ?? "missing",
    },
  } as ProjectDeliveryReview;
}
describe("active delivery review population", () => {
  it("keeps open and unobserved PRs in their active story even with a current receipt", () => {
    expect(deliveryNeedsReview(review({ accepted: "current" }))).toBe(true);
    expect(deliveryNeedsReview(review({ state: "unobserved", required: false }))).toBe(true);
    expect(deliveryNeedsReview(review({ state: "merged", required: false }))).toBe(false);
    expect(deliveryNeedsReview(review({ state: "merged", accepted: "current" }))).toBe(false);
  });
  it("retains incomplete observations and required or unknown acceptance", () => {
    expect(
      deliveryNeedsReview(review({ state: "merged", candidate: "stale", accepted: "current" })),
    ).toBe(true);
    expect(deliveryNeedsReview(review({ state: "closed", required: null }))).toBe(true);
    expect(deliveryNeedsReview(review({ state: "merged", accepted: "stale" }))).toBe(true);
  });
  it("leaves open PRs on finished stories for the other-PR inventory", () => {
    for (const status of ["done", "archived"])
      expect(deliveryNeedsReview(review({ status }))).toBe(false);
  });
});
