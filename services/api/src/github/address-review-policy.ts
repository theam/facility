export const TRUSTED_REVIEW_BOTS = new Set([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
  "copilot-pull-request-reviewer",
  "copilot-pull-request-reviewer[bot]",
  "claude[bot]",
]);

export type AddressReviewPullRequest = {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  url: string;
  author: { login: string; type: string };
  head: { ref: string; sha: string; repo: string };
  base: { ref: string; repo: string };
};

export type AddressReviewSubmittedReview = {
  id: number;
  state: string;
  commitSha: string;
  author: string;
  body: string | null;
  submittedAt: string | null;
  comments: Array<{
    id: number | null;
    path: string | null;
    line: number | null;
    body: string | null;
    diffHunk: string | null;
    url: string | null;
  }>;
};

export type AddressReviewDenial =
  | "incomplete_event"
  | "unsupported_review_state"
  | "reviewer_sender_mismatch"
  | "self_review"
  | "untrusted_reviewer"
  | "pull_request_not_open"
  | "draft_pull_request"
  | "human_authored_pull_request"
  | "cross_repository_pull_request"
  | "default_branch"
  | "stale_pull_request_event"
  | "stale_review"
  | "installation_mismatch"
  | "not_facility_delivered"
  | "delivery_base_mismatch"
  | "unauthorized_head";

export type AddressReviewAdmission =
  | { admitted: true }
  | { admitted: false; reason: AddressReviewDenial };

export function isTrustedReviewBot(login: string): boolean {
  return TRUSTED_REVIEW_BOTS.has(normalizeLogin(login));
}

export function decideAddressReviewAdmission(input: {
  repository: string;
  defaultBranch: string;
  facilityAppSlug?: string;
  event: {
    pullNumber?: number | null;
    headRef?: string | null;
    headSha?: string | null;
    reviewId?: number | null;
    reviewState?: string | null;
    reviewCommitSha?: string | null;
    reviewer?: string | null;
    sender?: string | null;
  };
  pullRequest: AddressReviewPullRequest;
  review: AddressReviewSubmittedReview;
  reviewerCanWrite: boolean;
  installationMatches: boolean;
  facilityDelivered: boolean;
  deliveryBaseBranch?: string | null;
  headShaAuthorized: boolean;
}): AddressReviewAdmission {
  const eventReviewer = normalizeLogin(input.event.reviewer);
  const reviewer = normalizeLogin(input.review.author);
  const sender = normalizeLogin(input.event.sender);
  if (
    !Number.isInteger(input.event.pullNumber) ||
    Number(input.event.pullNumber) <= 0 ||
    !input.event.headRef ||
    !input.event.headSha ||
    !Number.isInteger(input.event.reviewId) ||
    Number(input.event.reviewId) <= 0 ||
    !input.event.reviewCommitSha ||
    !eventReviewer ||
    !reviewer ||
    !sender ||
    !normalizeLogin(input.facilityAppSlug)
  ) {
    return { admitted: false, reason: "incomplete_event" };
  }
  if (
    !new Set(["approved", "commented", "changes_requested"]).has(input.review.state.toLowerCase())
  ) {
    return { admitted: false, reason: "unsupported_review_state" };
  }
  if (eventReviewer !== sender || reviewer !== sender) {
    return { admitted: false, reason: "reviewer_sender_mismatch" };
  }
  if (facilityBotLogins(input.facilityAppSlug).has(reviewer)) {
    return { admitted: false, reason: "self_review" };
  }
  if (!input.reviewerCanWrite && !isTrustedReviewBot(reviewer)) {
    return { admitted: false, reason: "untrusted_reviewer" };
  }

  const pullRequest = input.pullRequest;
  if (pullRequest.state !== "open") {
    return { admitted: false, reason: "pull_request_not_open" };
  }
  if (pullRequest.draft) return { admitted: false, reason: "draft_pull_request" };
  if (pullRequest.author.type.toLowerCase() !== "bot") {
    return { admitted: false, reason: "human_authored_pull_request" };
  }

  const repository = input.repository.toLowerCase();
  if (
    pullRequest.head.repo.toLowerCase() !== repository ||
    pullRequest.base.repo.toLowerCase() !== repository
  ) {
    return { admitted: false, reason: "cross_repository_pull_request" };
  }
  if (normalizeRef(pullRequest.head.ref) === normalizeRef(input.defaultBranch)) {
    return { admitted: false, reason: "default_branch" };
  }
  if (
    pullRequest.number !== input.event.pullNumber ||
    pullRequest.head.ref !== input.event.headRef ||
    pullRequest.head.sha !== input.event.headSha
  ) {
    return { admitted: false, reason: "stale_pull_request_event" };
  }
  if (
    input.review.id !== input.event.reviewId ||
    input.review.state.toLowerCase() !== input.event.reviewState ||
    input.review.commitSha !== input.event.reviewCommitSha ||
    input.review.commitSha !== pullRequest.head.sha
  ) {
    return { admitted: false, reason: "stale_review" };
  }
  if (!input.installationMatches) {
    return { admitted: false, reason: "installation_mismatch" };
  }
  if (!input.facilityDelivered) {
    return { admitted: false, reason: "not_facility_delivered" };
  }
  if (input.deliveryBaseBranch !== pullRequest.base.ref) {
    return { admitted: false, reason: "delivery_base_mismatch" };
  }
  if (!input.headShaAuthorized) {
    return { admitted: false, reason: "unauthorized_head" };
  }
  return { admitted: true };
}

function facilityBotLogins(slug?: string): Set<string> {
  const normalized = normalizeLogin(slug);
  return normalized ? new Set([normalized, `${normalized}[bot]`]) : new Set();
}

function normalizeLogin(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function normalizeRef(value: string): string {
  return value.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
}
