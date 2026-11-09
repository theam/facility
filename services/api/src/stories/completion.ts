import { createHash, randomUUID } from "node:crypto";
import {
  type DeliveryIntegrationPolicy,
  DeliveryIntegrationPolicySchema,
  type DeliveryNoticePolicy,
  DeliveryNoticePolicySchema,
  type RecordDeliveryIntegration,
  type RequestStoryCompletion,
  type StoryCompletion,
} from "@facility/core";
import {
  attentionItems,
  type FacilityDb,
  githubInstallations,
  githubIssues,
  githubPullRequests,
  projectRepositories,
  projects,
  stories,
  storyCompletionOperations,
  storyDeliveryIntegrations,
  storyDeliveryPullRequests,
  storyDeliveryScopes,
  storyMessages,
  turns,
  workspaces,
} from "@facility/db";
import { and, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { authorizePrincipal } from "../auth/workspace-execution.js";
import { ApiError } from "../errors.js";
import type { GithubClientFactory } from "../github/client.js";
import { githubRateLimitRetryAt } from "../github/rate-limit.js";
import { reconciliationPage } from "../reconciliation.js";
import { readStoryDelivery } from "./delivery.js";
import { assertDeliveryAccepted } from "./delivery-acceptance.js";
import type { StoryWorkspaceService } from "./service.js";

type Scope = { orgId: string; projectId: string; storyId: string };
type Actor = { type: "user" | "service"; id: string };
type Enqueue = (queue: string, data: Record<string, unknown>) => Promise<unknown>;
const LEASE_MS = 120_000;

export class StoryCompletionService {
  constructor(
    private readonly db: FacilityDb,
    private readonly github: GithubClientFactory,
    private readonly storiesService: StoryWorkspaceService,
    private readonly enqueue: Enqueue,
    private readonly mutationLocked = false,
  ) {}

  private async mutate<T>(scope: Scope, action: (service: StoryCompletionService) => Promise<T>) {
    const jobs: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const result = await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '20s'`);
      // Same order as delivery replacement and policy/repository mutations.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${scope.orgId}:${scope.projectId}`}))`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`facility:story:${scope.orgId}:${scope.projectId}:${scope.storyId}`}))`,
      );
      const service = new StoryCompletionService(
        tx,
        this.github,
        this.storiesService,
        async (queue, data) => {
          jobs.push({ queue, data });
        },
        true,
      );
      return action(service);
    });
    for (const job of jobs) await this.enqueue(job.queue, job.data);
    return result;
  }

  async read(scope: Scope, now = new Date()): Promise<StoryCompletion> {
    const delivery = await readStoryDelivery(this.db, scope, { now });
    const [story] = await this.db
      .select({
        provider: stories.provider,
        externalId: stories.externalId,
        repositoryId: stories.repositoryId,
        status: stories.status,
        archivedAt: stories.archivedAt,
        deletedAt: stories.deletedAt,
      })
      .from(stories)
      .where(storyWhere(scope))
      .limit(1);
    if (!story) throw new ApiError(404, "not_found", "Story not found");
    const [project, integration, completion, workspace] = await Promise.all([
      this.db
        .select({ settings: projects.settings })
        .from(projects)
        .where(and(eq(projects.orgId, scope.orgId), eq(projects.id, scope.projectId)))
        .limit(1)
        .then((rows) => rows[0]),
      this.db
        .select({ row: storyDeliveryIntegrations, repository: projectRepositories })
        .from(storyDeliveryIntegrations)
        .leftJoin(
          projectRepositories,
          and(
            eq(projectRepositories.orgId, storyDeliveryIntegrations.orgId),
            eq(projectRepositories.projectId, storyDeliveryIntegrations.projectId),
            eq(projectRepositories.id, storyDeliveryIntegrations.repositoryId),
          ),
        )
        .where(integrationWhere(scope))
        .limit(1)
        .then((rows) => rows[0]),
      this.db
        .select()
        .from(storyCompletionOperations)
        .where(completionWhere(scope))
        .limit(1)
        .then((rows) => rows[0]),
      this.db
        .select({ state: workspaces.state, volumeRef: workspaces.volumeRef })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.orgId, scope.orgId),
            eq(workspaces.projectId, scope.projectId),
            eq(workspaces.storyId, scope.storyId),
          ),
        )
        .orderBy(desc(workspaces.createdAt))
        .limit(1)
        .then((rows) => rows[0]),
    ]);
    if (!project) throw new ApiError(404, "not_found", "Project not found");
    const policy = policyFromSettings(project.settings);
    const source = await this.source(scope, story);
    const candidateRevision = delivery.candidate.revision;
    const integrationState =
      policy.mode === "none"
        ? "not_required"
        : integration?.row.candidateRevision !== candidateRevision
          ? integration
            ? "stale"
            : "pending"
          : integration.row.state;
    const completionState =
      completion?.candidateRevision !== candidateRevision
        ? completion
          ? "stale"
          : "not_requested"
        : completion.state;
    const integrationProjection: StoryCompletion["integration"] = {
      policy,
      candidateRevision: integration?.row.candidateRevision ?? null,
      state: integrationState,
      attempt: integration?.row.attempt ?? 0,
      eventId: integration?.row.eventId ?? null,
      repository: integration?.repository
        ? `${integration.repository.owner}/${integration.repository.name}`
        : null,
      summary: integration?.row.summary ?? null,
      evidenceUrl: integration?.row.evidenceUrl ?? null,
      errorCode: integration?.row.errorCode ?? null,
      recordedBy: integration?.row.recordedBy ?? null,
      recordedAt: integration?.row.recordedAt?.toISOString() ?? null,
    };
    const completionProjection: StoryCompletion["completion"] = {
      candidateRevision: completion?.candidateRevision ?? null,
      state: completionState,
      attempt: completion?.attempt ?? 0,
      errorCode: completion?.errorCode ?? null,
      requestedBy: completion?.requestedBy ?? null,
      requestedAt: completion?.requestedAt.toISOString() ?? null,
      completedAt: completion?.completedAt?.toISOString() ?? null,
    };
    return {
      schemaVersion: 1,
      ...scope,
      generatedAt: now.toISOString(),
      candidate: delivery.candidate,
      integration: integrationProjection,
      source,
      completion: completionProjection,
      notices: noticePolicyFromSettings(project.settings),
      retention: {
        workspaceState: workspace?.state ?? null,
        computeSuspended: !workspace || ["sleeping", "destroyed"].includes(workspace.state),
        storageRetained: Boolean(workspace?.volumeRef) && workspace?.state !== "destroyed",
        archived: story.status === "archived" || story.archivedAt !== null,
        deleted: story.deletedAt !== null || workspace?.state === "destroyed",
      },
      nextAction: storyCompletionNextAction({
        candidate: delivery.candidate,
        integration: integrationProjection,
        source,
        completion: completionProjection,
      }),
    };
  }

  async setPolicy(scope: Omit<Scope, "storyId">, policy: DeliveryIntegrationPolicy) {
    const parsed = DeliveryIntegrationPolicySchema.parse(policy);
    const linked = await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${scope.orgId}:${scope.projectId}`}))`,
      );
      if (parsed.mode === "repository_dispatch")
        await this.repository(scope, parsed.repository, tx);
      const [project] = await tx
        .select({ settings: projects.settings })
        .from(projects)
        .where(and(eq(projects.orgId, scope.orgId), eq(projects.id, scope.projectId)))
        .for("update")
        .limit(1);
      if (!project) throw new ApiError(404, "not_found", "Project not found");
      const changed = !samePolicy(policyFromSettings(project.settings), parsed);
      await tx
        .update(projects)
        .set({
          settings: sql`${projects.settings} || ${JSON.stringify({ deliveryIntegration: parsed })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(and(eq(projects.orgId, scope.orgId), eq(projects.id, scope.projectId)));
      if (changed)
        await tx
          .delete(storyDeliveryIntegrations)
          .where(
            and(
              eq(storyDeliveryIntegrations.orgId, scope.orgId),
              eq(storyDeliveryIntegrations.projectId, scope.projectId),
            ),
          );
      return tx
        .select({ storyId: stories.id })
        .from(stories)
        .where(and(eq(stories.orgId, scope.orgId), eq(stories.projectId, scope.projectId)));
    });
    for (const story of linked) await this.reconcile({ ...scope, storyId: story.storyId });
    return parsed;
  }

  async getPolicy(scope: Omit<Scope, "storyId">) {
    const [project] = await this.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(and(eq(projects.orgId, scope.orgId), eq(projects.id, scope.projectId)))
      .limit(1);
    if (!project) throw new ApiError(404, "not_found", "Project not found");
    return policyFromSettings(project.settings);
  }

  async setNoticePolicy(scope: Omit<Scope, "storyId">, policy: DeliveryNoticePolicy) {
    const parsed = DeliveryNoticePolicySchema.parse(policy);
    const [updated] = await this.db
      .update(projects)
      .set({
        settings: sql`${projects.settings} || ${JSON.stringify({ deliveryNotices: parsed })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(projects.orgId, scope.orgId), eq(projects.id, scope.projectId)))
      .returning({ id: projects.id });
    if (!updated) throw new ApiError(404, "not_found", "Project not found");
    const linked = await this.db
      .select({ storyId: stories.id })
      .from(stories)
      .where(and(eq(stories.orgId, scope.orgId), eq(stories.projectId, scope.projectId)));
    for (const story of linked) {
      const storyScope = { ...scope, storyId: story.storyId };
      await this.reconcileNotices(storyScope, await this.read(storyScope));
    }
    return parsed;
  }

  async getNoticePolicy(scope: Omit<Scope, "storyId">) {
    const [project] = await this.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(and(eq(projects.orgId, scope.orgId), eq(projects.id, scope.projectId)))
      .limit(1);
    if (!project) throw new ApiError(404, "not_found", "Project not found");
    return noticePolicyFromSettings(project.settings);
  }

  async reconcile(scope: Scope, now = new Date()): Promise<StoryCompletion> {
    if (!this.mutationLocked) return this.mutate(scope, (service) => service.reconcile(scope, now));
    const delivery = await readStoryDelivery(this.db, scope, { now });
    const policy = await this.policy(scope);
    if (
      policy.mode === "none" ||
      delivery.candidate.state !== "recorded" ||
      delivery.candidate.allRequiredMerged !== true ||
      !delivery.candidate.revision
    ) {
      const projection = await this.read(scope, now);
      await this.reconcileNotices(scope, projection, now);
      return projection;
    }
    const repository =
      policy.mode === "repository_dispatch"
        ? await this.repository(scope, policy.repository)
        : null;
    const candidateRevision = delivery.candidate.revision;
    const [existing] = await this.db
      .select()
      .from(storyDeliveryIntegrations)
      .where(integrationWhere(scope))
      .limit(1);
    if (
      !existing ||
      existing.candidateRevision !== candidateRevision ||
      existing.mode !== policy.mode ||
      existing.repositoryId !== (repository?.id ?? null) ||
      (existing.mode === "manual" &&
        (existing.errorCode !== null || ["dispatching", "dispatched"].includes(existing.state)))
    ) {
      await this.db
        .insert(storyDeliveryIntegrations)
        .values({
          ...scope,
          candidateRevision,
          mode: policy.mode,
          repositoryId: repository?.id ?? null,
          state: "pending",
          eventId: policy.mode === "repository_dispatch" ? randomUUID() : null,
          nextAttemptAt: now,
        })
        .onConflictDoUpdate({
          target: storyDeliveryIntegrations.storyId,
          set: {
            candidateRevision,
            mode: policy.mode,
            repositoryId: repository?.id ?? null,
            state: "pending",
            attempt: 0,
            eventId: policy.mode === "repository_dispatch" ? randomUUID() : null,
            leaseToken: null,
            leaseUntil: null,
            nextAttemptAt: now,
            errorCode: null,
            summary: null,
            evidenceUrl: null,
            recordedBy: null,
            recordedAt: null,
            updatedAt: now,
          },
        });
    }
    if (policy.mode === "repository_dispatch") {
      const [row] = await this.db
        .select()
        .from(storyDeliveryIntegrations)
        .where(integrationWhere(scope))
        .limit(1);
      if (row && (row.state === "pending" || (row.state === "failed" && row.errorCode)))
        await this.enqueue("stories.delivery-integration", scope);
    }
    const projection = await this.read(scope, now);
    await this.reconcileNotices(scope, projection, now);
    return projection;
  }

  async observePull(repositoryId: string, pullNumber: number) {
    const linked = await this.db
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
        ),
      );
    for (const scope of linked) await this.reconcile(scope);
  }

  async recordIntegration(
    scope: Scope,
    body: RecordDeliveryIntegration,
    actor: Actor,
  ): Promise<StoryCompletion> {
    if (!this.mutationLocked)
      return this.mutate(scope, (service) => service.recordIntegration(scope, body, actor));
    const current = await this.reconcile(scope);
    assertCandidate(current, body.candidate_revision);
    if (current.integration.policy.mode === "none")
      throw new ApiError(
        409,
        "integration_not_required",
        "This project does not require post-merge integration",
      );
    const now = new Date();
    const [existing] = await this.db
      .select()
      .from(storyDeliveryIntegrations)
      .where(integrationWhere(scope))
      .for("update")
      .limit(1);
    if (!existing || existing.candidateRevision !== body.candidate_revision)
      throw new ApiError(
        409,
        "integration_candidate_stale",
        "Reload the current delivery candidate",
      );
    if (
      (existing.mode === "repository_dispatch" &&
        (!body.event_id || existing.eventId !== body.event_id)) ||
      (existing.mode === "manual" && body.event_id !== null)
    )
      throw new ApiError(
        409,
        "integration_event_stale",
        "The result must identify the current dispatched event",
      );
    if (
      current.integration.policy.mode === "repository_dispatch" &&
      existing.state !== "dispatched" &&
      !(existing.errorCode === null && ["succeeded", "failed"].includes(existing.state))
    )
      throw new ApiError(
        409,
        "integration_not_dispatched",
        "Facility must dispatch this candidate before its result can be recorded",
      );
    if (
      ["succeeded", "failed"].includes(existing.state) &&
      existing.errorCode === null &&
      (existing.state !== body.state ||
        existing.summary !== body.summary ||
        existing.evidenceUrl !== body.evidence_url)
    )
      throw new ApiError(
        409,
        "integration_result_already_recorded",
        "A terminal result is already recorded for this candidate",
      );
    if (["succeeded", "failed"].includes(existing.state) && existing.errorCode === null)
      return this.read(scope, now);
    await this.db
      .update(storyDeliveryIntegrations)
      .set({
        state: body.state,
        summary: body.summary,
        evidenceUrl: body.evidence_url,
        recordedBy: actor,
        recordedAt: now,
        errorCode: null,
        leaseToken: null,
        leaseUntil: null,
        updatedAt: now,
      })
      .where(
        and(
          integrationWhere(scope),
          eq(storyDeliveryIntegrations.candidateRevision, body.candidate_revision),
        ),
      );
    const projection = await this.read(scope, now);
    await this.reconcileNotices(scope, projection, now);
    return projection;
  }

  async requestCompletion(
    scope: Scope,
    body: RequestStoryCompletion,
    actor: Actor,
  ): Promise<StoryCompletion> {
    if (!this.mutationLocked)
      return this.mutate(scope, (service) => service.requestCompletion(scope, body, actor));
    const current = await this.reconcile(scope);
    assertCandidate(current, body.candidate_revision);
    await this.assertCompletionGate(scope, current);
    const now = new Date();
    const [existing] = await this.db
      .select()
      .from(storyCompletionOperations)
      .where(completionWhere(scope))
      .limit(1);
    if (
      existing?.candidateRevision === body.candidate_revision &&
      (["pending", "closing"].includes(existing.state) ||
        (existing.state === "completed" &&
          current.source.state === "closed" &&
          current.retention.computeSuspended))
    )
      return this.read(scope, now);
    await this.db
      .insert(storyCompletionOperations)
      .values({
        ...scope,
        candidateRevision: body.candidate_revision,
        state: "pending",
        requestedBy: actor,
        requestedAt: now,
        nextAttemptAt: now,
      })
      .onConflictDoUpdate({
        target: storyCompletionOperations.storyId,
        set: {
          candidateRevision: body.candidate_revision,
          state: "pending",
          attempt: 0,
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: now,
          errorCode: null,
          requestedBy: actor,
          requestedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
    await this.enqueue("stories.complete", scope);
    const projection = await this.read(scope, now);
    await this.reconcileNotices(scope, projection, now);
    return projection;
  }

  async dispatchIntegration(scope: Scope, now = new Date()) {
    const token = randomUUID();
    const [claimed] = await this.db
      .update(storyDeliveryIntegrations)
      .set({
        state: "dispatching",
        attempt: sql`${storyDeliveryIntegrations.attempt} + 1`,
        leaseToken: token,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        errorCode: null,
        updatedAt: now,
      })
      .where(
        and(
          integrationWhere(scope),
          eq(storyDeliveryIntegrations.mode, "repository_dispatch"),
          or(
            eq(storyDeliveryIntegrations.state, "pending"),
            and(
              eq(storyDeliveryIntegrations.state, "failed"),
              isNotNull(storyDeliveryIntegrations.errorCode),
            ),
          ),
          lte(storyDeliveryIntegrations.nextAttemptAt, now),
          or(
            isNull(storyDeliveryIntegrations.leaseUntil),
            lte(storyDeliveryIntegrations.leaseUntil, now),
          ),
        ),
      )
      .returning();
    if (!claimed) return { claimed: false };
    const owned = and(integrationWhere(scope), eq(storyDeliveryIntegrations.leaseToken, token));
    try {
      const current = await this.read(scope, now);
      assertCandidate(current, claimed.candidateRevision);
      if (current.integration.policy.mode !== "repository_dispatch")
        throw new Error("integration_policy_changed");
      const configured = await this.repository(scope, current.integration.policy.repository);
      if (configured.id !== claimed.repositoryId) throw new Error("integration_policy_changed");
      const target = await this.repositoryById(scope, claimed.repositoryId);
      if (!target.installationId) throw new Error("github_destination_unavailable");
      const client = await this.github(target.installationId);
      const githubRequest = client.request;
      if (!githubRequest) throw new Error("github_requests_unavailable");
      await this.mutate(scope, async (service) => {
        const fresh = await service.read(scope);
        assertCandidate(fresh, claimed.candidateRevision);
        if (
          fresh.integration.policy.mode !== "repository_dispatch" ||
          fresh.integration.eventId !== claimed.eventId ||
          fresh.integration.repository !== `${target.owner}/${target.name}`
        )
          throw new Error("integration_policy_changed");
        const [live] = await service.db
          .select()
          .from(storyDeliveryIntegrations)
          .where(and(owned, eq(storyDeliveryIntegrations.eventId, claimed.eventId ?? "")))
          .for("update")
          .limit(1);
        if (!live?.leaseUntil || live.leaseUntil <= new Date())
          throw new Error("integration_lease_lost");
        await githubRequest("POST /repos/{owner}/{repo}/dispatches", {
          owner: target.owner,
          repo: target.name,
          event_type: "facility.delivery.merged",
          client_payload: {
            schemaVersion: 1,
            orgId: scope.orgId,
            projectId: scope.projectId,
            storyId: scope.storyId,
            candidateRevision: claimed.candidateRevision,
            eventId: claimed.eventId,
          },
          request: { timeout: 10_000, retries: 0, signal: AbortSignal.timeout(10_000) },
        });
        const [saved] = await service.db
          .update(storyDeliveryIntegrations)
          .set({ state: "dispatched", leaseToken: null, leaseUntil: null, updatedAt: new Date() })
          .where(owned)
          .returning({ storyId: storyDeliveryIntegrations.storyId });
        if (!saved) throw new Error("integration_lease_lost");
      });
      await this.reconcileNotices(scope, await this.read(scope));
      return { claimed: true, state: "dispatched" as const };
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      const code =
        typeof status === "number"
          ? `github_http_${status}`
          : error instanceof ApiError
            ? error.code
            : error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
              ? error.message
              : "integration_dispatch_failed";
      const delay = Math.min(3_600_000, 60_000 * 2 ** Math.min(claimed.attempt, 6));
      await this.db
        .update(storyDeliveryIntegrations)
        .set({
          state: "failed",
          errorCode: code,
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt:
            githubRateLimitRetryAt(error, now.getTime()) ?? new Date(now.getTime() + delay),
          updatedAt: new Date(),
        })
        .where(owned);
      await this.reconcileNotices(scope, await this.read(scope));
      return { claimed: true, state: "failed" as const, errorCode: code };
    }
  }

  async dispatchCompletion(scope: Scope, now = new Date()) {
    const token = randomUUID();
    const [claimed] = await this.db
      .update(storyCompletionOperations)
      .set({
        state: "closing",
        attempt: sql`${storyCompletionOperations.attempt} + 1`,
        leaseToken: token,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        errorCode: null,
        updatedAt: now,
      })
      .where(
        and(
          completionWhere(scope),
          inArray(storyCompletionOperations.state, ["pending", "failed"]),
          or(
            isNull(storyCompletionOperations.errorCode),
            ne(storyCompletionOperations.errorCode, "completion_source_changed"),
          ),
          lte(storyCompletionOperations.nextAttemptAt, now),
          or(
            isNull(storyCompletionOperations.leaseUntil),
            lte(storyCompletionOperations.leaseUntil, now),
          ),
        ),
      )
      .returning();
    if (!claimed) return { claimed: false };
    const owned = and(completionWhere(scope), eq(storyCompletionOperations.leaseToken, token));
    try {
      const initialSource = await this.sourceTarget(scope);
      const githubRequest =
        initialSource.issue.state === "closed"
          ? undefined
          : initialSource.repository.installationId
            ? (await this.github(initialSource.repository.installationId)).request
            : undefined;
      if (initialSource.issue.state !== "closed" && !githubRequest)
        throw new Error("github_destination_unavailable");
      await this.mutate(scope, async (service) => {
        const [operation] = await service.db
          .select()
          .from(storyCompletionOperations)
          .where(owned)
          .for("update")
          .limit(1);
        if (!operation?.leaseUntil || operation.leaseUntil <= new Date())
          throw new Error("completion_lease_lost");
        await authorizePrincipal(
          service.db,
          scope,
          {
            type: operation.requestedBy.type === "user" ? "user" : "key",
            id: operation.requestedBy.id,
          },
          ["projects:write", "github:write"],
          "completion_authorization_revoked",
        );
        // Freeze all local observations that can invalidate the authorized close.
        await service.db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.orgId, scope.orgId), eq(projects.id, scope.projectId)))
          .for("share");
        await service.db
          .select({ id: stories.id })
          .from(stories)
          .where(storyWhere(scope))
          .for("share");
        await service.db
          .select({ id: storyDeliveryScopes.storyId })
          .from(storyDeliveryScopes)
          .where(
            and(
              eq(storyDeliveryScopes.orgId, scope.orgId),
              eq(storyDeliveryScopes.projectId, scope.projectId),
              eq(storyDeliveryScopes.storyId, scope.storyId),
            ),
          )
          .for("share");
        await service.db
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
            ),
          )
          .for("share", { of: githubPullRequests });
        const current = await service.read(scope);
        assertCandidate(current, claimed.candidateRevision);
        await service.assertCompletionGate(scope, current);
        const source = await service.sourceTarget(scope);
        if (
          source.issue.id !== initialSource.issue.id ||
          source.repository.installationId !== initialSource.repository.installationId
        )
          throw new Error("source_issue_changed");
        if (source.issue.state !== "closed") {
          if (source.issue.githubUpdatedAt && source.issue.githubUpdatedAt > operation.requestedAt)
            throw new Error("completion_source_changed");
          if (!githubRequest) throw new Error("github_requests_unavailable");
          const response = await githubRequest(
            "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
            {
              owner: source.repository.owner,
              repo: source.repository.name,
              issue_number: source.issue.number,
              state: "closed",
              state_reason: "completed",
              request: { timeout: 10_000, retries: 0, signal: AbortSignal.timeout(10_000) },
            },
          );
          const observation = completionCloseObservation(response.data, source.issue.number);
          const [saved] = await service.db
            .update(githubIssues)
            .set({
              state: "closed",
              closedAt: observation.closedAt,
              githubUpdatedAt: observation.updatedAt,
              syncedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(githubIssues.orgId, scope.orgId),
                eq(githubIssues.projectId, scope.projectId),
                eq(githubIssues.id, source.issue.id),
                sql`${githubIssues}.xmin::text = ${source.sourceVersion}`,
                or(
                  isNull(githubIssues.githubUpdatedAt),
                  lte(githubIssues.githubUpdatedAt, observation.updatedAt),
                ),
              ),
            )
            .returning({ id: githubIssues.id });
          if (!saved) {
            // The PATCH's own webhook may have committed the same close first.
            // Preserve that newer row; only conflicting/reopened state invalidates completion.
            const observed = await service.sourceTarget(scope);
            if (
              observed.issue.state !== "closed" ||
              !observed.issue.githubUpdatedAt ||
              observed.issue.githubUpdatedAt < observation.updatedAt
            )
              throw new Error("completion_source_changed");
          }
        }
      });
      await this.storiesService.reconcileIssue(scope.orgId, scope.projectId, scope.storyId);
      const finished = await this.read(scope);
      if (finished.source.state !== "closed" || !finished.retention.computeSuspended)
        throw new Error("completion_reconciliation_pending");
      const completedAt = new Date();
      const [saved] = await this.db
        .update(storyCompletionOperations)
        .set({
          state: "completed",
          leaseToken: null,
          leaseUntil: null,
          completedAt,
          errorCode: null,
          updatedAt: completedAt,
        })
        .where(owned)
        .returning({ storyId: storyCompletionOperations.storyId });
      if (!saved) throw new Error("completion_lease_lost");
      await this.reconcileNotices(scope, await this.read(scope));
      return { claimed: true, state: "completed" as const };
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      const code =
        typeof status === "number"
          ? `github_http_${status}`
          : error instanceof ApiError
            ? error.code
            : error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
              ? error.message
              : "completion_failed";
      const delay = Math.min(3_600_000, 60_000 * 2 ** Math.min(claimed.attempt, 6));
      await this.db
        .update(storyCompletionOperations)
        .set({
          state: "failed",
          errorCode: code,
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt:
            githubRateLimitRetryAt(error, now.getTime()) ?? new Date(now.getTime() + delay),
          updatedAt: new Date(),
        })
        .where(owned);
      await this.reconcileNotices(scope, await this.read(scope));
      return { claimed: true, state: "failed" as const, errorCode: code };
    }
  }

  async recover(now = new Date()) {
    await Promise.all([
      this.db
        .update(storyDeliveryIntegrations)
        .set({
          state: "failed",
          errorCode: "integration_lease_expired",
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(storyDeliveryIntegrations.mode, "repository_dispatch"),
            eq(storyDeliveryIntegrations.state, "dispatching"),
            lte(storyDeliveryIntegrations.leaseUntil, now),
          ),
        ),
      this.db
        .update(storyCompletionOperations)
        .set({
          state: "failed",
          errorCode: "completion_lease_expired",
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(storyCompletionOperations.state, "closing"),
            lte(storyCompletionOperations.leaseUntil, now),
          ),
        ),
    ]);
    const [integrations, completions] = await Promise.all([
      this.db
        .select({
          orgId: storyDeliveryIntegrations.orgId,
          projectId: storyDeliveryIntegrations.projectId,
          storyId: storyDeliveryIntegrations.storyId,
        })
        .from(storyDeliveryIntegrations)
        .where(
          and(
            eq(storyDeliveryIntegrations.mode, "repository_dispatch"),
            or(
              eq(storyDeliveryIntegrations.state, "pending"),
              and(
                eq(storyDeliveryIntegrations.state, "failed"),
                isNotNull(storyDeliveryIntegrations.errorCode),
              ),
            ),
            lte(storyDeliveryIntegrations.nextAttemptAt, now),
          ),
        ),
      this.db
        .select({
          orgId: storyCompletionOperations.orgId,
          projectId: storyCompletionOperations.projectId,
          storyId: storyCompletionOperations.storyId,
        })
        .from(storyCompletionOperations)
        .where(
          and(
            or(inArray(storyCompletionOperations.state, ["pending", "failed"])),
            or(
              isNull(storyCompletionOperations.errorCode),
              ne(storyCompletionOperations.errorCode, "completion_source_changed"),
            ),
            lte(storyCompletionOperations.nextAttemptAt, now),
          ),
        ),
    ]);
    const manual = await reconciliationPage(this.db, "manual-integration-notices", (tx, after) =>
      tx
        .select({
          id: storyDeliveryIntegrations.storyId,
          orgId: storyDeliveryIntegrations.orgId,
          projectId: storyDeliveryIntegrations.projectId,
          storyId: storyDeliveryIntegrations.storyId,
        })
        .from(storyDeliveryIntegrations)
        .where(
          and(
            eq(storyDeliveryIntegrations.mode, "manual"),
            after ? sql`${storyDeliveryIntegrations.storyId} > ${after}` : undefined,
          ),
        )
        .orderBy(storyDeliveryIntegrations.storyId)
        .limit(1000),
    );
    for (const { id: _id, ...scope } of manual) await this.reconcile(scope, now);
    for (const scope of integrations) {
      await this.reconcileNotices(scope, await this.read(scope), now);
      await this.enqueue("stories.delivery-integration", scope);
    }
    for (const scope of completions) {
      await this.reconcileNotices(scope, await this.read(scope), now);
      await this.enqueue("stories.complete", scope);
    }
    return { integrations: integrations.length, completions: completions.length };
  }

  private async reconcileNotices(scope: Scope, current: StoryCompletion, now = new Date()) {
    const kinds = ["delivery_integration", "delivery_completion"];
    const desired = current.notices.in_app ? storyDeliveryNotice(scope, current) : null;
    await this.db
      .update(attentionItems)
      .set({
        status: "resolved",
        resolution: current.notices.in_app ? "superseded" : "preference_disabled",
        resolvedBy: { type: "service", id: "facility" },
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(attentionItems.orgId, scope.orgId),
          eq(attentionItems.projectId, scope.projectId),
          eq(attentionItems.storyId, scope.storyId),
          inArray(attentionItems.kind, kinds),
          eq(attentionItems.status, "open"),
          desired ? sql`${attentionItems.id} <> ${desired.id}` : undefined,
        ),
      );
    if (!desired) return;
    await this.db
      .insert(attentionItems)
      .values({ ...scope, ...desired, turnId: null })
      .onConflictDoNothing({ target: attentionItems.id });
    await this.db
      .update(attentionItems)
      .set({
        status: "open",
        resolution: null,
        resolvedBy: null,
        resolvedAt: null,
        title: desired.title,
        detail: desired.detail,
        updatedAt: now,
      })
      .where(
        and(
          eq(attentionItems.id, desired.id),
          eq(attentionItems.orgId, scope.orgId),
          eq(attentionItems.projectId, scope.projectId),
          eq(attentionItems.storyId, scope.storyId),
          eq(attentionItems.status, "resolved"),
          inArray(attentionItems.resolution, ["superseded", "preference_disabled"]),
        ),
      );
  }

  private async policy(scope: Scope) {
    const [project] = await this.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(and(eq(projects.orgId, scope.orgId), eq(projects.id, scope.projectId)))
      .limit(1);
    if (!project) throw new ApiError(404, "not_found", "Project not found");
    return policyFromSettings(project.settings);
  }

  private async repository(
    scope: Omit<Scope, "storyId">,
    name: string | null,
    db: FacilityDb = this.db,
  ) {
    if (!name) throw new ApiError(400, "integration_repository_required", "Choose a repository");
    const [owner, repositoryName] = name.split("/");
    const [repository] = await db
      .select({
        id: projectRepositories.id,
        owner: projectRepositories.owner,
        name: projectRepositories.name,
        installationId: githubInstallations.installationId,
      })
      .from(projectRepositories)
      .leftJoin(
        githubInstallations,
        and(
          eq(githubInstallations.orgId, projectRepositories.orgId),
          eq(githubInstallations.id, projectRepositories.installationId),
          isNull(githubInstallations.suspendedAt),
        ),
      )
      .where(
        and(
          eq(projectRepositories.orgId, scope.orgId),
          eq(projectRepositories.projectId, scope.projectId),
          sql`lower(${projectRepositories.owner}) = lower(${owner})`,
          sql`lower(${projectRepositories.name}) = lower(${repositoryName})`,
        ),
      )
      .limit(1);
    if (!repository)
      throw new ApiError(
        404,
        "integration_repository_not_found",
        "The integration repository is not connected to this project",
      );
    if (repository.installationId === null)
      throw new ApiError(
        409,
        "integration_repository_unavailable",
        "The integration repository has no active GitHub installation",
      );
    return repository;
  }

  private async repositoryById(scope: Scope, repositoryId: string | null) {
    if (!repositoryId) throw new Error("github_destination_unavailable");
    const [repository] = await this.db
      .select({
        id: projectRepositories.id,
        owner: projectRepositories.owner,
        name: projectRepositories.name,
        installationId: githubInstallations.installationId,
      })
      .from(projectRepositories)
      .leftJoin(
        githubInstallations,
        and(
          eq(githubInstallations.orgId, projectRepositories.orgId),
          eq(githubInstallations.id, projectRepositories.installationId),
          isNull(githubInstallations.suspendedAt),
        ),
      )
      .where(
        and(
          eq(projectRepositories.orgId, scope.orgId),
          eq(projectRepositories.projectId, scope.projectId),
          eq(projectRepositories.id, repositoryId),
        ),
      )
      .limit(1);
    if (!repository) throw new Error("github_destination_unavailable");
    return repository;
  }

  private async source(
    scope: Scope,
    story: { provider: string; externalId: string; repositoryId: string | null },
  ): Promise<StoryCompletion["source"]> {
    const number = sourceIssueNumber(story);
    if (!number || !story.repositoryId) return { kind: "other", state: "unavailable", url: null };
    const [issue] = await this.db
      .select({ state: githubIssues.state, url: githubIssues.htmlUrl })
      .from(githubIssues)
      .where(
        and(
          eq(githubIssues.orgId, scope.orgId),
          eq(githubIssues.projectId, scope.projectId),
          eq(githubIssues.repositoryId, story.repositoryId),
          eq(githubIssues.number, number),
        ),
      )
      .limit(1);
    return {
      kind: "github_issue",
      state: issue ? (issue.state as "open" | "closed") : "unavailable",
      url: issue?.url ?? null,
    };
  }

  private async sourceTarget(scope: Scope) {
    const [story] = await this.db
      .select({
        provider: stories.provider,
        externalId: stories.externalId,
        repositoryId: stories.repositoryId,
      })
      .from(stories)
      .where(storyWhere(scope))
      .limit(1);
    if (!story) throw new Error("story_not_found");
    const number = sourceIssueNumber(story);
    if (!number || !story.repositoryId) throw new Error("source_issue_required");
    const [row] = await this.db
      .select({
        issue: githubIssues,
        sourceVersion: sql<string>`${githubIssues}.xmin::text`,
        repository: projectRepositories,
        installationId: githubInstallations.installationId,
      })
      .from(githubIssues)
      .innerJoin(
        projectRepositories,
        and(
          eq(projectRepositories.orgId, githubIssues.orgId),
          eq(projectRepositories.projectId, githubIssues.projectId),
          eq(projectRepositories.id, githubIssues.repositoryId),
        ),
      )
      .leftJoin(
        githubInstallations,
        and(
          eq(githubInstallations.orgId, projectRepositories.orgId),
          eq(githubInstallations.id, projectRepositories.installationId),
          isNull(githubInstallations.suspendedAt),
        ),
      )
      .where(
        and(
          eq(githubIssues.orgId, scope.orgId),
          eq(githubIssues.projectId, scope.projectId),
          eq(githubIssues.repositoryId, story.repositoryId),
          eq(githubIssues.number, number),
        ),
      )
      .limit(1);
    if (!row) throw new Error("source_issue_unavailable");
    return {
      issue: row.issue,
      sourceVersion: row.sourceVersion,
      repository: { ...row.repository, installationId: row.installationId },
    };
  }

  private async assertCompletionGate(scope: Scope, current: StoryCompletion) {
    await assertDeliveryAccepted(this.db, scope);
    if (current.candidate.state !== "recorded" || current.candidate.allRequiredMerged !== true)
      throw new ApiError(
        409,
        "delivery_not_merged",
        "Every required pull request must be observed as merged",
      );
    if (current.integration.state !== "not_required" && current.integration.state !== "succeeded")
      throw new ApiError(
        409,
        "integration_not_succeeded",
        "Complete the configured post-merge integration before closing the source issue",
      );
    if (current.source.kind !== "github_issue" || current.source.state === "unavailable")
      throw new ApiError(
        409,
        "source_issue_required",
        "Completion requires the exact mirrored source GitHub issue",
      );
    const [active, pending] = await Promise.all([
      this.db
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
        .limit(1),
      this.db
        .select({ id: storyMessages.id })
        .from(storyMessages)
        .where(
          and(
            eq(storyMessages.orgId, scope.orgId),
            eq(storyMessages.projectId, scope.projectId),
            eq(storyMessages.storyId, scope.storyId),
            isNull(storyMessages.turnId),
            isNotNull(storyMessages.requestedAgentName),
          ),
        )
        .limit(1),
    ]);
    if (active.length || pending.length)
      throw new ApiError(
        409,
        "story_work_in_progress",
        "Wait for queued or running story work before completion",
      );
  }
}

function policyFromSettings(settings: unknown): DeliveryIntegrationPolicy {
  const value =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).deliveryIntegration
      : undefined;
  const parsed = DeliveryIntegrationPolicySchema.safeParse(
    value ?? { mode: "none", repository: null },
  );
  if (!parsed.success)
    throw new ApiError(
      409,
      "integration_policy_invalid",
      "The stored delivery integration policy is invalid",
    );
  return parsed.data;
}

function samePolicy(left: DeliveryIntegrationPolicy, right: DeliveryIntegrationPolicy) {
  return (
    left.mode === right.mode &&
    (left.repository ?? "").toLowerCase() === (right.repository ?? "").toLowerCase()
  );
}

function noticePolicyFromSettings(settings: unknown): DeliveryNoticePolicy {
  const value =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).deliveryNotices
      : undefined;
  const parsed = DeliveryNoticePolicySchema.safeParse(value ?? { in_app: true });
  if (!parsed.success)
    throw new ApiError(
      409,
      "delivery_notice_policy_invalid",
      "The stored delivery notice policy is invalid",
    );
  return parsed.data;
}

export function storyDeliveryNotice(scope: Scope, current: StoryCompletion) {
  const candidate = current.candidate.revision;
  if (!candidate) return null;
  let kind: "delivery_integration" | "delivery_completion";
  let title: string;
  let detail: string;
  let occurrence = "ready";
  switch (current.nextAction) {
    case "record_integration":
      kind = "delivery_integration";
      title = "Record the post-merge integration result";
      detail =
        "Every required pull request is merged. Record the configured integration result for this exact delivery candidate.";
      break;
    case "inspect_integration_failure":
      kind = "delivery_integration";
      title = "Post-merge integration needs attention";
      detail = current.integration.errorCode
        ? `The integration event failed with ${current.integration.errorCode}. Inspect the destination before retrying.`
        : (current.integration.summary ?? "The recorded post-merge integration failed.");
      occurrence = `${current.integration.attempt}:${current.integration.errorCode ?? "recorded"}`;
      break;
    case "request_completion":
      kind = "delivery_completion";
      title = "Complete the source issue";
      detail =
        "Delivery and integration gates passed. Review the exact source issue and explicitly request completion.";
      break;
    case "retry_completion":
      kind = "delivery_completion";
      title = "Source completion needs attention";
      detail = `The source issue could not be completed (${current.completion.errorCode ?? "unknown error"}). Inspect it before retrying.`;
      occurrence = `${current.completion.attempt}:${current.completion.errorCode ?? "failed"}`;
      break;
    default:
      return null;
  }
  const semantic = [scope.orgId, scope.projectId, scope.storyId, candidate, kind, occurrence].join(
    ":",
  );
  const digest = createHash("sha256").update(semantic).digest("hex").slice(0, 32);
  return { id: `attn_delivery_${digest}`, kind, title, detail };
}

export function storyCompletionNextAction(input: {
  candidate: StoryCompletion["candidate"];
  integration: StoryCompletion["integration"];
  source: StoryCompletion["source"];
  completion: StoryCompletion["completion"];
}): StoryCompletion["nextAction"] {
  if (input.candidate.state !== "recorded" || !input.candidate.revision) return "declare_delivery";
  if (input.candidate.allRequiredMerged !== true)
    return input.candidate.mergedCount === 0 ? "review" : "merge";
  if (input.source.state === "closed" && input.completion.state === "completed") return "completed";
  if (input.integration.state === "pending")
    return input.integration.policy.mode === "manual" ? "record_integration" : "wait_integration";
  if (["dispatching", "dispatched"].includes(input.integration.state)) return "wait_integration";
  if (input.integration.state === "failed" || input.integration.state === "stale")
    return "inspect_integration_failure";
  if (input.completion.state === "failed") return "retry_completion";
  if (["pending", "closing"].includes(input.completion.state)) return "wait_completion";
  return "request_completion";
}

function assertCandidate(current: StoryCompletion, revision: string) {
  if (
    current.candidate.revision !== revision ||
    current.candidate.state !== "recorded" ||
    current.candidate.allRequiredMerged !== true
  )
    throw new ApiError(
      409,
      "delivery_candidate_stale",
      "Reload the current fully merged delivery candidate",
    );
}

function sourceIssueNumber(story: {
  provider: string;
  externalId: string;
  repositoryId: string | null;
}) {
  if (story.provider !== "github" || !story.repositoryId || !story.externalId.startsWith("issue:"))
    return null;
  const number = Number(story.externalId.slice("issue:".length));
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

const storyWhere = (scope: Scope) =>
  and(
    eq(stories.orgId, scope.orgId),
    eq(stories.projectId, scope.projectId),
    eq(stories.id, scope.storyId),
  );
const integrationWhere = (scope: Scope) =>
  and(
    eq(storyDeliveryIntegrations.orgId, scope.orgId),
    eq(storyDeliveryIntegrations.projectId, scope.projectId),
    eq(storyDeliveryIntegrations.storyId, scope.storyId),
  );
const completionWhere = (scope: Scope) =>
  and(
    eq(storyCompletionOperations.orgId, scope.orgId),
    eq(storyCompletionOperations.projectId, scope.projectId),
    eq(storyCompletionOperations.storyId, scope.storyId),
  );

/** GitHub's observation time orders source events; closed_at only dates closure. */
export function completionCloseObservation(data: unknown, number: number) {
  const result = data as Record<string, unknown> | null;
  if (result?.state !== "closed" || result.number !== number)
    throw new Error("github_completion_unverified");
  const date = (value: unknown, fallback: Date) => {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
      throw new Error("github_completion_unverified");
    return new Date(value);
  };
  const closedAt = date(result.closed_at, new Date());
  const updatedAt = date(result.updated_at, closedAt);
  if (updatedAt < closedAt) throw new Error("github_completion_unverified");
  return { closedAt, updatedAt };
}
