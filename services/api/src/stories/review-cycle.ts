import { type AgentManifest, AgentManifestSchema } from "@facility/agents";
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
  deliveryHeadsFromOutput,
  MAX_CORRECTIONS,
  MAX_REVIEWS,
  REVIEW_ACTOR,
  REVIEW_TRIGGER,
  ReviewCycleStop,
  ReviewEvidenceUnavailable,
  readReviewResult,
  reviewCatalogProblem,
  reviewComment,
  reviewCommentMarker,
  reviewCorrectionPrompt,
  reviewDecision,
  reviewTurnInstructions,
} from "./review-cycle-rules.js";
import {
  assertDeliveryUnchanged,
  type CandidateEvidence,
  captureReviewCandidate,
  type ReviewCycleSource,
} from "./review-cycle-source.js";
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
    if (!snapshot)
      throw new ReviewEvidenceUnavailable(
        "The canonical agent catalog could not be read from GitHub. Facility retries until the cycle deadline.",
      );
    const cycle = await latestReviewCycle(this.db, scope);
    if (!cycle || !snapshot.repositoryId)
      throw new ReviewCycleStop("The current canonical agent catalog could not be verified.");
    const problem = reviewCatalogProblem(cycle.data.policy, snapshot.manifests);
    if (problem) throw new ReviewCycleStop(problem);
  }

  async reconcile(scope: WorkflowScope) {
    // Each pass reads GitHub without holding the story lock, then applies what it
    // read under the lock only if the cycle has not moved meanwhile. A transition
    // that needs fresh evidence (a finished correction) runs another pass.
    for (let pass = 0; pass < 3; pass++) {
      if ((await this.reconcilePass(scope)) === "done") break;
    }
    await this.publishReviews(scope).catch(() => {
      console.warn(
        JSON.stringify({ event: "review_cycle.publication_deferred", storyId: scope.storyId }),
      );
    });
  }

  /** Leaves each recorded report on its pull requests as a comment review, outside the
   * story lock, then records where it went (or why GitHub refused it) on the report. */
  private async publishReviews(scope: WorkflowScope) {
    const cycle = await latestReviewCycle(this.db, scope);
    if (!cycle) return;
    for (const [index, report] of cycle.data.status.reviews.entries()) {
      if (report.publication) continue;
      const publication = await Promise.all(
        report.candidate.pullRequests.map(async (pull) => {
          try {
            const url = await this.source.publishReview(
              cycle,
              pull,
              reviewComment(report, pull, index + 1),
              reviewCommentMarker(report.turnId, pull),
              AbortSignal.timeout(15_000),
            );
            return {
              repository: pull.repository,
              number: pull.number,
              state: "published" as const,
              url,
            };
          } catch (error) {
            return {
              repository: pull.repository,
              number: pull.number,
              state: "failed" as const,
              reason:
                error instanceof ReviewCycleStop
                  ? error.message
                  : "GitHub did not accept the review.",
            };
          }
        }),
      );
      await this.db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as FacilityDb;
        await lockWorkflowStory(tx, scope);
        const latest = await latestReviewCycle(tx, scope);
        if (latest?.originTurnId !== cycle.originTurnId) return;
        const stored = latest.data.status.reviews.find((item) => item.turnId === report.turnId);
        if (!stored || stored.publication) return;
        stored.publication = publication;
        await saveReviewCycle(tx, latest);
      });
    }
  }

  private async reconcilePass(scope: WorkflowScope): Promise<"done" | "again"> {
    const current = await latestReviewCycle(this.db, scope);
    if (!current || !isReviewActive(current.phase)) return "done";
    const currentTurn = current.data.status.activeTurnId
      ? await this.turn(this.db, scope, current.data.status.activeTurnId)
      : undefined;
    if (currentTurn?.state === "queued" || currentTurn?.state === "running") return "done";
    let catalogError: ReviewCycleStop | undefined;
    let unavailable: ReviewEvidenceUnavailable | undefined;
    try {
      await this.refresh(scope);
    } catch (error) {
      if (error instanceof ReviewEvidenceUnavailable) unavailable = error;
      else if (error instanceof ReviewCycleStop) catalogError = error;
      else throw error;
    }
    let observed: CandidateEvidence | ReviewCycleStop | undefined;
    // The evidence is read for a copy that authority() completes (it records the
    // Reviewer version the candidate id includes); the lock checks the same version.
    let evidenceCycle: ReviewCycle | undefined;
    const needsEvidence =
      current.phase === "waiting_for_evidence" ||
      (current.phase === "review" && currentTurn?.state === "succeeded");
    if (needsEvidence && !catalogError && !unavailable) {
      try {
        evidenceCycle = structuredClone(current);
        const context = await this.authority(this.db, evidenceCycle);
        observed = await captureReviewCandidate(
          this.db,
          this.source,
          evidenceCycle,
          context.requirePreview,
          this.evidenceSignal(current),
        );
      } catch (error) {
        if (error instanceof ReviewEvidenceUnavailable) unavailable = error;
        else if (error instanceof ReviewCycleStop) observed = error;
        else throw error;
      }
    }
    const result = await this.db.transaction(
      async (rawTx): Promise<{ next: "done" | "again"; queued?: Turn }> => {
        const tx = rawTx as unknown as FacilityDb;
        await lockWorkflowStory(tx, scope);
        const cycle = await latestReviewCycle(tx, scope);
        if (!cycle || cycle.originTurnId !== current.originTurnId || !isReviewActive(cycle.phase))
          return { next: "done" };
        // The evidence above was read for the cycle as it was; if it moved, read again.
        if (
          JSON.stringify([cycle.phase, cycle.data]) !==
          JSON.stringify([current.phase, current.data])
        )
          return { next: "again" };
        const turn = cycle.data.status.activeTurnId
          ? await this.turn(tx, scope, cycle.data.status.activeTurnId)
          : undefined;
        if (turn?.state === "queued" || turn?.state === "running") return { next: "done" };
        try {
          const { status } = cycle.data;
          status.costCents = await this.spent(tx, cycle);
          if (catalogError) throw catalogError;
          if (status.activeTurnId && turn?.state !== "succeeded")
            throw new ReviewCycleStop(
              turn?.error?.slice(0, 1_000) || "A cycle turn failed or was canceled.",
            );
          // Stops a cycle past its deadline, so unavailable evidence is retried only until then.
          const context = await this.authority(tx, cycle);
          if (
            evidenceCycle &&
            evidenceCycle.data.reviewerManifestHash !== cycle.data.reviewerManifestHash
          )
            return { next: "again" };
          if (cycle.phase === "correction" && turn) {
            cycle.data.expectedHeads = deliveryHeadsFromOutput(
              await this.output(tx, scope, turn.id),
            );
            cycle.data.lastBuilderTurnId = turn.id;
            status.activeTurnId = null;
            status.reason = "Checking the corrected delivery and its evidence.";
            await saveReviewCycle(tx, cycle, "waiting_for_evidence");
            return { next: "again" };
          }
          if (unavailable) {
            status.reason = unavailable.message;
            await saveReviewCycle(tx, cycle);
            return { next: "done" };
          }
          if (observed instanceof ReviewCycleStop) throw observed;
          if (!observed)
            throw new ReviewCycleStop("The cycle could not read its delivery evidence.");
          await assertDeliveryUnchanged(tx, cycle, observed.candidate);
          if (cycle.phase === "waiting_for_evidence") {
            if (observed.candidate) status.candidate = observed.candidate;
            if (observed.state === "waiting") {
              status.reason = observed.reason;
              await saveReviewCycle(tx, cycle);
              return { next: "done" };
            }
            return {
              next: "done",
              queued: await this.queue(
                tx,
                cycle,
                context.reviewer,
                "review",
                "Review the complete candidate " +
                  observed.candidate.id +
                  " against the approved plan and return the structured result.",
              ),
            };
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
          if (observed.state !== "ready" || observed.candidate.id !== status.candidate.id)
            throw new ReviewCycleStop(
              "The candidate or its required evidence changed during the cycle.",
            );
          const decision = reviewDecision(report.result, status.reviewsStarted);
          if (decision.phase !== "correction") {
            await finishReviewCycle(tx, cycle, decision.phase, decision.reason);
            return { next: "done" };
          }
          await this.requireBuilderSession(tx, cycle);
          return {
            next: "done",
            queued: await this.queue(
              tx,
              cycle,
              context.builder,
              "correction",
              reviewCorrectionPrompt(status.candidate, decision.findings),
            ),
          };
        } catch (error) {
          if (!(error instanceof ReviewCycleStop)) throw error;
          await finishReviewCycle(tx, cycle, "decision_required", error.message);
          return { next: "done" };
        }
      },
    );
    if (result.queued) {
      const turnId = result.queued.id;
      await this.enqueue("turns.dispatch", {
        orgId: scope.orgId,
        projectId: scope.projectId,
        turnId,
      }).catch(() => {
        // The existing durable turn sweep republishes the committed queued turn.
        console.warn(JSON.stringify({ event: "review_cycle.queue_publication_deferred", turnId }));
      });
    }
    return result.next;
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
    // Live GitHub evidence was checked before this lock (prepareAdmission) and is
    // checked again before execution; here only the stored delivery is compared.
    if (!cycle.data.status.candidate)
      throw new ReviewCycleStop("The review cycle has no verified candidate.");
    await assertDeliveryUnchanged(tx, cycle, cycle.data.status.candidate);
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

  /** The review contract a native Reviewer turn receives for the pinned candidate. */
  async reviewContract(cycle: ReviewCycle) {
    const candidate = cycle.data.status.candidate;
    const context = await readWorkflowPlan(this.db, cycle);
    if (!candidate || !context.plan || !context.decision)
      throw new ReviewCycleStop("The approved plan or the pinned candidate is unavailable.");
    return reviewTurnInstructions({
      candidate,
      plan: {
        revision: context.plan.revision,
        decisionRevision: context.decision.decisionRevision,
        markdown: context.plan.markdown,
      },
      previous: cycle.data.status.reviews.at(-1)?.result,
    });
  }

  /** Before the admission lock: the catalog and the live candidate evidence. */
  async prepareAdmission(scope: WorkflowScope) {
    const cycle = await latestReviewCycle(this.db, scope);
    if (!cycle || !isReviewActive(cycle.phase)) return;
    // Unavailable evidence is retried only until the deadline.
    if (cycle.deadline <= new Date())
      throw new ReviewCycleStop("The review cycle reached its time limit.");
    await this.refresh(scope);
    const { policy } = await readWorkflowPolicy(this.db, cycle);
    await this.assertCandidate(
      this.db,
      cycle,
      policy.requirePreviewForAcceptance,
      this.evidenceSignal(cycle),
    );
  }

  async revalidateBeforeExecution(cycle: ReviewCycle, signal: AbortSignal) {
    try {
      await this.refresh(cycle);
      const context = await this.authority(this.db, cycle);
      await this.assertCandidate(this.db, cycle, context.requirePreview, signal);
    } catch (error) {
      // The turn is already claimed; evidence that disappears now stops the cycle.
      if (error instanceof ReviewEvidenceUnavailable) throw new ReviewCycleStop(error.message);
      throw error;
    }
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
