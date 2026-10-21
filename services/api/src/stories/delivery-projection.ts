import { createHash } from "node:crypto";
import type { DeliveryPullRequest, StoryDelivery } from "@facility/core";
import type { githubPullRequestReviews, githubPullRequests } from "@facility/db";
import { MIRROR_STALE_AFTER_MS } from "./backlog.js";

export type DeliveryLink = {
  repositoryId: string;
  repository: string;
  number: number;
  required: boolean;
  primary: boolean;
  origin: "registered" | "legacy";
};
export type MirroredDeliveryPull = Pick<
  typeof githubPullRequests.$inferSelect,
  | "title"
  | "htmlUrl"
  | "state"
  | "draft"
  | "headSha"
  | "headRef"
  | "baseRef"
  | "syncedAt"
  | "ciState"
  | "ciHeadSha"
  | "ciUpdatedAt"
>;
export type DeliveryReview = Pick<
  typeof githubPullRequestReviews.$inferSelect,
  "reviewId" | "author" | "state" | "commitSha" | "submittedAt" | "htmlUrl"
>;

/** Observations, not a replacement for GitHub's branch protection or review decision. */
export function deliveryPullProjection(
  link: DeliveryLink,
  pull: MirroredDeliveryPull | null,
  reviews: DeliveryReview[],
  truncated: boolean,
  now: Date,
): DeliveryPullRequest {
  const headSha = pull && /^[a-f\d]{40}$/i.test(pull.headSha) ? pull.headSha : null;
  const currentReviews = reviews.filter(
    (review) => headSha !== null && review.commitSha === headSha,
  );
  const ordered = [...reviews].sort(
    (a, b) =>
      (b.submittedAt?.getTime() ?? 0) - (a.submittedAt?.getTime() ?? 0) ||
      (a.author ?? "").localeCompare(b.author ?? ""),
  );
  return {
    ...link,
    title: pull?.title ?? null,
    url: pull?.htmlUrl ?? null,
    state: pull ? (pull.state as "open" | "closed" | "merged") : "unobserved",
    draft: pull?.draft ?? null,
    headSha,
    headRef: pull?.headRef ?? null,
    baseRef: pull?.baseRef ?? null,
    observedAt: pull?.syncedAt.toISOString() ?? null,
    stale: !pull || now.getTime() - pull.syncedAt.getTime() > MIRROR_STALE_AFTER_MS,
    checks: {
      state: (pull?.ciState as "pending" | "success" | "failure" | null) ?? "unobserved",
      headSha: pull?.ciHeadSha ?? null,
      current: Boolean(headSha && pull?.ciState && pull.ciHeadSha === headSha),
      observedAt: pull?.ciUpdatedAt?.toISOString() ?? null,
    },
    reviews: {
      state: truncated ? "partial" : reviews.length > 0 ? "recorded" : "unobserved",
      currentHeadCount: currentReviews.length,
      unverifiedHeadCount: reviews.length - currentReviews.length,
      truncated,
      latest: ordered.slice(0, 5).map((review) => ({
        reviewId: review.reviewId,
        author: review.author,
        state: review.state,
        commitSha: review.commitSha,
        submittedAt: review.submittedAt?.toISOString() ?? null,
        url: review.htmlUrl,
        current: headSha !== null && review.commitSha === headSha,
      })),
    },
  };
}

/** Time/order/CI observations do not change the exact required code revisions. */
export function deliveryCandidate(
  scope: Pick<StoryDelivery["scope"], "revision" | "declaredComplete">,
  pulls: DeliveryPullRequest[],
): StoryDelivery["candidate"] {
  const required = pulls.filter((pull) => pull.required);
  const mergedCount = required.filter((pull) => pull.state === "merged").length;
  const complete =
    scope.declaredComplete &&
    required.length > 0 &&
    pulls.filter((pull) => pull.primary).length === 1 &&
    pulls.every((pull) => !pull.primary || pull.required);
  const observed = required.every((pull) => pull.headSha !== null && pull.state !== "unobserved");
  const fresh = required.every((pull) => !pull.stale);
  const state = !complete
    ? "scope_incomplete"
    : !observed
      ? "unobserved"
      : !fresh
        ? "stale"
        : "recorded";
  const links = [...pulls]
    .sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.number - b.number)
    .map((pull) => ({
      repositoryId: pull.repositoryId,
      number: pull.number,
      required: pull.required,
      primary: pull.primary,
      ...(pull.required ? { headSha: pull.headSha } : {}),
    }));
  return {
    revision:
      complete && observed
        ? createHash("sha256")
            .update(JSON.stringify({ scopeRevision: scope.revision, links }))
            .digest("hex")
        : null,
    state,
    requiredCount: required.length,
    mergedCount,
    allRequiredMerged: state === "recorded" ? mergedCount === required.length : null,
  };
}
