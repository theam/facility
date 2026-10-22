import { randomUUID } from "node:crypto";
import type { AgentManifest } from "@facility/agents";
import {
  CONSULTATION_LIMITS,
  ConsultationOptionsSchema,
  ConsultationQuery,
  newId,
  type RequestConsultation,
  RequestConsultationBody,
} from "@facility/core";
import {
  type FacilityDb,
  modelCalls,
  storyConsultations,
  storyConversations,
  storyMessages,
} from "@facility/db";
import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { ApiError } from "../errors.js";
import { BudgetPolicyError, CostBudgetService } from "../insights/costs.js";
import { type ModelCallSettlement, modelCallFingerprint } from "../insights/model-calls.js";
import { consultationTextHash, prepareConsultationContext } from "./consultation-context.js";
import { type ConsultationProvider, consultationCapability } from "./consultation-policy.js";
import {
  type ConsultationCompletion,
  ConsultationProviderError,
  callConsultationProvider,
} from "./consultation-provider.js";
import {
  type ConsultationRepository,
  type ConsultationScope,
  type ConsultationSources,
  revalidateConsultationRepositories,
} from "./consultation-sources.js";
import {
  authorizeConsultation,
  type ConsultationActor,
  type ConsultationRow,
  consultationBillJoin,
  consultationProjection,
  consultationStory,
  consultationStoryLock,
  consultationWhere,
} from "./consultation-state.js";
import { captureConsultationTaskState } from "./consultation-task-state.js";

const active = ["queued", "preparing", "running"];
type Job = ConsultationScope & { consultationId: string };
type View = { costsVisible?: boolean };
const failureCode = (error: unknown) =>
  error instanceof ApiError ||
  error instanceof BudgetPolicyError ||
  error instanceof ConsultationProviderError
    ? error.code
    : "consultation_preparation_failed";

/** Separate durable text consultation; no native engine, runtime, credential broker or tool dispatcher. */
export class StoryConsultationService {
  private readonly costs: CostBudgetService;
  constructor(
    private readonly db: FacilityDb,
    private readonly deps: {
      sources: ConsultationSources;
      credentials: (
        scope: ConsultationScope,
        provider: ConsultationProvider,
      ) => Promise<string | undefined>;
      complete?: typeof callConsultationProvider;
      enqueue: (data: Job) => Promise<unknown>;
    },
  ) {
    this.costs = new CostBudgetService(db);
  }

  private tx<T>(work: (db: FacilityDb) => Promise<T>) {
    return this.db.transaction((tx) => work(tx as unknown as FacilityDb));
  }
  private async row(db: FacilityDb, job: Job) {
    const [row] = await db
      .select()
      .from(storyConsultations)
      .where(and(consultationWhere(job), eq(storyConsultations.id, job.consultationId)))
      .limit(1)
      .for("update");
    if (!row) throw new ApiError(404, "not_found", "Consultation not found");
    return row;
  }
  async get(scope: ConsultationScope, consultationId: string, view: View = {}) {
    await consultationStory(this.db, scope);
    const [value] = await this.db
      .select({ consultation: storyConsultations, call: modelCalls })
      .from(storyConsultations)
      .leftJoin(modelCalls, consultationBillJoin)
      .where(and(consultationWhere(scope), eq(storyConsultations.id, consultationId)))
      .limit(1);
    if (!value) throw new ApiError(404, "not_found", "Consultation not found");
    return consultationProjection(value.consultation, value.call, view.costsVisible);
  }
  async list(
    scope: ConsultationScope,
    query: { limit?: number; offset?: number } = {},
    view: View = {},
  ) {
    await consultationStory(this.db, scope);
    const page = ConsultationQuery.parse(query);
    const [rows, [count]] = await Promise.all([
      this.db
        .select({ consultation: storyConsultations, call: modelCalls })
        .from(storyConsultations)
        .leftJoin(modelCalls, consultationBillJoin)
        .where(consultationWhere(scope))
        .orderBy(desc(storyConsultations.createdAt), desc(storyConsultations.id))
        .limit(page.limit)
        .offset(page.offset),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(storyConsultations)
        .where(consultationWhere(scope)),
    ]);
    if (!count)
      throw new ApiError(
        500,
        "consultation_count_unavailable",
        "Consultation count is unavailable",
      );
    return {
      items: rows.map((r) => consultationProjection(r.consultation, r.call, view.costsVisible)),
      total: count.total,
      ...page,
    };
  }

  private async catalog(scope: ConsultationScope) {
    try {
      const result = await this.deps.sources.catalog(scope);
      if (!result.repositoryId || !/^[a-f0-9]{40}$/.test(result.commitSha))
        throw new Error("unverified catalog");
      const identity = await this.deps.sources.identity(scope, result.repositoryId);
      if (identity.role !== "primary") throw new Error("foreign catalog");
      return { ...result, identity };
    } catch {
      throw new ApiError(
        503,
        "consultation_catalog_unavailable",
        "Refresh the canonical agent catalog before preparing a consultation",
        undefined,
        true,
      );
    }
  }
  private requireAgent(manifest: AgentManifest | undefined, surface: "ui" | "mcp") {
    if (!manifest?.enabled || !manifest.triggers.some((t) => t.type === surface))
      throw new ApiError(
        409,
        "consultation_agent_unavailable",
        "The selected agent is not enabled for this surface",
      );
    return manifest;
  }
  private async credential(scope: ConsultationScope, provider: ConsultationProvider) {
    try {
      return await this.deps.credentials(scope, provider);
    } catch {
      return undefined;
    }
  }
  async options(scope: ConsultationScope, surface: "ui" | "mcp", view: View = {}) {
    await consultationStory(this.db, scope, true);
    const catalog = await this.catalog(scope);
    const configured = {
      openai: Boolean(await this.credential(scope, "openai")),
      anthropic: Boolean(await this.credential(scope, "anthropic")),
    };
    let repositories: Awaited<ReturnType<ConsultationSources["repositories"]>>;
    try {
      repositories = await this.deps.sources.repositories(scope);
    } catch {
      throw new ApiError(
        503,
        "consultation_sources_unavailable",
        "Source revisions could not be read; refresh before selecting files",
        undefined,
        true,
      );
    }
    return ConsultationOptionsSchema.parse({
      executor: "provider_api_text",
      costsVisible: view.costsVisible === true,
      catalogSha: catalog.commitSha,
      agents: catalog.manifests.map((manifest) => {
        const capability = consultationCapability(
          manifest.engine,
          manifest.model,
          manifest.prompt,
          manifest.options.reasoning_effort,
        );
        const enabled = manifest.enabled && manifest.triggers.some((t) => t.type === surface);
        const hasKey = capability.provider && configured[capability.provider];
        return {
          name: manifest.name,
          engine: manifest.engine,
          model: manifest.model,
          reasoningEffort: manifest.options.reasoning_effort ?? null,
          manifestHash: manifest.hash,
          eligible: enabled && capability.eligible && Boolean(hasKey),
          reason: !enabled
            ? "agent_unavailable"
            : !capability.eligible
              ? capability.reason
              : !hasKey
                ? "provider_api_key_unavailable"
                : null,
          estimateCents: view.costsVisible ? capability.estimateCents : null,
        };
      }),
      repositories,
      limits: {
        files: CONSULTATION_LIMITS.files,
        fileBytes: CONSULTATION_LIMITS.fileBytes,
        requestBytes: CONSULTATION_LIMITS.requestBytes,
        outputTokens: CONSULTATION_LIMITS.outputTokens,
      },
    });
  }

  async request(
    scope: ConsultationScope,
    input: RequestConsultation,
    actor: ConsultationActor,
    surface: "ui" | "mcp",
    view: View = {},
  ) {
    const body = RequestConsultationBody.parse(input);
    await consultationStory(this.db, scope, true);
    await authorizeConsultation(this.db, scope, actor);
    const fingerprint = modelCallFingerprint({
      actor: { type: actor.type, id: actor.id },
      surface,
      body,
    });
    const replay = (
      await this.db
        .select()
        .from(storyConsultations)
        .where(
          and(consultationWhere(scope), eq(storyConsultations.requestKey, body.idempotency_key)),
        )
        .limit(1)
    )[0];
    if (replay) {
      if (replay.fingerprint !== fingerprint)
        throw new ApiError(
          409,
          "consultation_idempotency_conflict",
          "This key already identifies another consultation request",
        );
      return this.get(scope, replay.id, view);
    }
    const catalog = await this.catalog(scope);
    const manifest = this.requireAgent(
      catalog.manifests.find((m) => m.name === body.agent),
      surface,
    );
    if (
      manifest.hash !== body.expected_agent_hash ||
      catalog.commitSha !== body.expected_catalog_sha
    )
      throw new ApiError(
        409,
        "consultation_configuration_changed",
        "The selected agent configuration changed; refresh and review it before requesting a consultation",
      );
    const capability = consultationCapability(
      manifest.engine,
      manifest.model,
      manifest.prompt,
      manifest.options.reasoning_effort,
    );
    if (!capability.eligible || !capability.provider)
      throw new ApiError(
        409,
        capability.reason ?? "consultation_model_unsupported",
        "The configured model or reasoning settings are not supported by the isolated API executor",
      );
    if (!(await this.credential(scope, capability.provider)))
      throw new ApiError(
        409,
        "consultation_credentials_unavailable",
        "This model requires its existing project provider API key; native subscription login is not used",
      );
    const identities: ConsultationRepository[] = [catalog.identity];
    for (const source of body.sources)
      identities.push(await this.deps.sources.identity(scope, source.repository_id));
    const taskState = await captureConsultationTaskState(this.db, scope);
    const row = await this.tx(async (tx) => {
      await consultationStoryLock(tx, scope);
      const story = await consultationStory(tx, scope, true);
      await authorizeConsultation(tx, scope, actor);
      await revalidateConsultationRepositories(tx, this.deps.sources, scope, identities);
      const existing = (
        await tx
          .select()
          .from(storyConsultations)
          .where(
            and(consultationWhere(scope), eq(storyConsultations.requestKey, body.idempotency_key)),
          )
          .limit(1)
      )[0];
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new ApiError(
            409,
            "consultation_idempotency_conflict",
            "This key already identifies another consultation request",
          );
        return existing;
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`facility:consultations:${scope.orgId}:${scope.projectId}`}))`,
      );
      const running = await tx
        .select({ storyId: storyConsultations.storyId })
        .from(storyConsultations)
        .where(
          and(
            eq(storyConsultations.orgId, scope.orgId),
            eq(storyConsultations.projectId, scope.projectId),
            inArray(storyConsultations.state, active),
          ),
        )
        .limit(CONSULTATION_LIMITS.projectConcurrency);
      if (
        running.some((r) => r.storyId === scope.storyId) ||
        running.length >= CONSULTATION_LIMITS.projectConcurrency
      )
        throw new ApiError(
          409,
          "consultation_concurrency_limit",
          "A consultation is already active for this task or the project consultation limit has been reached",
        );
      const [conversation] = await tx
        .select({ summary: storyConversations.summary })
        .from(storyConversations)
        .where(
          and(
            eq(storyConversations.orgId, scope.orgId),
            eq(storyConversations.projectId, scope.projectId),
            eq(storyConversations.storyId, scope.storyId),
          ),
        )
        .limit(1);
      if (!conversation)
        throw new ApiError(
          409,
          "consultation_conversation_missing",
          "The saved task conversation is unavailable",
        );
      const [sequence] = await tx
        .select({ last: sql<number>`coalesce(max(${storyMessages.seq}), 0)::int` })
        .from(storyMessages)
        .where(
          and(
            eq(storyMessages.orgId, scope.orgId),
            eq(storyMessages.projectId, scope.projectId),
            eq(storyMessages.storyId, scope.storyId),
          ),
        );
      if (!sequence)
        throw new ApiError(
          500,
          "consultation_context_invalid",
          "The conversation watermark is unavailable",
        );
      const summaryOmitted =
        conversation.summary !== null && Buffer.byteLength(conversation.summary) > 4096;
      const now = new Date();
      const [created] = await tx
        .insert(storyConsultations)
        .values({
          id: newId("cons"),
          ...scope,
          requestKey: body.idempotency_key,
          fingerprint,
          principalType: actor.type,
          principalId: actor.id,
          actorName: actor.name?.slice(0, 120) ?? null,
          surface,
          agentName: manifest.name,
          engine: manifest.engine,
          model: manifest.model,
          reasoningEffort: manifest.options.reasoning_effort ?? null,
          agentHash: manifest.hash,
          agentPrompt: manifest.prompt,
          catalogRepositoryId: catalog.identity.id,
          catalogSha: catalog.commitSha,
          provider: capability.provider,
          sourceInputs: body.sources,
          request: body.message,
          throughMessageSeq: sequence.last,
          savedSummary: summaryOmitted ? null : conversation.summary,
          summaryOmitted,
          contextData: {
            taskState,
            initialStory: {
              title: story.title,
              provider: story.provider,
              externalId: story.externalId,
            },
            requestIdentities: identities,
          },
          state: "queued",
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + CONSULTATION_LIMITS.deadlineMs),
        })
        .returning();
      if (!created)
        throw new ApiError(500, "consultation_create_failed", "Consultation was not recorded");
      return created;
    });
    try {
      await this.deps.enqueue({ ...scope, consultationId: row.id });
    } catch {
      /* The durable queued row is recovered by the worker; an accepted request is not lost. */
    }
    return this.get(scope, row.id, view);
  }

  async cancel(scope: ConsultationScope, consultationId: string, view: View = {}) {
    await this.tx(async (tx) => {
      await consultationStoryLock(tx, scope);
      const row = await this.row(tx, { ...scope, consultationId });
      if (!active.includes(row.state)) return;
      const now = new Date();
      await tx
        .update(storyConsultations)
        .set({
          cancelRequestedAt: row.cancelRequestedAt ?? now,
          updatedAt: now,
          ...(row.state === "queued"
            ? { state: "canceled", endedAt: now, errorCode: "consultation_canceled" }
            : {}),
        })
        .where(eq(storyConsultations.id, row.id));
    });
    return this.get(scope, consultationId, view);
  }

  async handoff(scope: ConsultationScope, consultationId: string) {
    const value = await this.get(scope, consultationId);
    if (
      value.state !== "succeeded" ||
      !value.result ||
      !value.resultHash ||
      value.billing.state !== "confirmed"
    )
      throw new ApiError(
        409,
        "consultation_not_complete",
        "Only a completed consultation with confirmed usage can prepare an implementation message",
      );
    return {
      consultationId,
      resultHash: value.resultHash,
      agent: value.agent.name,
      requiresExplicitSend: true as const,
      message: `Use the following saved read-only consultation as context for this implementation request. Review the current repository state before making changes. The consultation performed no workspace actions.\n\nConsultation: ${value.id}\nResult SHA-256: ${value.resultHash}\nAgent/model: ${value.agent.name} / ${value.agent.model}\n\nQuestion:\n${value.request}\n\nConsultation result:\n${value.result}`,
    };
  }

  private async failBeforeStart(job: Job, code: string, token?: string) {
    await this.tx(async (tx) => {
      await consultationStoryLock(tx, job);
      const row = await this.row(tx, job);
      if (!["queued", "preparing"].includes(row.state) || (token && row.processingToken !== token))
        return;
      const now = new Date();
      await tx
        .update(storyConsultations)
        .set({
          state: row.cancelRequestedAt ? "canceled" : "failed",
          errorCode: row.cancelRequestedAt ? "consultation_canceled" : code,
          endedAt: now,
          updatedAt: now,
        })
        .where(eq(storyConsultations.id, row.id));
    });
  }

  private async begin(job: Job) {
    return this.tx(async (tx) => {
      await consultationStoryLock(tx, job);
      const row = await this.row(tx, job);
      if (row.state !== "queued") return null;
      if (row.expiresAt <= new Date() || row.cancelRequestedAt) {
        const now = new Date();
        await tx
          .update(storyConsultations)
          .set({
            state: row.cancelRequestedAt ? "canceled" : "failed",
            errorCode: row.cancelRequestedAt ? "consultation_canceled" : "consultation_expired",
            endedAt: now,
            updatedAt: now,
          })
          .where(eq(storyConsultations.id, row.id));
        return null;
      }
      await consultationStory(tx, job, true);
      await authorizeConsultation(tx, job, {
        type: row.principalType as "user" | "key",
        id: row.principalId,
      });
      const now = new Date();
      const [claimed] = await tx
        .update(storyConsultations)
        .set({
          state: "preparing",
          processingToken: randomUUID(),
          leaseExpiresAt: new Date(Math.min(now.getTime() + 60_000, row.expiresAt.getTime())),
          updatedAt: now,
        })
        .where(eq(storyConsultations.id, row.id))
        .returning();
      return claimed ?? null;
    });
  }

  async dispatch(job: Job) {
    let begun: ConsultationRow | null;
    try {
      begun = await this.begin(job);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.statusCode === 404) return { claimed: false };
      await this.failBeforeStart(job, error.code);
      return { claimed: false, state: "failed" };
    }
    if (!begun) return { claimed: false };
    const row = begun;
    let receipt: Omit<ModelCallSettlement, "certainty" | "usage" | "cents" | "errorCode">;
    let apiKey: string;
    let prompt: string;
    let reservationId: string | undefined;
    try {
      const catalog = await this.catalog(job);
      const manifest = this.requireAgent(
        catalog.manifests.find((m) => m.name === row.agentName),
        row.surface as "ui" | "mcp",
      );
      if (
        manifest.hash !== row.agentHash ||
        catalog.commitSha !== row.catalogSha ||
        catalog.identity.id !== row.catalogRepositoryId
      )
        throw new ApiError(
          409,
          "consultation_configuration_changed",
          "The selected agent configuration changed before execution",
        );
      const prepared = await prepareConsultationContext(this.db, this.deps.sources, row);
      const credential = await this.credential(job, row.provider as ConsultationProvider);
      if (!credential)
        throw new ApiError(
          409,
          "consultation_credentials_unavailable",
          "The configured provider API key is unavailable",
        );
      apiKey = credential;
      prompt = prepared.prompt;
      const owner = row;
      const admission = await this.costs.reserveConsultation(
        {
          ...job,
          model: row.model,
          provider: row.provider as ConsultationProvider,
          requestKey: `consultation:${row.id}`,
          fingerprint: modelCallFingerprint({
            request: row.fingerprint,
            context: prepared.hash,
            model: row.model,
            provider: row.provider,
          }),
        },
        new Date(),
        async (tx, admitted) => {
          const current = await this.row(tx, job);
          const now = new Date();
          if (
            current.state !== "preparing" ||
            current.processingToken !== owner.processingToken ||
            current.cancelRequestedAt ||
            !current.leaseExpiresAt ||
            current.leaseExpiresAt <= now ||
            current.expiresAt <= now
          )
            throw new ApiError(
              409,
              "consultation_claim_expired",
              "This consultation no longer owns an active execution claim",
            );
          await tx
            .update(storyConsultations)
            .set({
              modelCallId: admitted.callId,
              contextPrompt: prompt,
              contextHash: prepared.hash,
              contextData: {
                ...(owner.contextData as object),
                context: prepared.context,
                identities: prepared.identities,
              },
              updatedAt: now,
            })
            .where(eq(storyConsultations.id, current.id));
        },
      );
      if (admission.outcome !== "admitted")
        throw new ApiError(
          409,
          `consultation_budget_${admission.outcome}`,
          "The project budget cannot admit this consultation attempt",
        );
      reservationId = admission.reservationId;
      const claimToken = await this.costs.claimModelCall(
        { ...job, callId: admission.callId },
        new Date(),
        async (tx) => {
          const current = await this.row(tx, job);
          const now = new Date();
          if (
            current.state !== "preparing" ||
            current.processingToken !== owner.processingToken ||
            current.cancelRequestedAt ||
            !current.leaseExpiresAt ||
            current.leaseExpiresAt <= now ||
            current.expiresAt <= now
          )
            throw new ApiError(
              409,
              "consultation_claim_expired",
              "This consultation no longer owns an active execution claim",
            );
          await consultationStory(tx, job, true);
          await authorizeConsultation(tx, job, {
            type: current.principalType as "user" | "key",
            id: current.principalId,
          });
          await revalidateConsultationRepositories(tx, this.deps.sources, job, prepared.identities);
          await tx
            .update(storyConsultations)
            .set({
              state: "running",
              startedAt: now,
              modelCallId: admission.callId,
              contextPrompt: prompt,
              contextHash: prepared.hash,
              contextData: {
                ...(owner.contextData as object),
                context: prepared.context,
                identities: prepared.identities,
              },
              leaseExpiresAt: new Date(
                Math.min(now.getTime() + 45_000, current.expiresAt.getTime()),
              ),
              updatedAt: now,
            })
            .where(eq(storyConsultations.id, current.id));
        },
      );
      if (!claimToken)
        throw new ApiError(
          409,
          "consultation_attempt_unavailable",
          "This consultation attempt already started or expired",
        );
      receipt = { ...job, callId: admission.callId, reservationId, claimToken };
    } catch (error) {
      if (reservationId) await this.costs.releaseReservation(reservationId, job);
      await this.failBeforeStart(job, failureCode(error), row.processingToken ?? undefined);
      return { claimed: true, state: "failed" };
    }
    const controller = new AbortController();
    const watch = this.watch(job, row.processingToken ?? "", controller);
    let completion: ConsultationCompletion | undefined;
    let failure: ConsultationProviderError | undefined;
    try {
      await watch.first;
      if (controller.signal.aborted)
        throw new ConsultationProviderError("consultation_canceled", "unbilled");
      completion = await (this.deps.complete ?? callConsultationProvider)({
        provider: row.provider as ConsultationProvider,
        model: row.model,
        reasoningEffort: row.reasoningEffort,
        apiKey,
        prompt,
        signal: controller.signal,
      });
    } catch (error) {
      failure =
        error instanceof ConsultationProviderError
          ? error
          : new ConsultationProviderError("provider_request_failed");
    } finally {
      watch.stop();
    }
    const final = completion;
    const failed = failure;
    // Settlement errors deliberately escape. A retried queue job cannot claim this running attempt.
    await this.costs.settleModelCall(
      {
        ...receipt,
        certainty: final ? "confirmed" : (failed?.certainty ?? "unconfirmed"),
        usage: final?.usage ?? failed?.usage,
        errorCode: failed?.code,
      },
      async (tx, bill) => {
        const current = await this.row(tx, job);
        if (current.state !== "running" || current.processingToken !== row.processingToken) return;
        const now = new Date();
        const canceled = current.cancelRequestedAt !== null;
        const state = canceled
          ? "canceled"
          : current.expiresAt <= now
            ? "failed"
            : final?.outcome === "completed" && bill.state === "confirmed"
              ? "succeeded"
              : final?.outcome === "incomplete"
                ? "incomplete"
                : "failed";
        await tx
          .update(storyConsultations)
          .set({
            state,
            result: final?.text ?? null,
            resultHash: final ? consultationTextHash(final.text) : null,
            providerModel: final?.model ?? null,
            errorCode: canceled
              ? "consultation_canceled"
              : current.expiresAt <= now
                ? "consultation_expired"
                : (failed?.code ??
                  (final?.outcome === "completed" && bill.state === "confirmed"
                    ? null
                    : final?.outcome === "denied"
                      ? "provider_tool_denied"
                      : final?.outcome === "refused"
                        ? "provider_refused"
                        : "provider_result_incomplete")),
            endedAt: now,
            updatedAt: now,
          })
          .where(eq(storyConsultations.id, current.id));
      },
    );
    return { claimed: true, state: (await this.get(job, job.consultationId)).state };
  }

  private watch(job: Job, token: string, controller: AbortController) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (stopped) return;
      try {
        const [row] = await this.db
          .select({
            state: storyConsultations.state,
            token: storyConsultations.processingToken,
            cancel: storyConsultations.cancelRequestedAt,
            expires: storyConsultations.expiresAt,
          })
          .from(storyConsultations)
          .where(and(consultationWhere(job), eq(storyConsultations.id, job.consultationId)))
          .limit(1);
        if (
          row?.state !== "running" ||
          row.token !== token ||
          row.cancel ||
          row.expires <= new Date()
        )
          controller.abort();
        else if (!stopped)
          timer = setTimeout(() => {
            void poll();
          }, 500);
      } catch {
        controller.abort();
      }
    };
    const first = poll();
    return {
      first,
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
  }

  async recover(now = new Date()) {
    const rows = await this.db
      .select()
      .from(storyConsultations)
      .where(
        and(
          inArray(storyConsultations.state, active),
          or(lte(storyConsultations.expiresAt, now), lte(storyConsultations.leaseExpiresAt, now)),
        ),
      )
      .orderBy(asc(storyConsultations.createdAt))
      .limit(1000);
    let recovered = 0;
    for (const candidate of rows) {
      const job = {
        orgId: candidate.orgId,
        projectId: candidate.projectId,
        storyId: candidate.storyId,
        consultationId: candidate.id,
      };
      const finish = async (tx: FacilityDb) => {
        const current = await this.row(tx, job);
        if (
          !active.includes(current.state) ||
          (current.expiresAt > now && (!current.leaseExpiresAt || current.leaseExpiresAt > now))
        )
          return;
        await tx
          .update(storyConsultations)
          .set({
            state: current.cancelRequestedAt ? "canceled" : "failed",
            errorCode: current.cancelRequestedAt
              ? "consultation_canceled"
              : current.state === "queued"
                ? "consultation_expired"
                : "consultation_worker_interrupted",
            endedAt: now,
            updatedAt: now,
          })
          .where(eq(storyConsultations.id, current.id));
        recovered++;
      };
      if (candidate.modelCallId) {
        const [call] = await this.db
          .select()
          .from(modelCalls)
          .where(
            and(
              eq(modelCalls.id, candidate.modelCallId),
              eq(modelCalls.orgId, job.orgId),
              eq(modelCalls.projectId, job.projectId),
              eq(modelCalls.storyId, job.storyId),
              eq(modelCalls.purpose, "consultation"),
            ),
          )
          .limit(1);
        if (!call)
          throw new ApiError(
            500,
            "consultation_bill_missing",
            "Consultation billing record is unavailable",
          );
        const settled = await this.costs.settleModelCall(
          {
            ...job,
            callId: call.id,
            reservationId: call.reservationId,
            claimToken: call.claimToken,
            certainty: call.startedAt ? "unconfirmed" : "unbilled",
            errorCode: "consultation_worker_interrupted",
          },
          finish,
        );
        if (settled.replayed)
          await this.tx(async (tx) => {
            await consultationStoryLock(tx, job);
            await finish(tx);
          });
      } else
        await this.tx(async (tx) => {
          await consultationStoryLock(tx, job);
          await finish(tx);
        });
    }
    return recovered;
  }
  async pending(now = new Date(), limit = 100) {
    const rows = await this.db
      .select({
        orgId: storyConsultations.orgId,
        projectId: storyConsultations.projectId,
        storyId: storyConsultations.storyId,
        consultationId: storyConsultations.id,
      })
      .from(storyConsultations)
      .where(
        and(
          eq(storyConsultations.state, "queued"),
          lte(storyConsultations.createdAt, new Date(now.getTime() - 2_000)),
        ),
      )
      .orderBy(asc(storyConsultations.createdAt))
      .limit(limit);
    return rows;
  }
}
