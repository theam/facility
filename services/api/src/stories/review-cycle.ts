import { type AgentManifest, AgentManifestSchema } from "@facility/agents";
import { reservationCents } from "@facility/core";
import {
  agentManifests,
  attentionItems,
  engineSessions,
  type FacilityDb,
  stories,
  storyDeliveryPullRequests,
  storyMessages,
  storyReviewCycles,
  turnGitEvidence,
  turns,
  turnUsage,
} from "@facility/db";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { AgentCatalogService } from "../agents/catalog.js";
import { reconciliationPage } from "../reconciliation.js";
import { underDeadline } from "./consultation-sources.js";
import {
  checkReviewBudget,
  deliveryHeadsFromOutput,
  MAX_CORRECTIONS,
  MAX_REVIEWS,
  REVIEW_ACTOR,
  REVIEW_TRIGGER,
  ReviewCycleStop,
  readReviewResult,
  reviewCatalogProblem,
  reviewCorrectionPrompt,
  reviewDecision,
} from "./review-cycle-rules.js";
import { captureReviewCandidate, type ReviewCycleSource } from "./review-cycle-source.js";
import {
  ACTIVE_REVIEW_PHASES,
  finishReviewCycle,
  isReviewActive,
  latestReviewCycle,
  type ReviewCycle,
  saveReviewCycle,
} from "./review-cycle-state.js";
import type { StoryWorkspaceService } from "./service.js";
import { planExecutionStillAuthorized, readWorkflowPlan } from "./workflow-execution.js";
import { lockWorkflowStory, readWorkflowPolicy, type WorkflowScope } from "./workflow-policy.js";

type Turn = typeof turns.$inferSelect;

export class StoryReviewCycles {
  constructor(
    private readonly db: FacilityDb,
    private readonly storiesService: StoryWorkspaceService,
    private readonly catalog: AgentCatalogService,
    private readonly source: ReviewCycleSource,
    private readonly enqueue: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
  ) {}

  async refresh(scope: WorkflowScope) {
    const snapshot = await underDeadline(
      this.catalog.refreshSnapshot(scope.orgId, scope.projectId),
      AbortSignal.timeout(10_000),
    ).catch(() => null);
    const cycle = await latestReviewCycle(this.db, scope);
    if (!cycle || !snapshot?.repositoryId)
      throw new ReviewCycleStop("The current canonical agent catalog could not be verified.");
    const problem = reviewCatalogProblem(cycle.data.policy, snapshot.manifests);
    if (problem) throw new ReviewCycleStop(problem);
  }

  async reconcile(scope: WorkflowScope) {
    const current = await latestReviewCycle(this.db, scope);
    if (!current || !isReviewActive(current.phase)) return;
    const currentTurn = current.data.status.activeTurnId
      ? await this.turn(this.db, scope, current.data.status.activeTurnId)
      : undefined;
    if (currentTurn?.state === "queued" || currentTurn?.state === "running") return;
    let catalogError: ReviewCycleStop | undefined;
    try {
      await this.refresh(scope);
    } catch (error) {
      if (!(error instanceof ReviewCycleStop)) throw error;
      catalogError = error;
    }
    const queued = await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await lockWorkflowStory(tx, scope);
      const cycle = await latestReviewCycle(tx, scope);
      if (!cycle || cycle.originTurnId !== current.originTurnId || !isReviewActive(cycle.phase))
        return;
      const turn = cycle.data.status.activeTurnId
        ? await this.turn(tx, scope, cycle.data.status.activeTurnId)
        : undefined;
      if (turn?.state === "queued" || turn?.state === "running") return;
      try {
        const { status } = cycle.data;
        status.costCents = await this.spent(tx, cycle);
        if (catalogError) throw catalogError;
        if (status.activeTurnId && turn?.state !== "succeeded")
          throw new ReviewCycleStop(
            turn?.error?.slice(0, 1_000) || "A cycle turn failed or was canceled.",
          );
        const context = await this.authority(tx, cycle);
        const signal = this.evidenceSignal(cycle);
        if (cycle.phase === "correction" && turn) {
          cycle.data.expectedHeads = deliveryHeadsFromOutput(await this.output(tx, scope, turn.id));
          cycle.data.lastBuilderTurnId = turn.id;
          status.activeTurnId = null;
          cycle.phase = "waiting_for_evidence";
        }
        if (cycle.phase === "waiting_for_evidence") {
          const snapshot = await captureReviewCandidate(
            tx,
            this.source,
            cycle,
            context.requirePreview,
            signal,
          );
          if (snapshot.candidate) status.candidate = snapshot.candidate;
          if (snapshot.state === "waiting") {
            status.reason = snapshot.reason;
            await saveReviewCycle(tx, cycle);
            return;
          }
          return await this.queue(
            tx,
            cycle,
            context.reviewer,
            "review",
            "Review the complete candidate " +
              snapshot.candidate.id +
              " against the approved plan and return the structured result.",
          );
        }
        if (cycle.phase !== "review" || !turn || !status.candidate)
          throw new ReviewCycleStop("The cycle cannot identify its completed review turn.");
        let report = status.reviews.find((item) => item.turnId === turn.id);
        if (!report) {
          report = {
            turnId: turn.id,
            candidate: status.candidate,
            reviewerManifestHash: turn.manifestHash,
            policyRevision: cycle.data.authorization.policyRevision,
            planRevision: cycle.data.authorization.planRevision,
            result: readReviewResult(
              await this.output(tx, scope, turn.id),
              status.candidate,
              status.reviews.at(-1)?.result,
            ),
          };
          status.reviews.push(report);
        }
        await this.assertCandidate(tx, cycle, context.requirePreview, signal);
        checkReviewBudget(status.costCents, 0, cycle.data.policy.maxCostCents);
        const decision = reviewDecision(report.result, status.reviewsStarted);
        if (decision.phase !== "correction") {
          await finishReviewCycle(tx, cycle, decision.phase, decision.reason);
          return;
        }
        await this.requireBuilderSession(tx, cycle);
        return await this.queue(
          tx,
          cycle,
          context.builder,
          "correction",
          reviewCorrectionPrompt(status.candidate, decision.findings),
        );
      } catch (error) {
        if (!(error instanceof ReviewCycleStop)) throw error;
        await finishReviewCycle(tx, cycle, "decision_required", error.message);
      }
    });
    if (queued)
      await this.enqueue("turns.dispatch", {
        orgId: scope.orgId,
        projectId: scope.projectId,
        turnId: queued.id,
      }).catch(() => {
        // The existing durable turn sweep republishes the committed queued turn.
        console.warn(
          JSON.stringify({ event: "review_cycle.queue_publication_deferred", turnId: queued.id }),
        );
      });
  }

  async observePull(repositoryId: string, pullNumber: number) {
    const scopes = await this.db
      .select({
        orgId: storyDeliveryPullRequests.orgId,
        projectId: storyDeliveryPullRequests.projectId,
        storyId: storyDeliveryPullRequests.storyId,
      })
      .from(storyDeliveryPullRequests)
      .innerJoin(
        storyReviewCycles,
        and(
          eq(storyReviewCycles.orgId, storyDeliveryPullRequests.orgId),
          eq(storyReviewCycles.projectId, storyDeliveryPullRequests.projectId),
          eq(storyReviewCycles.storyId, storyDeliveryPullRequests.storyId),
        ),
      )
      .where(
        and(
          eq(storyDeliveryPullRequests.repositoryId, repositoryId),
          eq(storyDeliveryPullRequests.pullNumber, pullNumber),
          eq(storyDeliveryPullRequests.required, true),
          inArray(storyReviewCycles.phase, [...ACTIVE_REVIEW_PHASES]),
        ),
      )
      .limit(25);
    await this.reconcileAll(scopes);
  }

  async recover() {
    const rows = await reconciliationPage(this.db, "story-review-cycles", (tx, after) =>
      tx
        .select({
          id: storyReviewCycles.originTurnId,
          orgId: storyReviewCycles.orgId,
          projectId: storyReviewCycles.projectId,
          storyId: storyReviewCycles.storyId,
        })
        .from(storyReviewCycles)
        .where(
          and(
            inArray(storyReviewCycles.phase, [...ACTIVE_REVIEW_PHASES]),
            after ? gt(storyReviewCycles.originTurnId, after) : undefined,
          ),
        )
        .orderBy(storyReviewCycles.originTurnId)
        .limit(25),
    );
    await this.reconcileAll(rows);
    return rows.length;
  }

  private async reconcileAll(scopes: WorkflowScope[]) {
    for (const scope of scopes) {
      try {
        await this.reconcile(scope);
      } catch {
        console.warn(
          JSON.stringify({ event: "review_cycle.reconciliation_deferred", storyId: scope.storyId }),
        );
      }
    }
  }

  /** Admission runs under the same project/story lock as plan and budget admission. */
  async authorizeTurn(tx: FacilityDb, scope: WorkflowScope, turn: Turn) {
    const cycle = await latestReviewCycle(tx, scope);
    if (
      !cycle ||
      !["review", "correction"].includes(cycle.phase) ||
      cycle.data.status.activeTurnId !== turn.id ||
      turn.triggerKey !== `${cycle.originTurnId}:${cycle.phase}`
    )
      throw new ReviewCycleStop("The automatic turn is outside the current review cycle.");
    const context = await this.authority(tx, cycle);
    const reviewer = cycle.phase === "review";
    const expectedAgent = reviewer ? context.reviewer : context.builder;
    if (turn.manifestHash !== expectedAgent.hash || turn.agentName !== expectedAgent.name)
      throw new ReviewCycleStop("The automatic turn's agent configuration changed.");
    if (
      reviewer
        ? cycle.data.status.reviewsStarted >= MAX_REVIEWS
        : cycle.data.status.correctionsStarted >= MAX_CORRECTIONS
    )
      throw new ReviewCycleStop("The cycle reached its automatic turn limit.");
    if (!reviewer) await this.requireBuilderSession(tx, cycle);
    await this.assertCandidate(tx, cycle, context.requirePreview, this.evidenceSignal(cycle));
    checkReviewBudget(
      await this.spent(tx, cycle),
      reservationCents(turn.model, reviewer ? "consultation" : "turn"),
      cycle.data.policy.maxCostCents,
    );
    return cycle;
  }

  async recordStart(tx: FacilityDb, cycle: ReviewCycle, turnId: string) {
    if (cycle.phase === "review") cycle.data.status.reviewsStarted++;
    else cycle.data.status.correctionsStarted++;
    cycle.data.turnIds.push(turnId);
    cycle.data.status.reason = null;
    await saveReviewCycle(tx, cycle);
  }

  async stillAuthorized(scope: WorkflowScope, turn: Turn) {
    const cycle = await latestReviewCycle(this.db, scope);
    if (
      !cycle ||
      !isReviewActive(cycle.phase) ||
      cycle.data.status.activeTurnId !== turn.id ||
      cycle.deadline <= new Date()
    )
      return false;
    try {
      await this.authority(this.db, cycle);
      return true;
    } catch (error) {
      if (error instanceof ReviewCycleStop) return false;
      throw error;
    }
  }

  async revalidateBeforeExecution(cycle: ReviewCycle, signal: AbortSignal) {
    await this.refresh(cycle);
    const context = await this.authority(this.db, cycle);
    await this.assertCandidate(this.db, cycle, context.requirePreview, signal);
  }

  private async queue(
    tx: FacilityDb,
    cycle: ReviewCycle,
    agent: AgentManifest,
    phase: "review" | "correction",
    body: string,
  ) {
    const turn = await this.storiesService.queueReviewTurn(tx, {
      orgId: cycle.orgId,
      projectId: cycle.projectId,
      storyId: cycle.storyId,
      body,
      agent,
      actor: REVIEW_ACTOR,
      dedupeKey: ["review-cycle", cycle.originTurnId, phase, cycle.data.status.reviewsStarted].join(
        ":",
      ),
      trigger: { type: REVIEW_TRIGGER, key: `${cycle.originTurnId}:${phase}` },
    });
    if (!turn) {
      cycle.data.status.reason = "Waiting for the current workspace writer to release its lease.";
      await saveReviewCycle(tx, cycle);
      return;
    }
    cycle.data.status.activeTurnId = turn.id;
    cycle.data.status.reason = "Waiting for turn admission.";
    await saveReviewCycle(tx, cycle, phase);
    return turn;
  }

  private async authority(db: FacilityDb, cycle: ReviewCycle) {
    if (cycle.deadline <= new Date())
      throw new ReviewCycleStop("The review cycle reached its time limit.");
    const policy = await readWorkflowPolicy(db, cycle);
    if (policy.revision !== cycle.data.authorization.policyRevision || !policy.policy.reviewCycle)
      throw new ReviewCycleStop("The project review policy changed during the cycle.");
    const [story] = await db
      .select()
      .from(stories)
      .where(
        and(
          eq(stories.orgId, cycle.orgId),
          eq(stories.projectId, cycle.projectId),
          eq(stories.id, cycle.storyId),
        ),
      )
      .limit(1);
    const [gate] = await db
      .select({ id: attentionItems.id })
      .from(attentionItems)
      .where(
        and(
          eq(attentionItems.orgId, cycle.orgId),
          eq(attentionItems.projectId, cycle.projectId),
          eq(attentionItems.storyId, cycle.storyId),
          eq(attentionItems.status, "open"),
          inArray(attentionItems.kind, ["agent_waiting", "workflow_approval"]),
        ),
      )
      .limit(1);
    if (!story || story.deletedAt || ["done", "archived"].includes(story.status) || gate)
      throw new ReviewCycleStop("The story is unavailable or has a pending human gate.");
    const origin = await this.turn(db, cycle, cycle.originTurnId);
    if (!origin || !(await planExecutionStillAuthorized(db, cycle, origin)))
      throw new ReviewCycleStop("The Builder's plan, authorization or repository scope changed.");
    const plan = await readWorkflowPlan(db, cycle);
    const rows = await db
      .select()
      .from(agentManifests)
      .where(
        and(
          eq(agentManifests.orgId, cycle.orgId),
          eq(agentManifests.projectId, cycle.projectId),
          inArray(agentManifests.name, [
            cycle.data.policy.builderAgent,
            cycle.data.policy.reviewerAgent,
            "address-review",
          ]),
        ),
      );
    const manifests = rows.map((row) => AgentManifestSchema.parse(row.manifest));
    const problem = reviewCatalogProblem(cycle.data.policy, manifests);
    if (problem) throw new ReviewCycleStop(problem);
    const reviewer = manifests.find(
      (manifest) => manifest.name === cycle.data.policy.reviewerAgent,
    );
    const builder = manifests.find((manifest) => manifest.name === cycle.data.policy.builderAgent);
    const approvedReviewer = plan.plan?.agents.find((agent) => agent.name === reviewer?.name);
    if (
      !builder ||
      !reviewer ||
      approvedReviewer?.manifestHash !== reviewer.hash ||
      (cycle.data.reviewerManifestHash && cycle.data.reviewerManifestHash !== reviewer.hash)
    )
      throw new ReviewCycleStop(
        "Approve a plan with the exact enabled Builder and Reviewer versions.",
      );
    cycle.data.reviewerManifestHash = reviewer.hash;
    return { reviewer, builder, requirePreview: policy.policy.requirePreviewForAcceptance };
  }

  private evidenceSignal(cycle: ReviewCycle) {
    return AbortSignal.timeout(
      Math.max(1, Math.min(15_000, cycle.deadline.getTime() - Date.now())),
    );
  }

  private async assertCandidate(
    db: FacilityDb,
    cycle: ReviewCycle,
    requirePreview: boolean,
    signal: AbortSignal,
  ) {
    const pinned = cycle.data.status.candidate;
    if (!pinned) throw new ReviewCycleStop("The review cycle has no verified candidate.");
    const live = await captureReviewCandidate(db, this.source, cycle, requirePreview, signal);
    if (live.state !== "ready" || live.candidate.id !== pinned.id)
      throw new ReviewCycleStop("The candidate or its required evidence changed during the cycle.");
  }

  async requireBuilderSession(db: FacilityDb, cycle: ReviewCycle) {
    const [session] = await db
      .select({ id: engineSessions.id, nativeSessionId: engineSessions.nativeSessionId })
      .from(turnGitEvidence)
      .innerJoin(
        engineSessions,
        and(
          eq(engineSessions.id, turnGitEvidence.engineSessionId),
          eq(engineSessions.orgId, turnGitEvidence.orgId),
          eq(engineSessions.projectId, turnGitEvidence.projectId),
          eq(engineSessions.storyId, turnGitEvidence.storyId),
        ),
      )
      .where(
        and(
          eq(turnGitEvidence.orgId, cycle.orgId),
          eq(turnGitEvidence.projectId, cycle.projectId),
          eq(turnGitEvidence.storyId, cycle.storyId),
          eq(turnGitEvidence.turnId, cycle.originTurnId),
          eq(engineSessions.status, "active"),
        ),
      )
      .limit(1);
    if (!session?.nativeSessionId)
      throw new ReviewCycleStop("The original Builder session cannot be resumed.");
    return session;
  }

  private async spent(db: FacilityDb, cycle: ReviewCycle) {
    const ids = cycle.data.turnIds;
    if (!ids.length) return 0;
    const rows = await db
      .select({ priced: turnUsage.priced, cents: turnUsage.costCents })
      .from(turnUsage)
      .where(
        and(
          eq(turnUsage.orgId, cycle.orgId),
          eq(turnUsage.projectId, cycle.projectId),
          eq(turnUsage.storyId, cycle.storyId),
          inArray(turnUsage.turnId, ids),
        ),
      );
    if (rows.length !== ids.length || rows.some((row) => !row.priced || row.cents === null))
      return null;
    return rows.reduce((total, row) => total + (row.cents ?? 0), 0);
  }

  private async turn(db: FacilityDb, scope: WorkflowScope, id: string) {
    const [turn] = await db
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.orgId, scope.orgId),
          eq(turns.projectId, scope.projectId),
          eq(turns.storyId, scope.storyId),
          eq(turns.id, id),
        ),
      )
      .limit(1);
    return turn;
  }

  private async output(db: FacilityDb, scope: WorkflowScope, turnId: string) {
    const [message] = await db
      .select({ body: storyMessages.body })
      .from(storyMessages)
      .where(
        and(
          eq(storyMessages.orgId, scope.orgId),
          eq(storyMessages.projectId, scope.projectId),
          eq(storyMessages.storyId, scope.storyId),
          eq(storyMessages.turnId, turnId),
          eq(storyMessages.role, "agent"),
        ),
      )
      .limit(1);
    return message?.body ?? "";
  }
}
