import {
  type DeliveryAcceptanceReceipt,
  type DeliveryAcceptanceRequest,
  type DeliveryAcceptanceSnapshot,
  DeliveryAcceptanceSnapshotSchema,
  newId,
  type PlanActor,
  type RequestDeliveryAcceptanceBody,
  type StoryDeliveryAcceptance,
} from "@facility/core";
import {
  type FacilityDb,
  githubPullRequests,
  stories,
  storyDeliveryAcceptanceRequests,
  storyDeliveryAcceptances,
  storyDeliveryPullRequests,
  storyPreviewConvergences,
} from "@facility/db";
import { and, desc, eq } from "drizzle-orm";
import type { z } from "zod";
import { authorizePrincipal } from "../auth/workspace-execution.js";
import { ApiError } from "../errors.js";
import { readStoryDelivery } from "./delivery.js";
import { appendStoryEvidence } from "./evidence.js";
import type { InteractivePlanActor } from "./plan-confirmation.js";
import {
  verifyWorkflowConfirmationProof,
  WORKFLOW_CONFIRMATION_TTL_MS,
  workflowConfirmationProof,
} from "./workflow-confirmation.js";
import { readWorkflowPlan } from "./workflow-execution.js";
import {
  authorizeWorkflowHuman,
  lockWorkflowStory,
  readWorkflowPolicy,
  type WorkflowScope,
  workflowDigest,
} from "./workflow-policy.js";

type RequestRow = typeof storyDeliveryAcceptanceRequests.$inferSelect;
type ReceiptRow = typeof storyDeliveryAcceptances.$inferSelect;
const where = (
  table: typeof storyDeliveryAcceptanceRequests | typeof storyDeliveryAcceptances,
  scope: WorkflowScope,
) =>
  and(
    eq(table.orgId, scope.orgId),
    eq(table.projectId, scope.projectId),
    eq(table.storyId, scope.storyId),
  );
const receiptProjection = (row: ReceiptRow): DeliveryAcceptanceReceipt => ({
  id: row.id,
  revision: row.revision,
  requestId: row.requestId,
  snapshot: row.snapshot,
  confirmedBy: row.confirmedBy,
  confirmedAt: row.confirmedAt.toISOString(),
  method: row.method,
});
async function latestReceipt(db: FacilityDb, scope: WorkflowScope) {
  const [row] = await db
    .select()
    .from(storyDeliveryAcceptances)
    .where(where(storyDeliveryAcceptances, scope))
    .orderBy(desc(storyDeliveryAcceptances.revision))
    .limit(1);
  return row;
}
async function assertStory(db: FacilityDb, scope: WorkflowScope) {
  const [story] = await db
    .select()
    .from(stories)
    .where(
      and(
        eq(stories.orgId, scope.orgId),
        eq(stories.projectId, scope.projectId),
        eq(stories.id, scope.storyId),
      ),
    )
    .limit(1);
  if (!story || story.deletedAt) throw new ApiError(404, "not_found", "Story not found");
}
/** Under the project/story lock, freeze GitHub mirror writes through receipt creation. */
async function freezeCandidate(db: FacilityDb, scope: WorkflowScope) {
  await assertStory(db, scope);
  await db
    .select({ id: githubPullRequests.id })
    .from(githubPullRequests)
    .innerJoin(
      storyDeliveryPullRequests,
      and(
        eq(storyDeliveryPullRequests.repositoryId, githubPullRequests.repositoryId),
        eq(storyDeliveryPullRequests.pullNumber, githubPullRequests.number),
      ),
    )
    .where(
      and(
        eq(storyDeliveryPullRequests.orgId, scope.orgId),
        eq(storyDeliveryPullRequests.projectId, scope.projectId),
        eq(storyDeliveryPullRequests.storyId, scope.storyId),
        eq(storyDeliveryPullRequests.required, true),
      ),
    )
    .for("share", { of: githubPullRequests });
}
async function candidateSnapshot(
  db: FacilityDb,
  scope: WorkflowScope,
  acceptanceRevision: number,
  requireReadyPreview: boolean,
): Promise<DeliveryAcceptanceSnapshot> {
  const policy = await readWorkflowPolicy(db, scope);
  const delivery = await readStoryDelivery(db, scope);
  const plan = await readWorkflowPlan(db, scope);
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
    const [preview] = await db
      .select()
      .from(storyPreviewConvergences)
      .where(
        and(
          eq(storyPreviewConvergences.orgId, scope.orgId),
          eq(storyPreviewConvergences.projectId, scope.projectId),
          eq(storyPreviewConvergences.storyId, scope.storyId),
        ),
      )
      .for("share")
      .limit(1);
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
    planDigest: plan.plan?.digest ?? null,
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
function sameAcceptedCandidate(a: DeliveryAcceptanceSnapshot, b: DeliveryAcceptanceSnapshot) {
  // A retained workspace may be suspended after acceptance. Keep preview evidence
  // in the receipt without making running compute a permanent acceptance condition.
  return (
    workflowDigest({ ...a, previewGeneration: null }) ===
    workflowDigest({ ...b, previewGeneration: null })
  );
}
export async function readDeliveryAcceptance(
  db: FacilityDb,
  scope: WorkflowScope,
): Promise<StoryDeliveryAcceptance> {
  await assertStory(db, scope);
  const policy = await readWorkflowPolicy(db, scope);
  const receipt = await latestReceipt(db, scope);
  let current = false;
  if (receipt) {
    try {
      const snapshot = await candidateSnapshot(
        db,
        scope,
        receipt.snapshot.acceptanceRevision,
        false,
      );
      await authorizePrincipal(
        db,
        scope,
        { type: "user", id: receipt.confirmedBy.id },
        ["projects:write"],
        "workflow_acceptor_revoked",
      );
      current = sameAcceptedCandidate(snapshot, receipt.snapshot);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  }
  return {
    schemaVersion: 1,
    ...scope,
    required: policy.policy.requireDeliveryAcceptance,
    status: !receipt ? "missing" : current ? "current" : "stale",
    receipt: receipt ? receiptProjection(receipt) : null,
  };
}
export async function assertDeliveryAccepted(db: FacilityDb, scope: WorkflowScope) {
  const policy = await readWorkflowPolicy(db, scope);
  if (!policy.policy.requireDeliveryAcceptance) return;
  if ((await readDeliveryAcceptance(db, scope)).status !== "current")
    throw new ApiError(
      409,
      "workflow_delivery_acceptance_required",
      "A project member must review and accept this exact current delivery before completion",
    );
}
function confirmationUrl(scope: WorkflowScope, id: string, webUrl: string) {
  return `${webUrl.replace(/\/$/, "")}/projects/${encodeURIComponent(scope.projectId)}/stories/${encodeURIComponent(scope.storyId)}/delivery-acceptance/${encodeURIComponent(id)}`;
}
function requestProjection(
  row: RequestRow,
  scope: WorkflowScope,
  webUrl: string,
  status: DeliveryAcceptanceRequest["status"],
): DeliveryAcceptanceRequest {
  return {
    id: row.id,
    snapshot: row.snapshot,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status,
    confirmationUrl: confirmationUrl(scope, row.id, webUrl),
  };
}
export async function requestDeliveryAcceptance(
  db: FacilityDb,
  scope: WorkflowScope,
  body: z.infer<typeof RequestDeliveryAcceptanceBody>,
  actor: PlanActor,
  webUrl: string,
  now = new Date(),
) {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as FacilityDb;
    await lockWorkflowStory(tx, scope);
    await freezeCandidate(tx, scope);
    const previous = await latestReceipt(tx, scope);
    const snapshot = await candidateSnapshot(tx, scope, previous?.revision ?? 0, true);
    if (
      snapshot.candidateRevision !== body.expected_candidate_revision ||
      snapshot.planRevision !== body.expected_plan_revision ||
      snapshot.decisionRevision !== body.expected_decision_revision
    )
      throw new ApiError(
        409,
        "workflow_candidate_changed",
        "Reload and review the exact current delivery before requesting acceptance",
      );
    const [row] = await tx
      .insert(storyDeliveryAcceptanceRequests)
      .values({
        id: newId("dreq"),
        ...scope,
        snapshot,
        requestedBy: actor,
        boundUserId: actor.type === "user" ? actor.id : null,
        requestedAt: now,
        expiresAt: new Date(now.getTime() + WORKFLOW_CONFIRMATION_TTL_MS),
      })
      .returning();
    if (!row) throw new Error("acceptance_request_not_saved");
    return requestProjection(row, scope, webUrl, "pending");
  });
}
async function findRequest(db: FacilityDb, scope: WorkflowScope, requestId: string) {
  const [row] = await db
    .select()
    .from(storyDeliveryAcceptanceRequests)
    .where(
      and(
        where(storyDeliveryAcceptanceRequests, scope),
        eq(storyDeliveryAcceptanceRequests.id, requestId),
      ),
    )
    .limit(1);
  if (!row) throw new ApiError(404, "not_found", "Acceptance request not found");
  return row;
}
function binding(scope: WorkflowScope, row: RequestRow) {
  return {
    ...scope,
    purpose: "delivery_acceptance" as const,
    nonce: row.id,
    digest: workflowDigest(row.snapshot),
    expiresAt: row.expiresAt,
  };
}
function assertBoundUser(row: RequestRow, actor: InteractivePlanActor) {
  if (
    (row.boundUserId && row.boundUserId !== actor.id) ||
    (row.consumedByUserId && row.consumedByUserId !== actor.id)
  )
    throw new ApiError(
      403,
      "workflow_confirmation_wrong_user",
      "Open the acceptance request with its intended project member account",
    );
}
export async function checkDeliveryAcceptanceConfirmation(
  db: FacilityDb,
  scope: WorkflowScope,
  requestId: string,
  proof: string,
  actor: InteractivePlanActor,
  masterKey: string,
  now = new Date(),
) {
  await authorizeWorkflowHuman(db, scope, actor);
  const row = await findRequest(db, scope, requestId);
  assertBoundUser(row, actor);
  verifyWorkflowConfirmationProof(proof, binding(scope, row), actor, masterKey, now);
}
export async function reviewDeliveryAcceptance(
  db: FacilityDb,
  scope: WorkflowScope,
  requestId: string,
  actor: InteractivePlanActor,
  masterKey: string,
  webUrl: string,
  now = new Date(),
) {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as FacilityDb;
    await lockWorkflowStory(tx, scope);
    await authorizeWorkflowHuman(tx, scope, actor);
    const row = await findRequest(tx, scope, requestId);
    assertBoundUser(row, actor);
    let status: DeliveryAcceptanceRequest["status"] = row.consumedAt
      ? "confirmed"
      : row.expiresAt <= now
        ? "expired"
        : "pending";
    if (status === "pending") {
      try {
        await freezeCandidate(tx, scope);
        const previous = await latestReceipt(tx, scope);
        const current = await candidateSnapshot(tx, scope, previous?.revision ?? 0, true);
        if (workflowDigest(current) !== workflowDigest(row.snapshot)) status = "superseded";
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        status = "superseded";
      }
    }
    const [receipt] = await tx
      .select()
      .from(storyDeliveryAcceptances)
      .where(
        and(where(storyDeliveryAcceptances, scope), eq(storyDeliveryAcceptances.requestId, row.id)),
      )
      .limit(1);
    return {
      schemaVersion: 1 as const,
      ...scope,
      request: requestProjection(row, scope, webUrl, status),
      proof:
        status === "pending"
          ? workflowConfirmationProof(binding(scope, row), actor, masterKey)
          : null,
      receipt: receipt ? receiptProjection(receipt) : null,
    };
  });
}
export async function confirmDeliveryAcceptance(
  db: FacilityDb,
  scope: WorkflowScope,
  requestId: string,
  proof: string,
  actor: InteractivePlanActor,
  masterKey: string,
  now = new Date(),
): Promise<StoryDeliveryAcceptance> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as FacilityDb;
    await lockWorkflowStory(tx, scope);
    await checkDeliveryAcceptanceConfirmation(tx, scope, requestId, proof, actor, masterKey, now);
    const row = await findRequest(tx, scope, requestId);
    if (row.consumedAt)
      throw new ApiError(
        409,
        "workflow_confirmation_consumed",
        "This acceptance request has already been confirmed",
      );
    await freezeCandidate(tx, scope);
    const previous = await latestReceipt(tx, scope);
    const current = await candidateSnapshot(tx, scope, previous?.revision ?? 0, true);
    if (workflowDigest(current) !== workflowDigest(row.snapshot))
      throw new ApiError(
        409,
        "workflow_candidate_changed",
        "The delivery changed. Request a new review of the current candidate",
      );
    await tx
      .update(storyDeliveryAcceptanceRequests)
      .set({ consumedAt: now, consumedByUserId: actor.id })
      .where(
        and(
          where(storyDeliveryAcceptanceRequests, scope),
          eq(storyDeliveryAcceptanceRequests.id, row.id),
        ),
      );
    const receiptId = newId("dec");
    await tx.insert(storyDeliveryAcceptances).values({
      id: receiptId,
      ...scope,
      revision: (previous?.revision ?? 0) + 1,
      requestId: row.id,
      snapshot: current,
      confirmedBy: { type: "user", id: actor.id, name: actor.name },
      confirmedAt: now,
    });
    await appendStoryEvidence(tx, {
      ...scope,
      source: "facility",
      type: "delivery.accepted",
      externalKey: `delivery:acceptance:${receiptId}`,
      data: {
        receiptId,
        candidateRevision: current.candidateRevision,
        revision: (previous?.revision ?? 0) + 1,
        confirmedBy: actor.id,
        confirmedAt: now.toISOString(),
      },
    });
    return readDeliveryAcceptance(tx, scope);
  });
}
