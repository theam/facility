import { randomUUID } from "node:crypto";
import type {
  PreviewGenerationRepository,
  StoryPreviewConvergence,
  StoryPreviewConvergenceState,
} from "@facility/core";
import {
  type FacilityDb,
  stories,
  storyDeliveryPullRequests,
  storyDeliveryScopes,
  storyPreviewAttempts,
  storyPreviewConvergences,
  storyPreviewGenerations,
  turns,
  workspaces,
} from "@facility/db";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { ApiError } from "../errors.js";
import type { PreviewEndpoint } from "../workspaces/runtime.js";
import { readStoryDelivery } from "./delivery.js";

export type PreviewConvergenceScope = { orgId: string; projectId: string; storyId: string };
export type PreviewConvergenceJob = PreviewConvergenceScope;
export type PreviewConvergenceClaim =
  | {
      claimed: true;
      attemptId: string;
      attempt: number;
      leaseToken: string;
      leaseExpiresAt: Date;
      generation: string;
      repositories: PreviewGenerationRepository[];
    }
  | {
      claimed: false;
      reason:
        | "unconfigured"
        | "suspended"
        | "current"
        | "leased"
        | "writer_active"
        | "blocked"
        | "backoff";
      retryAt?: Date;
    };

type Enqueue = (queue: string, data: Record<string, unknown>) => Promise<unknown>;
type AttemptOutcome = "failed" | "blocked";
const QUEUE = "stories.preview-convergence";
const DEFAULT_LEASE_MS = 5 * 60_000;
const WRITER_RETRY_MS = 15_000;

/**
 * Durable latest-wins controller for pre-merge preview generations.
 *
 * GitHub observations only record immutable desired generations. A worker must
 * claim a fenced lease before touching a workspace, and a stale worker can
 * never publish over a newer desired generation.
 */
export class StoryPreviewConvergenceService {
  constructor(
    private readonly db: FacilityDb,
    private readonly enqueue: Enqueue,
    private readonly leaseMs = DEFAULT_LEASE_MS,
  ) {}

  async observe(scope: PreviewConvergenceScope, now = new Date()) {
    const delivery = await readStoryDelivery(this.db, scope, { now });
    if (delivery.candidate.state !== "recorded" || !delivery.candidate.revision) {
      return { recorded: false as const, reason: delivery.candidate.state };
    }
    const repositories = delivery.pullRequests
      .filter(
        (pull): pull is typeof pull & { headSha: string } => pull.required && pull.headSha !== null,
      )
      .sort(
        (left, right) =>
          left.repositoryId.localeCompare(right.repositoryId) || left.number - right.number,
      )
      .map(
        (pull): PreviewGenerationRepository => ({
          repositoryId: pull.repositoryId,
          repository: pull.repository,
          pullNumber: pull.number,
          headRef: pull.headRef,
          headSha: pull.headSha.toLowerCase(),
          primary: pull.primary,
        }),
      );
    const sourceObservedAt = latestSourceObservation(delivery, now);
    const generation = delivery.candidate.revision;
    const result = await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`facility:preview-convergence:${scope.orgId}:${scope.projectId}:${scope.storyId}`}))`,
      );
      await tx
        .insert(storyPreviewGenerations)
        .values({
          ...scope,
          generation,
          deliveryRevision: delivery.candidate.revision as string,
          repositories,
          sourceObservedAt,
        })
        .onConflictDoNothing();
      const [current] = await tx
        .select()
        .from(storyPreviewConvergences)
        .where(convergenceWhere(scope))
        .for("update")
        .limit(1);
      if (!current) {
        await tx.insert(storyPreviewConvergences).values({
          ...scope,
          desiredGeneration: generation,
          desiredObservedAt: sourceObservedAt,
          state: "pending",
          revision: 1,
        });
        return { changed: true, enqueue: true };
      }
      if (sourceObservedAt < current.desiredObservedAt) {
        return { changed: false, enqueue: false };
      }
      if (current.desiredGeneration === generation) {
        return {
          changed: false,
          enqueue:
            current.state === "pending" ||
            current.state === "waiting" ||
            (current.state === "failed" && (!current.retryAt || current.retryAt <= now)) ||
            (current.state === "applying" &&
              (!current.leaseExpiresAt || current.leaseExpiresAt <= now)),
        };
      }
      const activeLease =
        current.state === "applying" &&
        current.leaseExpiresAt !== null &&
        current.leaseExpiresAt > now;
      const state =
        current.state === "suspended" ? "suspended" : activeLease ? "applying" : "pending";
      await tx
        .update(storyPreviewConvergences)
        .set({
          desiredGeneration: generation,
          desiredObservedAt: sourceObservedAt,
          state,
          revision: current.revision + 1,
          ...(activeLease
            ? {}
            : {
                leaseToken: null,
                leaseGeneration: null,
                leaseExpiresAt: null,
                errorCode: null,
                errorMessage: null,
                retryAt: null,
              }),
          updatedAt: now,
        })
        .where(convergenceWhere(scope));
      return { changed: true, enqueue: state === "pending" };
    });
    if (result.enqueue) await this.enqueue(QUEUE, scope);
    return { recorded: true as const, generation, ...result };
  }

  async observePull(repositoryId: string, pullNumber: number, now = new Date()) {
    const scopes = await this.db
      .select({
        orgId: storyDeliveryPullRequests.orgId,
        projectId: storyDeliveryPullRequests.projectId,
        storyId: storyDeliveryPullRequests.storyId,
      })
      .from(storyDeliveryPullRequests)
      .where(
        and(
          eq(storyDeliveryPullRequests.repositoryId, repositoryId),
          eq(storyDeliveryPullRequests.pullNumber, pullNumber),
          eq(storyDeliveryPullRequests.required, true),
        ),
      )
      .orderBy(asc(storyDeliveryPullRequests.storyId));
    const results = [];
    for (const scope of scopes) results.push(await this.observe(scope, now));
    return results;
  }

  async claim(scope: PreviewConvergenceScope, now = new Date()): Promise<PreviewConvergenceClaim> {
    return this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`facility:story:${scope.orgId}:${scope.projectId}:${scope.storyId}`}))`,
      );
      const [controller] = await tx
        .select()
        .from(storyPreviewConvergences)
        .where(convergenceWhere(scope))
        .for("update")
        .limit(1);
      if (!controller) return { claimed: false, reason: "unconfigured" };
      if (controller.state === "suspended") return { claimed: false, reason: "suspended" };
      if (controller.state === "blocked") return { claimed: false, reason: "blocked" };
      if (
        (controller.state === "failed" || controller.state === "waiting") &&
        controller.retryAt &&
        controller.retryAt > now
      )
        return { claimed: false, reason: "backoff", retryAt: controller.retryAt };
      if (
        controller.state === "ready" &&
        controller.deployedGeneration === controller.desiredGeneration
      )
        return { claimed: false, reason: "current" };
      if (
        controller.state === "applying" &&
        controller.leaseExpiresAt &&
        controller.leaseExpiresAt > now
      )
        return {
          claimed: false,
          reason: "leased",
          retryAt: controller.leaseExpiresAt,
        };
      if (controller.state === "applying" && controller.leaseToken) {
        await tx
          .update(storyPreviewAttempts)
          .set({
            state: "failed",
            cause: { code: "preview_lease_expired" },
            endedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(storyPreviewAttempts.storyId, scope.storyId),
              eq(storyPreviewAttempts.leaseToken, controller.leaseToken),
              eq(storyPreviewAttempts.state, "applying"),
            ),
          );
      }
      const [writer] = await tx
        .select({ id: turns.id })
        .from(turns)
        .where(
          and(
            eq(turns.orgId, scope.orgId),
            eq(turns.projectId, scope.projectId),
            eq(turns.storyId, scope.storyId),
            inArray(turns.state, ["queued", "running"]),
          ),
        )
        .limit(1);
      if (writer) {
        const retryAt = new Date(now.getTime() + WRITER_RETRY_MS);
        await tx
          .update(storyPreviewConvergences)
          .set({
            state: "waiting",
            leaseToken: null,
            leaseGeneration: null,
            leaseExpiresAt: null,
            errorCode: "preview_writer_active",
            errorMessage: "Preview convergence is waiting for the active story writer.",
            retryAt,
            revision: controller.revision + 1,
            updatedAt: now,
          })
          .where(convergenceWhere(scope));
        return { claimed: false, reason: "writer_active", retryAt };
      }
      const [latest] = await tx
        .select({ attempt: storyPreviewAttempts.attempt })
        .from(storyPreviewAttempts)
        .where(eq(storyPreviewAttempts.storyId, scope.storyId))
        .orderBy(desc(storyPreviewAttempts.attempt))
        .limit(1);
      const [generation] = await tx
        .select()
        .from(storyPreviewGenerations)
        .where(
          and(
            eq(storyPreviewGenerations.storyId, scope.storyId),
            eq(storyPreviewGenerations.generation, controller.desiredGeneration),
          ),
        )
        .limit(1);
      if (!generation) throw new Error("preview_generation_missing");
      const attempt = (latest?.attempt ?? 0) + 1;
      const attemptId = randomUUID();
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + this.leaseMs);
      await tx.insert(storyPreviewAttempts).values({
        id: attemptId,
        ...scope,
        generation: generation.generation,
        attempt,
        leaseToken,
        state: "applying",
        cause: {},
        startedAt: now,
      });
      await tx
        .update(storyPreviewConvergences)
        .set({
          state: "applying",
          leaseToken,
          leaseGeneration: generation.generation,
          leaseExpiresAt,
          errorCode: null,
          errorMessage: null,
          retryAt: null,
          revision: controller.revision + 1,
          updatedAt: now,
        })
        .where(convergenceWhere(scope));
      return {
        claimed: true,
        attemptId,
        attempt,
        leaseToken,
        leaseExpiresAt,
        generation: generation.generation,
        repositories: generation.repositories,
      };
    });
  }

  async complete(
    scope: PreviewConvergenceScope,
    input: {
      generation: string;
      leaseToken: string;
      workspaceId?: string;
      setupChecksum?: string;
      endpoints?: PreviewEndpoint[];
    },
    now = new Date(),
  ) {
    const result = await this.settle(scope, input, "succeeded", {}, now);
    if (result.enqueue) await this.enqueue(QUEUE, scope);
    return result;
  }

  async fail(
    scope: PreviewConvergenceScope,
    input: {
      generation: string;
      leaseToken: string;
      workspaceId?: string;
      outcome: AttemptOutcome;
      code: string;
      message: string;
      retryAt?: Date;
      details?: Record<string, unknown>;
    },
    now = new Date(),
  ) {
    const cause = boundedCause({ code: input.code, ...(input.details ?? {}) });
    return this.settle(scope, input, input.outcome, cause, now);
  }

  async recover(now = new Date(), limit = 1_000) {
    const due = await this.db
      .select({
        orgId: storyPreviewConvergences.orgId,
        projectId: storyPreviewConvergences.projectId,
        storyId: storyPreviewConvergences.storyId,
      })
      .from(storyPreviewConvergences)
      .where(
        or(
          eq(storyPreviewConvergences.state, "pending"),
          and(
            eq(storyPreviewConvergences.state, "waiting"),
            or(
              isNull(storyPreviewConvergences.retryAt),
              lte(storyPreviewConvergences.retryAt, now),
            ),
          ),
          and(
            eq(storyPreviewConvergences.state, "applying"),
            lte(storyPreviewConvergences.leaseExpiresAt, now),
          ),
          and(
            eq(storyPreviewConvergences.state, "failed"),
            or(
              isNull(storyPreviewConvergences.retryAt),
              lte(storyPreviewConvergences.retryAt, now),
            ),
          ),
        ),
      )
      .orderBy(asc(storyPreviewConvergences.updatedAt))
      .limit(limit);
    for (const scope of due) await this.enqueue(QUEUE, scope);
    return due.length;
  }

  async reconcileObserved(now = new Date(), limit = 1_000) {
    const scopes = await this.db
      .select({
        orgId: storyDeliveryScopes.orgId,
        projectId: storyDeliveryScopes.projectId,
        storyId: storyDeliveryScopes.storyId,
      })
      .from(storyDeliveryScopes)
      .orderBy(asc(storyDeliveryScopes.updatedAt))
      .limit(limit);
    let recorded = 0;
    for (const scope of scopes) {
      const result = await this.observe(scope, now);
      if (result.recorded) recorded += 1;
    }
    return recorded;
  }

  async reconcileLifecycle(now = new Date(), limit = 1_000) {
    const controllers = await this.db
      .select({
        orgId: storyPreviewConvergences.orgId,
        projectId: storyPreviewConvergences.projectId,
        storyId: storyPreviewConvergences.storyId,
        state: storyPreviewConvergences.state,
      })
      .from(storyPreviewConvergences)
      .orderBy(asc(storyPreviewConvergences.updatedAt))
      .limit(limit);
    let suspended = 0;
    let resumed = 0;
    for (const controller of controllers) {
      const [story] = await this.db
        .select({ status: stories.status, deletedAt: stories.deletedAt })
        .from(stories)
        .where(
          and(
            eq(stories.orgId, controller.orgId),
            eq(stories.projectId, controller.projectId),
            eq(stories.id, controller.storyId),
          ),
        )
        .limit(1);
      const [workspace] = await this.db
        .select({ state: workspaces.state })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.orgId, controller.orgId),
            eq(workspaces.projectId, controller.projectId),
            eq(workspaces.storyId, controller.storyId),
          ),
        )
        .orderBy(desc(workspaces.createdAt))
        .limit(1);
      const shouldSuspend =
        !!story &&
        (story.deletedAt !== null ||
          story.status === "archived" ||
          workspace?.state === "sleeping");
      if (shouldSuspend && controller.state !== "suspended") {
        if (await this.suspend(controller, undefined, now)) suspended += 1;
      } else if (
        !shouldSuspend &&
        controller.state === "suspended" &&
        workspace?.state === "running"
      ) {
        if (await this.resume(controller, now)) resumed += 1;
      }
    }
    return { suspended, resumed };
  }

  async retry(scope: PreviewConvergenceScope, now = new Date()) {
    const [saved] = await this.db
      .update(storyPreviewConvergences)
      .set({
        state: "pending",
        leaseToken: null,
        leaseGeneration: null,
        leaseExpiresAt: null,
        errorCode: null,
        errorMessage: null,
        retryAt: null,
        revision: sql`${storyPreviewConvergences.revision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          convergenceWhere(scope),
          inArray(storyPreviewConvergences.state, ["waiting", "failed", "blocked"]),
        ),
      )
      .returning({ storyId: storyPreviewConvergences.storyId });
    if (saved) await this.enqueue(QUEUE, scope);
    return Boolean(saved);
  }

  async renew(
    scope: PreviewConvergenceScope,
    input: { generation: string; leaseToken: string },
    now = new Date(),
  ) {
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs);
    const [saved] = await this.db
      .update(storyPreviewConvergences)
      .set({ leaseExpiresAt, updatedAt: now })
      .where(
        and(
          convergenceWhere(scope),
          eq(storyPreviewConvergences.state, "applying"),
          eq(storyPreviewConvergences.leaseToken, input.leaseToken),
          eq(storyPreviewConvergences.leaseGeneration, input.generation),
          gt(storyPreviewConvergences.leaseExpiresAt, now),
        ),
      )
      .returning({ storyId: storyPreviewConvergences.storyId });
    return saved ? leaseExpiresAt : null;
  }

  async suspend(
    scope: PreviewConvergenceScope,
    input?: { generation: string; leaseToken: string; reason?: string },
    now = new Date(),
  ) {
    return this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`facility:preview-convergence:${scope.orgId}:${scope.projectId}:${scope.storyId}`}))`,
      );
      const [controller] = await tx
        .select()
        .from(storyPreviewConvergences)
        .where(convergenceWhere(scope))
        .for("update")
        .limit(1);
      if (!controller) return false;
      if (input && controller.state === "applying") {
        if (
          controller.leaseToken !== input.leaseToken ||
          controller.leaseGeneration !== input.generation
        )
          return false;
      }
      if (controller.state === "applying" && controller.leaseToken) {
        await tx
          .update(storyPreviewAttempts)
          .set({
            state: "blocked",
            cause: { code: "preview_suspended", reason: input?.reason ?? "workspace_suspended" },
            endedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(storyPreviewAttempts.storyId, scope.storyId),
              eq(storyPreviewAttempts.leaseToken, controller.leaseToken),
              eq(storyPreviewAttempts.state, "applying"),
            ),
          );
      }
      if (controller.state === "suspended") return true;
      await tx
        .update(storyPreviewConvergences)
        .set({
          state: "suspended",
          leaseToken: null,
          leaseGeneration: null,
          leaseExpiresAt: null,
          errorCode: "preview_suspended",
          errorMessage: "Preview convergence is suspended with the story workspace.",
          retryAt: null,
          revision: controller.revision + 1,
          updatedAt: now,
        })
        .where(convergenceWhere(scope));
      return true;
    });
  }

  async resume(scope: PreviewConvergenceScope, now = new Date()) {
    const [controller] = await this.db
      .select()
      .from(storyPreviewConvergences)
      .where(convergenceWhere(scope))
      .limit(1);
    if (controller?.state !== "suspended") return false;
    const state =
      controller.deployedGeneration === controller.desiredGeneration ? "ready" : "pending";
    const [saved] = await this.db
      .update(storyPreviewConvergences)
      .set({
        state,
        errorCode: null,
        errorMessage: null,
        revision: controller.revision + 1,
        updatedAt: now,
      })
      .where(
        and(convergenceWhere(scope), eq(storyPreviewConvergences.revision, controller.revision)),
      )
      .returning({ storyId: storyPreviewConvergences.storyId });
    if (saved && state === "pending") await this.enqueue(QUEUE, scope);
    return Boolean(saved);
  }

  async read(scope: PreviewConvergenceScope): Promise<StoryPreviewConvergence | null> {
    const [controller] = await this.db
      .select()
      .from(storyPreviewConvergences)
      .where(convergenceWhere(scope))
      .limit(1);
    if (!controller) {
      const [story] = await this.db
        .select({ id: stories.id })
        .from(stories)
        .where(
          and(
            eq(stories.orgId, scope.orgId),
            eq(stories.projectId, scope.projectId),
            eq(stories.id, scope.storyId),
          ),
        )
        .limit(1);
      if (!story) throw new ApiError(404, "not_found", "Story not found");
      return null;
    }
    const [generation] = await this.db
      .select()
      .from(storyPreviewGenerations)
      .where(
        and(
          eq(storyPreviewGenerations.storyId, scope.storyId),
          eq(storyPreviewGenerations.generation, controller.desiredGeneration),
        ),
      )
      .limit(1);
    if (!generation) throw new Error("preview_generation_missing");
    const [attempt] = await this.db
      .select()
      .from(storyPreviewAttempts)
      .where(eq(storyPreviewAttempts.storyId, scope.storyId))
      .orderBy(desc(storyPreviewAttempts.attempt))
      .limit(1);
    return {
      schemaVersion: 1,
      ...scope,
      revision: controller.revision,
      state: controller.state as StoryPreviewConvergenceState,
      desired: {
        generation: generation.generation,
        deliveryRevision: generation.deliveryRevision,
        repositories: generation.repositories,
        observedAt: generation.sourceObservedAt.toISOString(),
      },
      deployedGeneration: controller.deployedGeneration,
      lastGoodGeneration: controller.lastGoodGeneration,
      attempt: attempt
        ? {
            id: attempt.id,
            number: attempt.attempt,
            generation: attempt.generation,
            state: attempt.state as NonNullable<StoryPreviewConvergence["attempt"]>["state"],
            workspaceId: attempt.workspaceId,
            cause: attempt.cause,
            startedAt: attempt.startedAt.toISOString(),
            endedAt: attempt.endedAt?.toISOString() ?? null,
          }
        : null,
      error:
        controller.errorCode && controller.errorMessage
          ? {
              code: controller.errorCode,
              message: controller.errorMessage,
              retryAt: controller.retryAt?.toISOString() ?? null,
            }
          : null,
      updatedAt: controller.updatedAt.toISOString(),
    };
  }

  private async settle(
    scope: PreviewConvergenceScope,
    input: {
      generation: string;
      leaseToken: string;
      workspaceId?: string;
      setupChecksum?: string;
      endpoints?: PreviewEndpoint[];
      code?: string;
      message?: string;
      retryAt?: Date;
    },
    outcome: "succeeded" | AttemptOutcome,
    cause: Record<string, unknown>,
    now: Date,
  ) {
    return this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`facility:preview-convergence:${scope.orgId}:${scope.projectId}:${scope.storyId}`}))`,
      );
      const [controller] = await tx
        .select()
        .from(storyPreviewConvergences)
        .where(convergenceWhere(scope))
        .for("update")
        .limit(1);
      const owned =
        controller?.state === "applying" &&
        controller.leaseToken === input.leaseToken &&
        controller.leaseGeneration === input.generation;
      if (!controller || !owned) return { settled: false as const, enqueue: false };
      const superseded = controller.desiredGeneration !== input.generation;
      const attemptState = superseded ? "superseded" : outcome;
      await tx
        .update(storyPreviewAttempts)
        .set({
          state: attemptState,
          workspaceId: input.workspaceId ?? null,
          cause: superseded ? { code: "preview_generation_superseded" } : cause,
          endedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(storyPreviewAttempts.storyId, scope.storyId),
            eq(storyPreviewAttempts.leaseToken, input.leaseToken),
            eq(storyPreviewAttempts.state, "applying"),
          ),
        );
      const state: StoryPreviewConvergenceState = superseded
        ? "pending"
        : outcome === "succeeded"
          ? "ready"
          : outcome;
      if (
        outcome === "succeeded" &&
        !superseded &&
        input.workspaceId &&
        input.setupChecksum &&
        input.endpoints
      ) {
        const [published] = await tx
          .update(workspaces)
          .set({
            endpoints: input.endpoints,
            state: "running",
            error: null,
            setupChecksum: input.setupChecksum,
            lastActivityAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(workspaces.orgId, scope.orgId),
              eq(workspaces.projectId, scope.projectId),
              eq(workspaces.storyId, scope.storyId),
              eq(workspaces.id, input.workspaceId),
            ),
          )
          .returning({ id: workspaces.id });
        if (!published) throw new Error("preview_workspace_missing");
      }
      await tx
        .update(storyPreviewConvergences)
        .set({
          state,
          ...(outcome === "succeeded" && !superseded
            ? {
                deployedGeneration: input.generation,
                lastGoodGeneration: input.generation,
              }
            : {}),
          leaseToken: null,
          leaseGeneration: null,
          leaseExpiresAt: null,
          errorCode: superseded || outcome === "succeeded" ? null : input.code,
          errorMessage: superseded || outcome === "succeeded" ? null : input.message,
          retryAt: superseded || outcome === "succeeded" ? null : (input.retryAt ?? null),
          revision: controller.revision + 1,
          updatedAt: now,
        })
        .where(convergenceWhere(scope));
      return { settled: true as const, superseded, enqueue: superseded };
    });
  }
}

function convergenceWhere(scope: PreviewConvergenceScope) {
  return and(
    eq(storyPreviewConvergences.orgId, scope.orgId),
    eq(storyPreviewConvergences.projectId, scope.projectId),
    eq(storyPreviewConvergences.storyId, scope.storyId),
  );
}

function latestSourceObservation(
  delivery: Awaited<ReturnType<typeof readStoryDelivery>>,
  fallback: Date,
) {
  const times = [delivery.scope.updatedAt, ...delivery.pullRequests.map((pull) => pull.observedAt)]
    .filter((value): value is string => value !== null)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)) : fallback;
}

function boundedCause(cause: Record<string, unknown>) {
  const serialized = JSON.stringify(cause);
  if (Buffer.byteLength(serialized, "utf8") <= 16_384) return cause;
  return { code: String(cause.code ?? "preview_convergence_failed"), truncated: true };
}
