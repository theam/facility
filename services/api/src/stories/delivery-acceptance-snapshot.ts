import {
  type DeliveryAcceptanceSnapshot,
  DeliveryAcceptanceSnapshotSchema,
  type StoryDelivery,
  type StoryPlans,
  type StoryWorkflowPolicyState,
} from "@facility/core";
import { ApiError } from "../errors.js";
import { workflowDigest } from "./workflow-policy.js";

export type AcceptanceObservation = {
  policy: StoryWorkflowPolicyState;
  delivery: Pick<StoryDelivery, "candidate" | "scope" | "pullRequests">;
  plan: { state: StoryPlans["state"]; digest: string | null };
  preview: {
    state: string;
    desiredGeneration: string | null;
    deployedGeneration: string | null;
  } | null;
  /** The review cycle's Builder or Reviewer is still working on this delivery. */
  reviewInProgress?: boolean;
};

/** Shared eligibility and binding. Reading this result never creates a request
 * or authorizes a person; confirmation still rechecks under the existing locks. */
export function acceptanceSnapshot(
  { policy, delivery, plan, preview, reviewInProgress }: AcceptanceObservation,
  acceptanceRevision: number,
  requireReadyPreview: boolean,
): DeliveryAcceptanceSnapshot {
  if (requireReadyPreview && reviewInProgress)
    throw new ApiError(
      409,
      "workflow_review_in_progress",
      "Wait for the Builder and review cycle to reach a human decision before accepting delivery",
    );
  if (delivery.candidate.state !== "recorded" || !delivery.candidate.revision)
    throw new ApiError(
      409,
      "workflow_candidate_unavailable",
      "Declare the complete required PR set and refresh its current heads before accepting delivery",
    );
  if (
    plan.state.status === "rejected" ||
    (policy.policy.planApprovalAgents.length && plan.state.status !== "approved")
  )
    throw new ApiError(
      409,
      "workflow_plan_approval_required",
      "Approve the current plan before accepting its delivery",
    );
  let previewGeneration: string | null = null;
  if (requireReadyPreview && policy.policy.requirePreviewForAcceptance) {
    if (
      preview?.state !== "ready" ||
      preview.desiredGeneration !== delivery.candidate.revision ||
      preview.deployedGeneration !== delivery.candidate.revision
    )
      throw new ApiError(
        409,
        "workflow_preview_not_ready",
        "Wait for the preview of the complete current candidate before accepting it",
      );
    previewGeneration = preview.deployedGeneration;
  }
  return DeliveryAcceptanceSnapshotSchema.parse({
    candidateRevision: delivery.candidate.revision,
    scopeRevision: delivery.scope.revision,
    planRevision: plan.state.revision,
    planDigest: plan.digest,
    decisionRevision: plan.state.decisionRevision,
    policyRevision: policy.revision,
    acceptanceRevision,
    previewGeneration,
    pullRequests: delivery.pullRequests
      .filter((pull) => pull.required)
      .map((pull) => ({
        repository: pull.repository,
        number: pull.number,
        headSha: pull.headSha,
        url: pull.url,
      }))
      .sort((a, b) => a.repository.localeCompare(b.repository) || a.number - b.number),
  });
}

export function sameAcceptedCandidate(
  a: DeliveryAcceptanceSnapshot,
  b: DeliveryAcceptanceSnapshot,
) {
  // Suspending retained compute after acceptance preserves the receipt.
  return (
    workflowDigest({ ...a, previewGeneration: null }) ===
    workflowDigest({ ...b, previewGeneration: null })
  );
}
