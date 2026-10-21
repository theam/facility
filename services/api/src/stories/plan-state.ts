import { createHash } from "node:crypto";
import type {
  PlanAgent,
  PlanDecisionRequest,
  PlanRepository,
  StoryPlan,
  StoryPlans,
} from "@facility/core";
import type {
  storyPlanDecisions,
  storyPlanRequests,
  storyPlanRevisions,
  storyPlanStates,
} from "@facility/db";

export type PlanScope = { orgId: string; projectId: string; storyId: string };
export type PlanRow = typeof storyPlanRevisions.$inferSelect;
export type DecisionRow = typeof storyPlanDecisions.$inferSelect;
export type RequestRow = typeof storyPlanRequests.$inferSelect;
export type PlanState = StoryPlans["state"];

export function storyPlanDigest(
  scope: PlanScope,
  input: {
    markdown: string;
    repositories: PlanRepository[];
    agents: PlanAgent[];
    sourceMessageId: string | null;
  },
) {
  // Observation time and catalog commit can change without changing the selected configuration.
  const repositories = input.repositories
    .map(({ repositoryId, repository }) => [repositoryId, repository])
    .sort(compareTuple);
  const agents = input.agents
    .map(({ name, manifestHash, engine, model, repositoryId }) => [
      name,
      manifestHash,
      engine,
      model,
      repositoryId,
    ])
    .sort(compareTuple);
  return createHash("sha256")
    .update(
      JSON.stringify([
        "facility:story-plan:v1",
        scope.orgId,
        scope.projectId,
        scope.storyId,
        input.markdown,
        repositories,
        agents,
        input.sourceMessageId,
      ]),
    )
    .digest("hex");
}

export function planState(
  row: typeof storyPlanStates.$inferSelect | undefined,
  decision: DecisionRow | undefined,
): PlanState {
  const revision = row?.revision ?? 0;
  return {
    revision,
    decisionRevision: row?.decisionRevision ?? 0,
    status: !revision
      ? "none"
      : decision?.planRevision === revision
        ? decision.intent === "approve"
          ? "approved"
          : "rejected"
        : "proposed",
  };
}

export function planProjection(row: PlanRow): StoryPlan {
  return { ...planMetadataProjection(row), markdown: row.markdown };
}

export function planMetadataProjection(row: Omit<PlanRow, "markdown">) {
  return {
    revision: row.revision,
    digest: row.digest,
    repositories: row.repositories,
    agents: row.agents,
    proposedBy: row.proposedBy,
    proposedAt: row.proposedAt.toISOString(),
    source: row.source,
  };
}

export function decisionProjection(row: DecisionRow) {
  return {
    id: row.id,
    decisionRevision: row.decisionRevision,
    planRevision: row.planRevision,
    planDigest: row.planDigest,
    intent: row.intent,
    reason: row.reason,
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt.toISOString(),
    method: row.method,
    requestId: row.requestId,
  };
}

export function requestStatus(
  row: RequestRow,
  state: PlanState,
  now: Date,
): PlanDecisionRequest["status"] {
  if (row.consumedAt) return "confirmed";
  if (row.planRevision !== state.revision || row.decisionRevision !== state.decisionRevision)
    return "superseded";
  return row.expiresAt <= now ? "expired" : "pending";
}

export function requestProjection(
  row: RequestRow,
  state: PlanState,
  now: Date,
  webUrl: string,
): PlanDecisionRequest {
  const confirmationUrl = new URL(
    `/projects/${encodeURIComponent(row.projectId)}/stories/${encodeURIComponent(row.storyId)}/plan/decisions/${encodeURIComponent(row.id)}`,
    webUrl,
  ).toString();
  return {
    id: row.id,
    planRevision: row.planRevision,
    planDigest: row.planDigest,
    decisionRevision: row.decisionRevision,
    intent: row.intent,
    reason: row.reason,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    boundUserId: row.boundUserId,
    status: requestStatus(row, state, now),
    confirmationUrl,
  };
}

function compareTuple(left: string[], right: string[]) {
  const a = JSON.stringify(left),
    b = JSON.stringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
