import type { StoryCompletion, StoryWorkflowStatus, WorkspaceStoryBundle } from "@facility/sdk";

export const completionActionLabels: Record<StoryCompletion["nextAction"], string> = {
  declare_delivery: "Declare the complete delivery set",
  review: "Review the current delivery",
  merge: "Merge the remaining required pull requests",
  configure_integration: "Configure post-merge integration",
  record_integration: "Record the post-merge integration result",
  wait_integration: "Wait for post-merge integration",
  inspect_integration_failure: "Inspect the integration failure",
  request_completion: "Request source completion",
  wait_completion: "Wait for source completion",
  retry_completion: "Retry source completion",
  completed: "Delivery completed",
};

export function completionStepTitle(completion: StoryCompletion) {
  if (["request_completion", "retry_completion"].includes(completion.nextAction)) {
    if (completion.source.kind === "other") return "No source issue linked";
    if (completion.source.state === "unavailable") return "Source issue unavailable";
  }
  return completionActionLabels[completion.nextAction];
}

export type StorySection =
  | "plan"
  | "delivery"
  | "completion"
  | "progress"
  | "workflow"
  | "preview"
  | "consultation"
  | "environment";
export type StoryFocus = { section: StorySection; title: string; detail: string };

/** Presentation priority only. Domain facts and every operation's gates remain unchanged. */
export function storyFocus(
  bundle: WorkspaceStoryBundle,
  workflow: StoryWorkflowStatus | undefined,
  linkedPlan = false,
): StoryFocus {
  if (linkedPlan)
    return {
      section: "plan",
      title: "Review the linked plan",
      detail:
        "This link keeps its exact revision. The current plan and conversation remain accessible.",
    };
  if (
    bundle.story.deletedAt ||
    bundle.story.archivedAt ||
    ["done", "archived"].includes(bundle.story.status)
  )
    return {
      section: "completion",
      title: "Completion and retention",
      detail: "Check the source issue, completion result, compute and retained storage separately.",
    };
  if (workflow?.blockedReason || bundle.plans?.state.status === "proposed")
    return {
      section: "plan",
      title: "Review the plan and retained work",
      detail:
        workflow?.blockedReason ??
        "The current proposal is waiting for a decision. Approval and execution are separate results.",
    };
  const completion = bundle.completion;
  if (completion && !["declare_delivery", "review", "merge"].includes(completion.nextAction))
    return {
      section: "completion",
      title: completionStepTitle(completion),
      detail:
        completion.source.kind === "other"
          ? "No source GitHub issue is linked to this story. Merged PRs alone do not establish source completion."
          : completion.source.state === "unavailable"
            ? "The source issue is not currently observed. Its completion cannot be inferred from the PRs."
            : "This next step is recorded by Facility. Review its source, evidence and effect before acting.",
    };
  if (bundle.delivery?.pullRequests.length)
    return {
      section: "delivery",
      title: "Review the delivery",
      detail:
        "Inspect all PRs and their current heads. Acceptance, preview, merge and completion keep their own evidence.",
    };
  if (
    bundle.turns.some((turn) => ["running", "queued"].includes(turn.state)) ||
    bundle.progress?.latest
  )
    return {
      section: "progress",
      title: "Follow the current work",
      detail:
        "The latest recorded activity is shown below. The conversation stays next to it for questions and instructions.",
    };
  return {
    section: "plan",
    title: "Plan and conversation",
    detail:
      "Review the recorded scope or describe the next task. Opening this page starts no agent.",
  };
}
