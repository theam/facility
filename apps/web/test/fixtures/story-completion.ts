import type { StoryCompletion } from "@facility/sdk";

export const at = "2026-10-22T12:00:00.000Z";
export function snapshot(
  nextAction: StoryCompletion["nextAction"] = "request_completion",
): StoryCompletion {
  return {
    schemaVersion: 1,
    orgId: "org-a",
    projectId: "project-a",
    storyId: "story/a",
    generatedAt: at,
    candidate: {
      revision: "a".repeat(64),
      state: "recorded",
      requiredCount: 2,
      mergedCount: 2,
      allRequiredMerged: true,
    },
    integration: {
      policy: { mode: "none", repository: null },
      candidateRevision: null,
      state: "not_required",
      attempt: 0,
      eventId: null,
      repository: null,
      summary: null,
      evidenceUrl: null,
      errorCode: null,
      recordedBy: null,
      recordedAt: null,
    },
    source: { kind: "github_issue", state: "open", url: "https://example.test/issues/1" },
    completion: {
      candidateRevision: null,
      state: "not_requested",
      attempt: 0,
      errorCode: null,
      requestedBy: null,
      requestedAt: null,
      completedAt: null,
    },
    notices: { in_app: true },
    retention: {
      workspaceState: "running",
      computeSuspended: false,
      storageRetained: true,
      archived: false,
      deleted: false,
    },
    nextAction,
  };
}
