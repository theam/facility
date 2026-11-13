import type { StoryPlans, StoryWorkflowStatus } from "@facility/sdk";

export const approvalFixture: NonNullable<StoryPlans["decision"]> = {
  id: "dec-a",
  requestId: "dreq-a",
  planRevision: 1,
  planDigest: "d".repeat(64),
  decisionRevision: 1,
  intent: "approve",
  reason: null,
  confirmedBy: { type: "user", id: "person-a", name: "Ada" },
  confirmedAt: "2026-11-05T10:00:00Z",
  method: "interactive_session",
};

export function workflowFixture(): StoryWorkflowStatus {
  return {
    schemaVersion: 1,
    orgId: "org-a",
    projectId: "project-a",
    storyId: "story-a",
    policy: {
      revision: 1,
      policy: {
        planApprovalAgents: ["planner"],
        holdAfterFailure: false,
        requireDeliveryAcceptance: false,
        requirePreviewForAcceptance: false,
      },
    },
    plan: { revision: 1, decisionRevision: 1, status: "approved" },
    queuedAgents: [],
    blockedReason: null,
    acceptance: {
      schemaVersion: 1,
      orgId: "org-a",
      projectId: "project-a",
      storyId: "story-a",
      required: false,
      status: "missing",
      receipt: null,
    },
    executionScope: {
      observedAt: "2026-11-05T10:00:02Z",
      planRevision: 1,
      repositories: { matches: true, connectedCount: 1, missing: [], removed: [] },
      queuedWork: [],
      hasMore: false,
    },
    execution: {
      observedAt: "2026-11-05T10:00:02Z",
      decision: {
        id: approvalFixture.id,
        decisionRevision: 1,
        planRevision: 1,
        planDigest: approvalFixture.planDigest,
      },
      turns: [
        {
          turnId: "retained",
          agentName: "planner",
          engine: "codex",
          model: "fixture-model",
          manifestHash: "a".repeat(64),
          state: "running",
          authorizedAt: "2026-11-05T10:00:01Z",
          startedAt: "2026-11-05T10:00:01Z",
          endedAt: null,
        },
      ],
      hasMore: false,
      unavailable: false,
    },
  };
}
