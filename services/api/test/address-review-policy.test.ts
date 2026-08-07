import { describe, expect, it } from "vitest";
import {
  type AddressReviewPullRequest,
  decideAddressReviewAdmission,
} from "../src/github/address-review-policy.js";

const pullRequest: AddressReviewPullRequest = {
  number: 41,
  state: "open",
  draft: false,
  url: "https://github.test/theam/facility/pull/41",
  author: { login: "facility-builder[bot]", type: "Bot" },
  head: { ref: "facility/issue-41", sha: "head-41", repo: "theam/facility" },
  base: { ref: "main", repo: "theam/facility" },
};

const admittedInput = {
  repository: "theam/facility",
  defaultBranch: "main",
  facilityAppSlug: "facility-app",
  event: {
    pullNumber: 41,
    headRef: "facility/issue-41",
    headSha: "head-41",
    reviewId: 91,
    reviewState: "changes_requested",
    reviewCommitSha: "head-41",
    reviewer: "maintainer",
    sender: "maintainer",
  },
  pullRequest,
  review: {
    id: 91,
    state: "changes_requested",
    commitSha: "head-41",
    author: "maintainer",
    body: "Please cover the boundary case.",
    submittedAt: "2026-08-07T00:00:00Z",
    comments: [],
  },
  reviewerCanWrite: true,
  installationMatches: true,
  facilityDelivered: true,
  deliveryBaseBranch: "main",
  headShaAuthorized: true,
};

describe("address-review admission", () => {
  it("admits a trusted review of the current Facility-delivered bot PR", () => {
    expect(decideAddressReviewAdmission(admittedInput)).toEqual({ admitted: true });
  });

  it.each([
    ["incomplete_event", { facilityAppSlug: undefined }],
    [
      "unsupported_review_state",
      {
        event: { ...admittedInput.event, reviewState: "dismissed" },
        review: { ...admittedInput.review, state: "dismissed" },
      },
    ],
    ["reviewer_sender_mismatch", { event: { ...admittedInput.event, sender: "someone-else" } }],
    [
      "self_review",
      {
        event: {
          ...admittedInput.event,
          reviewer: "facility-app[bot]",
          sender: "facility-app[bot]",
        },
        review: { ...admittedInput.review, author: "facility-app[bot]" },
      },
    ],
    ["untrusted_reviewer", { reviewerCanWrite: false }],
    ["pull_request_not_open", { pullRequest: { ...pullRequest, state: "closed" } }],
    ["draft_pull_request", { pullRequest: { ...pullRequest, draft: true } }],
    [
      "human_authored_pull_request",
      { pullRequest: { ...pullRequest, author: { login: "human", type: "User" } } },
    ],
    [
      "cross_repository_pull_request",
      { pullRequest: { ...pullRequest, head: { ...pullRequest.head, repo: "fork/facility" } } },
    ],
    [
      "default_branch",
      {
        event: { ...admittedInput.event, headRef: "main" },
        pullRequest: { ...pullRequest, head: { ...pullRequest.head, ref: "main" } },
      },
    ],
    ["stale_pull_request_event", { event: { ...admittedInput.event, headSha: "stale" } }],
    ["stale_review", { event: { ...admittedInput.event, reviewCommitSha: "stale" } }],
    ["installation_mismatch", { installationMatches: false }],
    ["not_facility_delivered", { facilityDelivered: false }],
    ["delivery_base_mismatch", { deliveryBaseBranch: "release" }],
    ["unauthorized_head", { headShaAuthorized: false }],
  ] as const)("denies %s", (reason, override) => {
    expect(decideAddressReviewAdmission({ ...admittedInput, ...override })).toEqual({
      admitted: false,
      reason,
    });
  });

  it("admits the explicitly trusted automated reviewers without collaborator permission", () => {
    expect(
      decideAddressReviewAdmission({
        ...admittedInput,
        event: {
          ...admittedInput.event,
          reviewer: "claude[bot]",
          sender: "claude[bot]",
        },
        review: { ...admittedInput.review, author: "claude[bot]" },
        reviewerCanWrite: false,
      }),
    ).toEqual({ admitted: true });
  });
});
