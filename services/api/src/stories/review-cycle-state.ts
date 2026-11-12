import {
  newId,
  type PublishedReviewHead,
  type ReviewCyclePhaseSchema,
  type ReviewCyclePolicy,
  type ReviewCycleStatus,
} from "@facility/core";
import {
  attentionItems,
  type FacilityDb,
  stories,
  storyReviewCycles,
  type turns,
} from "@facility/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { readStoryDelivery } from "./delivery.js";
import { appendStoryEvidence } from "./evidence.js";
import {
  declaresRegisteredDelivery,
  deliveryHeadsFromOutput,
  REVIEW_ACTOR,
  REVIEW_TRIGGER,
} from "./review-cycle-rules.js";
import { type PlanExecutionAuthorization, readPlanExecutionReceipt } from "./workflow-execution.js";
import { readWorkflowPolicy, type WorkflowScope } from "./workflow-policy.js";

export type ReviewCyclePhase = z.infer<typeof ReviewCyclePhaseSchema>;
export const ACTIVE_REVIEW_PHASES = ["waiting_for_evidence", "review", "correction"] as const;
export const REVIEW_DECISION_ATTENTION = ["review_cycle_decision", "review_cycle_ready"] as const;
export type ReviewCycleData = {
  policy: ReviewCyclePolicy;
  authorization: PlanExecutionAuthorization;
  reviewerManifestHash: string | null;
  expectedHeads: PublishedReviewHead[] | null;
  lastBuilderTurnId: string;
  turnIds: string[];
  status: Omit<ReviewCycleStatus, "id" | "phase" | "deadline">;
};
export type ReviewCycle = typeof storyReviewCycles.$inferSelect & {
  phase: ReviewCyclePhase;
  data: ReviewCycleData;
};

export function isReviewActive(phase: string) {
  return (ACTIVE_REVIEW_PHASES as readonly string[]).includes(phase);
}

export async function latestReviewCycle(db: FacilityDb, scope: WorkflowScope) {
  const [row] = await db
    .select()
    .from(storyReviewCycles)
    .where(
      and(
        eq(storyReviewCycles.orgId, scope.orgId),
        eq(storyReviewCycles.projectId, scope.projectId),
        eq(storyReviewCycles.storyId, scope.storyId),
      ),
    )
    .orderBy(desc(storyReviewCycles.createdAt), desc(storyReviewCycles.originTurnId))
    .limit(1);
  return row as ReviewCycle | undefined;
}

export function projectReviewCycle(cycle: ReviewCycle): ReviewCycleStatus {
  return {
    ...cycle.data.status,
    id: cycle.originTurnId,
    phase: cycle.phase,
    deadline: cycle.deadline.toISOString(),
  };
}

export async function reviewHoldsQueue(db: FacilityDb, scope: WorkflowScope, humanRequest = false) {
  const cycle = await latestReviewCycle(db, scope);
  if (!cycle) return false;
  if (isReviewActive(cycle.phase)) return true;
  if (humanRequest) return false;
  const [gate] = await db
    .select({ id: attentionItems.id })
    .from(attentionItems)
    .where(
      and(
        eq(attentionItems.orgId, scope.orgId),
        eq(attentionItems.projectId, scope.projectId),
        eq(attentionItems.storyId, scope.storyId),
        eq(attentionItems.status, "open"),
        inArray(attentionItems.kind, [...REVIEW_DECISION_ATTENTION]),
      ),
    )
    .limit(1);
  return Boolean(gate);
}

/** Runs in the same story transaction that commits the Builder's final response. */
export async function seedReviewCycle(
  tx: FacilityDb,
  turn: typeof turns.$inferSelect,
  output: string,
  attention: boolean,
) {
  if (turn.triggerType === REVIEW_TRIGGER || attention) return;
  const scope = { orgId: turn.orgId, projectId: turn.projectId, storyId: turn.storyId };
  const state = await readWorkflowPolicy(tx, scope);
  const policy = state.policy.reviewCycle;
  if (!policy || turn.agentName !== policy.builderAgent) return;
  const authorization = await readPlanExecutionReceipt(tx, scope, turn.id);
  if (!authorization || authorization.policyRevision !== state.revision) return;
  // Only a Builder turn that declares the complete registered delivery starts a
  // cycle; other Builder turns (questions, partial work) leave the story as it is.
  const expectedHeads = deliveryHeadsFromOutput(output);
  if (!declaresRegisteredDelivery(await readStoryDelivery(tx, scope), expectedHeads)) return;
  const previous = await latestReviewCycle(tx, scope);
  // An automatic replay cannot start a fresh cycle. A new human Builder turn
  // needs a newer approved plan decision, even if it uses the same plan text.
  if (
    previous &&
    (isReviewActive(previous.phase) ||
      (turn.createdBy as { type?: unknown } | null)?.type !== "user" ||
      authorization.decisionRevision <= previous.data.authorization.decisionRevision)
  )
    return;
  const data: ReviewCycleData = {
    policy,
    authorization,
    reviewerManifestHash: null,
    expectedHeads,
    lastBuilderTurnId: turn.id,
    turnIds: [],
    status: {
      builderAgent: policy.builderAgent,
      reviewerAgent: policy.reviewerAgent,
      reviewsStarted: 0,
      correctionsStarted: 0,
      costCents: 0,
      reason: "Checking the registered delivery and its evidence.",
      activeTurnId: null,
      candidate: null,
      reviews: [],
    },
  };
  await tx
    .insert(storyReviewCycles)
    .values({
      ...scope,
      originTurnId: turn.id,
      deadline: new Date((turn.endedAt?.getTime() ?? Date.now()) + policy.timeoutMinutes * 60_000),
      data,
    })
    .onConflictDoNothing();
}

export async function saveReviewCycle(db: FacilityDb, cycle: ReviewCycle, phase = cycle.phase) {
  await db
    .update(storyReviewCycles)
    .set({ phase, data: cycle.data, updatedAt: new Date() })
    .where(
      and(
        eq(storyReviewCycles.originTurnId, cycle.originTurnId),
        eq(storyReviewCycles.orgId, cycle.orgId),
        eq(storyReviewCycles.projectId, cycle.projectId),
        eq(storyReviewCycles.storyId, cycle.storyId),
      ),
    );
}

export async function finishReviewCycle(
  tx: FacilityDb,
  cycle: ReviewCycle,
  phase: "human_review" | "decision_required",
  reason: string,
) {
  const scope = { orgId: cycle.orgId, projectId: cycle.projectId, storyId: cycle.storyId };
  const turnId = cycle.data.status.activeTurnId ?? cycle.data.lastBuilderTurnId;
  cycle.data.status.activeTurnId = null;
  cycle.data.status.reason = reason;
  await saveReviewCycle(tx, cycle, phase);
  await tx.insert(attentionItems).values({
    ...scope,
    id: newId("attn"),
    turnId,
    kind: phase === "human_review" ? "review_cycle_ready" : "review_cycle_decision",
    title:
      phase === "human_review"
        ? "Delivery ready for human review"
        : "Delivery review needs a human decision",
    detail: reason,
  });
  await tx
    .update(stories)
    .set({
      status: sql`case when ${stories.status} in ('done', 'archived') then ${stories.status} else ${phase === "human_review" ? "review" : "attention"} end`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(stories.orgId, scope.orgId),
        eq(stories.projectId, scope.projectId),
        eq(stories.id, scope.storyId),
      ),
    );
  await appendStoryEvidence(tx, {
    ...scope,
    turnId,
    source: "facility",
    type: phase === "human_review" ? "review_cycle.human_review" : "review_cycle.decision_required",
    externalKey: `review-cycle:${cycle.originTurnId}:decision`,
    data: {
      id: cycle.originTurnId,
      phase,
      reason,
      actor: REVIEW_ACTOR,
      candidateId: cycle.data.status.candidate?.id ?? null,
      reviewsStarted: cycle.data.status.reviewsStarted,
      correctionsStarted: cycle.data.status.correctionsStarted,
    },
  });
}
