import { ConsultationSchema, ConsultationSource, type StoryConsultation } from "@facility/core";
import { type FacilityDb, modelCalls, stories, storyConsultations } from "@facility/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { authorizeWorkspaceExecution } from "../auth/workspace-execution.js";
import { ApiError } from "../errors.js";
import type { ConsultationScope } from "./consultation-sources.js";
import { readConsultationTaskState } from "./consultation-task-state.js";

export type ConsultationRow = typeof storyConsultations.$inferSelect;
export type ConsultationActor = { type: "user" | "key"; id: string; name: string | null };
export const consultationWhere = (scope: ConsultationScope) =>
  and(
    eq(storyConsultations.orgId, scope.orgId),
    eq(storyConsultations.projectId, scope.projectId),
    eq(storyConsultations.storyId, scope.storyId),
  );
export async function consultationStory(
  db: FacilityDb,
  scope: ConsultationScope,
  writable = false,
) {
  const [story] = await db
    .select()
    .from(stories)
    .where(
      and(
        eq(stories.orgId, scope.orgId),
        eq(stories.projectId, scope.projectId),
        eq(stories.id, scope.storyId),
        writable ? isNull(stories.deletedAt) : undefined,
      ),
    )
    .limit(1);
  if (!story) throw new ApiError(404, "not_found", "Story not found");
  return story;
}
export async function consultationStoryLock(db: FacilityDb, scope: ConsultationScope) {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`facility:story:${scope.orgId}:${scope.projectId}:${scope.storyId}`}))`,
  );
}

export async function authorizeConsultation(
  db: FacilityDb,
  scope: ConsultationScope,
  actor: Pick<ConsultationActor, "type" | "id">,
) {
  return authorizeWorkspaceExecution(db, scope, actor, "consultation_authorization_revoked");
}

export function consultationContext(row: ConsultationRow): StoryConsultation["context"] {
  const requestedSources = z.array(ConsultationSource).parse(row.sourceInputs);
  if (!row.contextHash)
    return {
      hash: null,
      taskState:
        readConsultationTaskState((row.contextData as { taskState?: unknown }).taskState, row)
          ?.provenance ?? null,
      throughMessageSeq: row.throughMessageSeq,
      omittedMessages: null,
      summaryIncluded: null,
      omissions: ["Snapshot not yet captured", "Uncommitted workspace files are excluded"],
      requestedSources,
      workspaceFilesIncluded: false,
      files: [],
    };
  const value = row.contextData as { context?: unknown };
  const parsed = ConsultationSchema.shape.context.parse(value.context);
  if (parsed.hash !== row.contextHash || parsed.throughMessageSeq !== row.throughMessageSeq)
    throw new ApiError(
      500,
      "consultation_context_invalid",
      "Consultation snapshot metadata does not match its identity",
    );
  return parsed;
}
export function consultationProjection(
  row: ConsultationRow,
  call: typeof modelCalls.$inferSelect | null,
  costsVisible = false,
): StoryConsultation {
  if (row.modelCallId && !call)
    throw new ApiError(
      500,
      "consultation_bill_missing",
      "Consultation billing record is unavailable",
    );
  return ConsultationSchema.parse({
    id: row.id,
    storyId: row.storyId,
    state: row.state,
    executor: "provider_api_text",
    agent: {
      name: row.agentName,
      engine: row.engine,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
      manifestHash: row.agentHash,
      catalogSha: row.catalogSha,
    },
    provider: row.provider,
    providerModel: row.providerModel,
    request: row.request,
    result: row.result,
    resultHash: row.resultHash,
    errorCode: row.errorCode,
    actor: {
      type: row.principalType === "key" ? "service" : "user",
      id: row.principalId,
      name: row.actorName,
    },
    context: consultationContext(row),
    billing: {
      costsVisible,
      state: call?.state ?? "not_started",
      estimatedCents: costsVisible ? (call?.estimatedCents ?? null) : null,
      costCents: costsVisible ? (call?.costCents ?? null) : null,
    },
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
  });
}
export const consultationBillJoin = and(
  eq(modelCalls.id, storyConsultations.modelCallId),
  eq(modelCalls.orgId, storyConsultations.orgId),
  eq(modelCalls.projectId, storyConsultations.projectId),
  eq(modelCalls.storyId, storyConsultations.storyId),
  eq(modelCalls.purpose, "consultation"),
);
