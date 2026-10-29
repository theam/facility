import { describe, expect, it } from "vitest";
import {
  type DeliveryLink,
  type DeliveryReview,
  deliveryCandidate,
  deliveryPullProjection,
  type MirroredDeliveryPull,
} from "../src/stories/delivery-projection.js";

const now = new Date("2026-10-21T10:00:00Z");
const head = "a".repeat(40);
function link(index = 1): DeliveryLink {
  return {
    repositoryId: `repo_${index}`,
    repository: `example/app-${index}`,
    number: index,
    primary: index === 1,
    required: true,
    origin: "registered",
  };
}
function mirror(changes: Partial<MirroredDeliveryPull> = {}): MirroredDeliveryPull {
  return {
    title: "Feature",
    htmlUrl: "https://github.com/example/app/pull/1",
    state: "open",
    draft: false,
    headSha: head,
    headRef: "feature",
    baseRef: "main",
    syncedAt: now,
    ciState: "success",
    ciHeadSha: head,
    ciUpdatedAt: now,
    ...changes,
  };
}
function pull(index = 1, changes: Partial<MirroredDeliveryPull> = {}) {
  return deliveryPullProjection(link(index), mirror(changes), [], false, now);
}
const complete = { revision: 1, declaredComplete: true };

describe("story delivery observations", () => {
  it("does not turn a legacy primary or an undeclared set into complete delivery", () => {
    const legacy = { ...pull(), origin: "legacy" as const };
    expect(deliveryCandidate({ revision: 0, declaredComplete: false }, [legacy])).toMatchObject({
      state: "scope_incomplete",
      revision: null,
      allRequiredMerged: null,
    });
    expect(deliveryCandidate(complete, [])).toMatchObject({
      state: "scope_incomplete",
      revision: null,
    });
    expect(deliveryCandidate(complete, [{ ...pull(), primary: false }]).state).toBe(
      "scope_incomplete",
    );
  });

  it("tracks all three required repositories and never equates a primary merge with all merges", () => {
    const set = [pull(1, { state: "merged" }), pull(2), pull(3)];
    expect(deliveryCandidate(complete, set)).toMatchObject({
      state: "recorded",
      requiredCount: 3,
      mergedCount: 1,
      allRequiredMerged: false,
    });
    expect(
      deliveryCandidate(
        complete,
        set.map((entry) => ({ ...entry, state: "merged" })),
      ),
    ).toMatchObject({
      mergedCount: 3,
      allRequiredMerged: true,
    });
  });

  it("binds identity to the full required heads and scope, independently of ordering and read times", () => {
    const set = [pull(1), pull(2), pull(3)];
    const revision = deliveryCandidate(complete, set).revision;
    expect(revision).toMatch(/^[a-f0-9]{64}$/);
    expect(deliveryCandidate(complete, [...set].reverse()).revision).toBe(revision);
    expect(
      deliveryCandidate(
        complete,
        set.map((entry) => ({ ...entry, observedAt: now.toISOString() })),
      ).revision,
    ).toBe(revision);
    expect(
      deliveryCandidate(complete, [pull(1), pull(2, { headSha: "b".repeat(40) }), pull(3)])
        .revision,
    ).not.toBe(revision);
    expect(deliveryCandidate({ ...complete, revision: 2 }, set).revision).not.toBe(revision);
    expect(deliveryCandidate(complete, set.slice(0, 2)).revision).not.toBe(revision);
    const related = { ...pull(4), required: false };
    expect(deliveryCandidate(complete, [...set, related]).revision).toBe(
      deliveryCandidate(complete, [...set, { ...related, headSha: "c".repeat(40) }]).revision,
    );
  });

  it("retains old CI observations without presenting them as current-head checks", () => {
    expect(pull(1, { headSha: "b".repeat(40) }).checks).toMatchObject({
      state: "success",
      headSha: head,
      current: false,
    });
    expect(pull(1, { ciState: null, ciHeadSha: null, ciUpdatedAt: null }).checks).toEqual({
      state: "unobserved",
      headSha: null,
      current: false,
      observedAt: null,
    });
  });

  it("keeps missing or stale observations unknown even after a merge", () => {
    const missing = deliveryPullProjection(link(), null, [], false, now);
    expect(deliveryCandidate(complete, [missing])).toMatchObject({
      state: "unobserved",
      revision: null,
      allRequiredMerged: null,
    });
    const stale = pull(1, { state: "merged", syncedAt: new Date(now.getTime() - 31 * 60_000) });
    expect(deliveryCandidate(complete, [stale])).toMatchObject({
      state: "stale",
      allRequiredMerged: null,
    });
    expect(deliveryCandidate(complete, [pull(1, { headSha: "unknown" })]).state).toBe("unobserved");
  });

  it("shows raw review states against their actual commits and marks bounded samples as partial", () => {
    const reviews: DeliveryReview[] = Array.from({ length: 8 }, (_, index) => ({
      reviewId: String(index),
      author: `reviewer-${index}`,
      state: index === 0 ? "CHANGES_REQUESTED" : "APPROVED",
      commitSha: index < 2 ? head : "b".repeat(40),
      submittedAt: new Date(now.getTime() - index * 1000),
      htmlUrl: null,
    }));
    const result = deliveryPullProjection(link(), mirror(), reviews, true, now);
    expect(result.reviews).toMatchObject({
      state: "partial",
      currentHeadCount: 2,
      unverifiedHeadCount: 6,
      truncated: true,
    });
    expect(result.reviews.latest).toHaveLength(5);
    expect(result.reviews.latest[0]).toMatchObject({ state: "CHANGES_REQUESTED", current: true });
    expect(result.reviews.latest[2]?.current).toBe(false);
    expect(result.reviews).not.toHaveProperty("approved");
  });
});
