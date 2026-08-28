import { newId } from "@facility/core";
import {
  agentDefs,
  insertAuditEvent,
  projects,
  runDeliveries,
  runEvents,
  runs,
  steerMessages,
  withOrg,
} from "@facility/db";
import { isBuilderMode, runObjectiveText } from "@facility/run-objective";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import postgres from "postgres";
import { z } from "zod";
import { withBuilderPlanPreflight } from "../../builder-plan-policy.js";
import { readTranscriptObject } from "../../envelopes.js";
import { ApiError, notFound } from "../../errors.js";
import { cancelRun } from "../../sandbox/orchestrator.js";
import {
  appendRunEvents,
  notifyRunEvent,
  TERMINAL_RUN_STATUSES,
  terminalStatus,
} from "../../sandbox/state.js";
import type { AppConfig, Principal } from "../../types.js";
import {
  AnyObject,
  assertProjectScope,
  IdParams,
  principal,
  RunEventSchema,
  RunSchema,
  RunWithProjectSchema,
  redactRunSecrets,
  SteerMessageSchema,
  assertProjectInOrg as sharedAssertProjectInOrg,
  type V1RouteContext,
} from "./shared.js";

const RunDeliverySchema = z.object({
  runId: z.string(),
  status: z.enum(["pending", "delivering", "delivered", "blocked"]),
  attempts: z.number().int(),
  nextAttemptAt: z.date(),
  blockedReason: z.string().nullable(),
  error: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  prUrl: z.string().nullable(),
});

export async function registerRunsRoutes(app: FastifyInstance, context: V1RouteContext) {
  const { db, config } = context;
  const _assertProjectInOrg = (
    p: Principal,
    projectId: string | null | undefined,
    statusCode?: number,
  ) => sharedAssertProjectInOrg(db, p, projectId, statusCode);
  function agentDefMatches(row: typeof agentDefs.$inferSelect, name: string) {
    const values = new Set([name, name.startsWith("/") ? name.slice(1) : `/${name}`]);
    if (values.has(row.name)) return true;
    const triggers = row.triggers as unknown;
    if (!Array.isArray(triggers)) return false;
    return triggers.some((trigger) => {
      if (!trigger || typeof trigger !== "object") return false;
      const value =
        (trigger as { command?: unknown; handle?: unknown }).command ??
        (trigger as { handle?: unknown }).handle;
      return typeof value === "string" && values.has(value);
    });
  }

  async function resolveRunAgentDef(
    orgId: string,
    projectId: string,
    input: { agentDefId?: string; agent?: string; trigger?: Record<string, unknown> },
  ) {
    if (input.agentDefId) {
      const agent = (
        await db.select().from(agentDefs).where(eq(agentDefs.id, input.agentDefId)).limit(1)
      )[0];
      if (!agent || agent.orgId !== orgId || agent.projectId !== projectId) {
        throw new ApiError(400, "agent_not_in_project", "Agent definition is not in project");
      }
      if (!agent.enabled) {
        throw new ApiError(400, "agent_required", "Agent definition is disabled");
      }
      return agent;
    }

    const triggerAgentName = input.trigger?.agentName ?? input.trigger?.agent;
    const agentName =
      typeof input.agent === "string"
        ? input.agent
        : typeof triggerAgentName === "string"
          ? triggerAgentName
          : undefined;
    if (!agentName) {
      throw new ApiError(400, "agent_required", "A valid enabled agent is required");
    }
    const candidates = await db
      .select()
      .from(agentDefs)
      .where(
        and(
          eq(agentDefs.orgId, orgId),
          eq(agentDefs.projectId, projectId),
          eq(agentDefs.enabled, true),
        ),
      );
    const agent = candidates.find((row) => agentDefMatches(row, agentName));
    if (!agent) {
      throw new ApiError(400, "agent_required", "A valid enabled agent is required");
    }
    return agent;
  }

  app.get(
    "/v1/projects/:projectId/runs",
    {
      config: { permission: "runs:read" },
      schema: {
        params: IdParams,
        querystring: z.object({
          status: z.string().optional(),
          agentDefId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(RunSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      // A project-scoped principal may only list its own project's runs — without
      // this a key pinned to project X could read project Y's runs in the same org.
      assertProjectScope(p, projectId);
      const query = request.query as {
        status?: string;
        agentDefId?: string;
        limit: number;
        offset: number;
      };
      const clauses = [eq(runs.orgId, p.orgId), eq(runs.projectId, projectId)];
      if (query.status) clauses.push(eq(runs.status, query.status));
      if (query.agentDefId) clauses.push(eq(runs.agentDefId, query.agentDefId));
      const rows = await db
        .select()
        .from(runs)
        .where(and(...clauses))
        .orderBy(desc(runs.queuedAt))
        .limit(query.limit)
        .offset(query.offset);
      // Strip sealed credentials from every run-read surface.
      return rows.map(redactRunSecrets);
    },
  );

  app.get(
    "/v1/runs/:runId/delivery",
    {
      config: { permission: "runs:read" },
      schema: { params: IdParams, response: { 200: RunDeliverySchema } },
    },
    async (request) => {
      const p = principal(request);
      const { runId } = request.params as { runId: string };
      await loadRun(p, runId);
      const delivery = (
        await db
          .select()
          .from(runDeliveries)
          .where(and(eq(runDeliveries.orgId, p.orgId), eq(runDeliveries.runId, runId)))
          .limit(1)
      )[0];
      if (!delivery || (p.projectId && delivery.projectId !== p.projectId)) {
        throw notFound("Run delivery not found");
      }
      return delivery;
    },
  );

  app.post(
    "/v1/projects/:projectId/runs",
    {
      config: { permission: "runs:trigger", auditAction: "run.started", idempotent: true },
      schema: {
        params: IdParams,
        body: z.object({
          mode: z.string().default("builder"),
          engine: z.string().default("codex"),
          trigger: AnyObject.optional(),
          agentDefId: z.string().optional(),
          agent: z.string().optional(),
        }),
        response: { 200: RunSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      const body = request.body as {
        mode: string;
        engine: string;
        trigger?: Record<string, unknown>;
        agentDefId?: string;
        agent?: string;
      };
      assertProjectScope(p, projectId);
      if (body.trigger?.source === "plan_acceptance") {
        throw new ApiError(
          400,
          "reserved_trigger_source",
          "plan_acceptance runs can only be created by the approved-plan executor",
        );
      }
      const agent = await resolveRunAgentDef(p.orgId, projectId, body);
      const policyTrigger = { ...(body.trigger ?? {}) };
      if ("githubLogin" in policyTrigger) {
        delete policyTrigger.githubLogin;
        if (p.githubLogin) policyTrigger.githubLogin = p.githubLogin;
      }
      // Preserve issue provenance across generic dispatch (retries pass the
      // source run's trigger): without this, a retried issue-run loses its
      // gh linkage and disappears from the issue's history and the pipeline.
      const triggerRepo = policyTrigger.repo as { owner?: unknown; name?: unknown } | undefined;
      const triggerIssue = policyTrigger.issue as { number?: unknown } | undefined;
      const gh =
        typeof triggerRepo?.owner === "string" &&
        typeof triggerRepo?.name === "string" &&
        typeof triggerIssue?.number === "number"
          ? { owner: triggerRepo.owner, repo: triggerRepo.name, issueNumber: triggerIssue.number }
          : {};
      const run = (
        await withBuilderPlanPreflight(
          db,
          {
            orgId: p.orgId,
            projectId,
            mode: agent.name,
            agentDefId: agent.id,
            trigger: policyTrigger,
            actor: auditActor(p),
            source: "rest_run",
          },
          (tx, admission) => {
            // Required Builder governance is evaluated before the legacy
            // objective validation. This keeps the stable Gate 1 denial (and
            // no-row invariant) authoritative for every Builder request while
            // optional projects retain the existing objective error.
            const trigger = validatedRunTrigger(admission.mode, policyTrigger);
            return (
              tx
                // builder-plan-preflight: rest_run
                .insert(runs)
                .values({
                  id: newId("run"),
                  orgId: p.orgId,
                  projectId,
                  agentDefId: agent.id,
                  // Persist the role admitted under the project lock. Builder
                  // classification cannot later disappear when an agent's name or
                  // command triggers are edited.
                  mode: admission.mode,
                  // The agent definition owns execution engine selection. Persisting a
                  // caller-supplied default made CLI/MCP-triggered Claude/BYO runs look
                  // like Codex runs even though orchestration correctly used the agent.
                  engine: agent.engine,
                  trigger,
                  gh,
                  createdBy: { type: p.type, id: p.id },
                })
                .returning()
            );
          },
        )
      )[0];
      if (!run) throw new ApiError(500, "insert_failed", "Could not create run");
      await db.insert(runEvents).values({
        orgId: p.orgId,
        runId: run.id,
        seq: 1,
        type: "queued",
        data: { queue: "runs.dispatch" },
      });
      await app.enqueue("runs.dispatch", { runId: run.id, orgId: p.orgId });
      return redactRunSecrets(run);
    },
  );

  // Product Owner delegation: dispatch a read-only architect run to answer a
  // question against the actual code. Architect modes never ship changes and
  // skip acceptance checks, so a consult is safe to run on any repo state.
  app.post(
    "/v1/projects/:projectId/consult",
    {
      config: { permission: "runs:trigger", auditAction: "run.started", idempotent: true },
      schema: {
        params: IdParams,
        body: z.object({
          question: z.string().min(8),
          agent: z.string().default("architect"),
        }),
        response: { 200: RunSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const body = request.body as { question: string; agent: string };
      const agent = await resolveRunAgentDef(p.orgId, projectId, { agent: body.agent });
      if (agent.name !== "architect" && agent.name !== "codex-architect") {
        throw new ApiError(
          400,
          "consult_agent_invalid",
          "Consult dispatches read-only architect agents only",
        );
      }
      const trigger = {
        type: "consult",
        question: body.question,
        requestedBy: { type: p.type, id: p.id },
      };
      const run = (
        await withBuilderPlanPreflight(
          db,
          {
            orgId: p.orgId,
            projectId,
            mode: agent.name,
            agentDefId: agent.id,
            trigger,
            actor: auditActor(p),
            source: "rest_consult",
          },
          (tx, admission) =>
            tx
              // builder-plan-preflight: rest_consult
              .insert(runs)
              .values({
                id: newId("run"),
                orgId: p.orgId,
                projectId,
                agentDefId: agent.id,
                mode: admission.mode,
                engine: agent.engine,
                trigger,
                gh: {},
                createdBy: { type: p.type, id: p.id },
              })
              .returning(),
        )
      )[0];
      if (!run) throw new ApiError(500, "insert_failed", "Could not create run");
      await db.insert(runEvents).values({
        orgId: p.orgId,
        runId: run.id,
        seq: 1,
        type: "queued",
        data: { queue: "runs.dispatch" },
      });
      await app.enqueue("runs.dispatch", { runId: run.id, orgId: p.orgId });
      return redactRunSecrets(run);
    },
  );

  // The distilled outcome of a run: terminal status plus the last assistant
  // message. Lets a consulting agent (or the UI) read an answer without
  // walking the whole event stream.
  app.get(
    "/v1/runs/:runId/result",
    {
      config: { permission: "runs:read" },
      schema: {
        params: IdParams,
        response: {
          200: z.object({
            id: z.string(),
            status: z.string(),
            terminal: z.boolean(),
            answer: z.string().nullable(),
            error: z.string().nullable(),
          }),
        },
      },
    },
    async (request) => {
      const p = principal(request);
      const { runId } = request.params as { runId: string };
      const run = await loadRun(p, runId);
      const terminal = terminalStatus(run.status);
      if (!terminal) {
        return { id: run.id, status: run.status, terminal, answer: null, error: null };
      }
      const events = await db
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.orgId, p.orgId), eq(runEvents.runId, runId)))
        .orderBy(desc(runEvents.seq))
        .limit(500);
      let answer: string | null = null;
      let error: string | null = null;
      for (const event of events) {
        const data =
          event.data && typeof event.data === "object"
            ? (event.data as Record<string, unknown>)
            : {};
        if (!error && event.type === "result" && typeof data.error === "string") {
          error = data.error;
        }
        // Current sandbox vocabulary: the final message is an `assistant`
        // event carrying plain text (the engine-shaped branch below covers
        // the older nested form).
        if (!answer && event.type === "assistant" && typeof data.text === "string") {
          const text = data.text.trim();
          if (text) answer = text.length > 20_000 ? text.slice(-20_000) : text;
        }
        if (!answer && event.type === "engine" && data.type === "assistant") {
          const message =
            data.message && typeof data.message === "object"
              ? (data.message as { content?: unknown })
              : {};
          const content = Array.isArray(message.content) ? message.content : [];
          const text = content
            .map((part) =>
              part && typeof part === "object" && (part as { type?: unknown }).type === "text"
                ? String((part as { text?: unknown }).text ?? "")
                : "",
            )
            .filter(Boolean)
            .join("\n")
            .trim();
          if (text) answer = text.length > 20_000 ? text.slice(-20_000) : text;
        }
        if (answer && error) break;
      }
      return { id: run.id, status: run.status, terminal, answer, error };
    },
  );

  // Bare-id run access: org scope always; project-scoped keys are pinned to
  // their project (404 on anything else — no existence oracle).
  async function loadRun(p: ReturnType<typeof principal>, runId: string) {
    const row = await withOrg(db, p.orgId).runs.byId(runId);
    if (!row) throw notFound("Run not found");
    if (p.projectId && row.projectId !== p.projectId) throw notFound("Run not found");
    return row;
  }

  app.get(
    "/v1/runs",
    {
      config: { permission: "runs:read" },
      schema: {
        querystring: z.object({
          status: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(RunWithProjectSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const query = request.query as { status?: string; limit: number; offset: number };
      const clauses = [eq(runs.orgId, p.orgId)];
      if (p.projectId) clauses.push(eq(runs.projectId, p.projectId));
      if (query.status) clauses.push(eq(runs.status, query.status));
      const rows = await db
        .select({
          run: runs,
          project: { id: projects.id, name: projects.name, slug: projects.slug },
        })
        .from(runs)
        .innerJoin(projects, eq(projects.id, runs.projectId))
        .where(and(...clauses))
        .orderBy(desc(runs.queuedAt))
        .limit(query.limit)
        .offset(query.offset);
      return rows.map((row) => redactRunSecrets({ ...row.run, project: row.project }));
    },
  );

  app.get(
    "/v1/runs/:runId",
    {
      config: { permission: "runs:read" },
      schema: { params: IdParams, response: { 200: RunSchema } },
    },
    async (request) => {
      const p = principal(request);
      const { runId } = request.params as { runId: string };
      return redactRunSecrets(await loadRun(p, runId));
    },
  );

  app.post(
    "/v1/runs/:runId/cancel",
    {
      config: { permission: "runs:write", auditAction: "run.canceled" },
      schema: { params: IdParams, response: { 200: RunSchema } },
    },
    async (request) => {
      const p = principal(request);
      const { runId } = request.params as { runId: string };
      const existing = await loadRun(p, runId);
      // Only cancel a non-terminal run — never overwrite a run that already
      // succeeded/failed/canceled. If the guard matches nothing the run is
      // already terminal, so return it unchanged (idempotent).
      const { row, event } = await db.transaction(async (tx) => {
        // Serialize the terminal transition with event-sequence allocation so
        // every successful cancellation has exactly one durable result event.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runId}))`);
        const row = (
          await tx
            .update(runs)
            .set({ status: "canceled", endedAt: new Date() })
            .where(
              and(
                eq(runs.orgId, p.orgId),
                eq(runs.id, runId),
                notInArray(runs.status, [...TERMINAL_RUN_STATUSES]),
              ),
            )
            .returning()
        )[0];
        if (!row) return { row: undefined, event: undefined };
        const maxRows = await tx
          .select({ max: sql<number>`coalesce(max(seq), 0)` })
          .from(runEvents)
          .where(eq(runEvents.runId, runId));
        const event = (
          await tx
            .insert(runEvents)
            .values({
              orgId: p.orgId,
              runId,
              seq: Number(maxRows[0]?.max ?? 0) + 1,
              type: "result",
              data: { status: "canceled" },
            })
            .returning()
        )[0];
        return { row, event };
      });
      if (!row) return redactRunSecrets(existing);
      if (event) await notifyRunEvent(db, runId, event);
      // cancelRun needs the raw sandbox (driver ref + key ids); redact only the
      // response copy — redactRunSecrets returns a fresh object, leaving row intact.
      await cancelRun(config, row);
      return redactRunSecrets(row);
    },
  );

  app.post(
    "/v1/runs/:runId/delivery/retry",
    {
      config: { permission: "runs:write", auditAction: "run.delivery_retried" },
      schema: {
        params: IdParams,
        response: { 200: RunDeliverySchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { runId } = request.params as { runId: string };
      await loadRun(p, runId);
      const existing = (
        await db
          .select()
          .from(runDeliveries)
          .where(and(eq(runDeliveries.orgId, p.orgId), eq(runDeliveries.runId, runId)))
          .limit(1)
      )[0];
      if (!existing || (p.projectId && existing.projectId !== p.projectId)) {
        throw notFound("Run delivery not found");
      }
      if (existing.status === "pending") return existing;
      if (existing.status !== "blocked") {
        throw new ApiError(
          409,
          "delivery_not_retryable",
          "Only blocked run deliveries can be retried",
        );
      }
      const delivery = (
        await db
          .update(runDeliveries)
          .set({
            status: "pending",
            attempts: 0,
            nextAttemptAt: new Date(),
            blockedReason: null,
            error: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(runDeliveries.orgId, p.orgId),
              eq(runDeliveries.projectId, existing.projectId),
              eq(runDeliveries.runId, runId),
              eq(runDeliveries.status, "blocked"),
            ),
          )
          .returning()
      )[0];
      if (!delivery) {
        throw new ApiError(409, "delivery_changed", "Run delivery changed concurrently");
      }
      await app.enqueue?.("deliveries.deliver", { runId }).catch(() => undefined);
      return delivery;
    },
  );

  app.get(
    "/v1/runs/:runId/transcript",
    {
      config: { permission: "runs:read" },
      schema: { params: IdParams },
    },
    async (request, reply) => {
      const p = principal(request);
      const { runId } = request.params as { runId: string };
      const run = await loadRun(p, runId);
      const body = await readTranscriptObject(config, run.transcriptUri, run.orgId);
      return reply.type("application/x-ndjson").send(body);
    },
  );

  app.get(
    "/v1/runs/:runId/events",
    {
      config: { permission: "runs:read" },
      schema: {
        params: IdParams,
        querystring: z
          .object({
            afterSeq: z.coerce.number().int().min(0).optional(),
            tail: z.coerce.number().int().min(1).max(200).optional(),
            limit: z.coerce.number().int().min(1).max(500).default(100),
          })
          .refine((query) => query.afterSeq === undefined || query.tail === undefined, {
            message: "afterSeq and tail are mutually exclusive",
          }),
        response: { 200: z.array(RunEventSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const { runId } = request.params as { runId: string };
      const {
        afterSeq = 0,
        tail,
        limit,
      } = request.query as {
        afterSeq?: number;
        tail?: number;
        limit: number;
      };
      await loadRun(p, runId);
      if (tail !== undefined) {
        const events = await db
          .select()
          .from(runEvents)
          .where(and(eq(runEvents.orgId, p.orgId), eq(runEvents.runId, runId)))
          .orderBy(desc(runEvents.seq))
          .limit(tail);
        return events.reverse();
      }
      return withOrg(db, p.orgId).runEvents.listAfter(runId, afterSeq, limit);
    },
  );

  app.get(
    "/v1/runs/:runId/stream",
    {
      config: { permission: "runs:read" },
      schema: {
        params: IdParams,
        querystring: z.object({
          afterSeq: z.coerce.number().optional(),
          idleMs: z.coerce.number().int().min(50).max(300_000).optional(),
        }),
      },
    },
    async (request, reply) => {
      const p = principal(request);
      const { runId } = request.params as { runId: string };
      const { afterSeq: requestedAfterSeq, idleMs } = request.query as {
        afterSeq?: number;
        idleMs?: number;
      };
      const lastEventId = request.headers["last-event-id"];
      const resumedAfterSeq =
        typeof lastEventId === "string" && /^\d+$/.test(lastEventId)
          ? Number(lastEventId)
          : undefined;
      const afterSeq = requestedAfterSeq ?? resumedAfterSeq ?? 0;
      await loadRun(p, runId);
      await streamRunEvents(config, reply, runId, afterSeq, idleMs, async (seq) =>
        withOrg(db, p.orgId).runEvents.listAfter(runId, seq, STREAM_BATCH_SIZE),
      );
    },
  );

  app.post(
    "/v1/runs/:runId/steer",
    {
      config: { permission: "runs:steer", auditAction: "run.steered" },
      schema: {
        params: IdParams,
        body: z.object({ body: z.string().min(1) }),
        response: { 200: SteerMessageSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { runId } = request.params as { runId: string };
      const run = await loadRun(p, runId);
      if (["succeeded", "failed", "canceled"].includes(run.status)) {
        throw new ApiError(409, "run_terminal", "Cannot steer a finished run");
      }
      const message = (
        await db
          .insert(steerMessages)
          .values({
            id: newId("evt"),
            orgId: p.orgId,
            runId,
            authorUserId: p.userId,
            kind: "steer",
            body: (request.body as { body: string }).body,
          })
          .returning()
      )[0];
      if (!message) throw new ApiError(500, "insert_failed", "Could not create steer message");
      // Route through appendRunEvents so the seq allocation shares the per-run
      // advisory lock (and NOTIFY) with the runner's high-frequency ingest — no
      // duplicate-key race between a steer and a concurrent event batch.
      await appendRunEvents(db, p.orgId, runId, [
        { type: "steer", data: { text: (request.body as { body: string }).body, author: p.id } },
      ]);
      return message;
    },
  );

  app.post(
    "/v1/runs/:runId/interrupt",
    {
      config: { permission: "runs:steer" },
      schema: { params: IdParams, response: { 200: z.object({ ok: z.boolean() }) } },
    },
    async (request) => {
      const p = principal(request);
      const { runId } = request.params as { runId: string };
      const run = await loadRun(p, runId);
      if (terminalStatus(run.status)) {
        throw new ApiError(409, "run_terminal", "Cannot interrupt a finished run");
      }
      await db.insert(steerMessages).values({
        id: newId("evt"),
        orgId: p.orgId,
        runId,
        authorUserId: p.userId,
        kind: "interrupt",
        body: "human_interrupt",
      });
      await appendRunEvents(db, p.orgId, runId, [
        { type: "steer", data: { kind: "interrupt", author: p.id } },
      ]);
      await insertAuditEvent(db, {
        orgId: p.orgId,
        projectId: run.projectId,
        actor: auditActor(p),
        action: "run.interrupted",
        target: { type: "run", id: run.id },
        payload: {},
      });
      return { ok: true };
    },
  );

  app.post(
    "/v1/runs/:runId/resume",
    {
      config: { permission: "runs:trigger" },
      schema: {
        params: IdParams,
        body: z.object({ message: z.string().optional() }).nullable().default({}),
        response: { 200: RunSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { runId } = request.params as { runId: string };
      const parent = await loadRun(p, runId);
      if (!terminalStatus(parent.status)) {
        throw new ApiError(409, "run_not_terminal", "Only terminal runs can be resumed");
      }
      if (parent.engine !== "claude_code") {
        throw new ApiError(409, "not_resumable", "Run engine does not support resume");
      }
      if (!parent.engineSessionId) {
        throw new ApiError(409, "not_resumable", "Run has no engine session id");
      }
      const body = (request.body ?? {}) as { message?: string };
      const gh = parentGhForResume(parent.gh);
      const trigger: Record<string, unknown> = { type: "resume", resumeOf: parent.id };
      if (body.message !== undefined) trigger.message = body.message;
      const run = (
        await withBuilderPlanPreflight(
          db,
          {
            orgId: p.orgId,
            projectId: parent.projectId,
            mode: parent.mode,
            agentDefId: parent.agentDefId,
            trigger,
            gh,
            actor: auditActor(p),
            source: "rest_resume",
          },
          (tx, admission) =>
            tx
              // builder-plan-preflight: rest_resume_run
              .insert(runs)
              .values({
                id: newId("run"),
                orgId: p.orgId,
                projectId: parent.projectId,
                agentDefId: parent.agentDefId,
                mode: admission.mode,
                engine: parent.engine,
                trigger,
                gh,
                createdBy: { type: p.type, id: p.id },
              })
              .returning(),
        )
      )[0];
      if (!run) throw new ApiError(500, "run_create_failed", "Run could not be created");
      await db.insert(runEvents).values({
        orgId: p.orgId,
        runId: run.id,
        seq: 1,
        type: "queued",
        data: { queue: "runs.dispatch" },
      });
      await app.enqueue("runs.dispatch", { runId: run.id, orgId: p.orgId });
      await insertAuditEvent(db, {
        orgId: p.orgId,
        projectId: run.projectId,
        actor: auditActor(p),
        action: "run.resumed",
        target: { type: "run", id: run.id },
        payload: { resumeOf: parent.id },
      });
      return redactRunSecrets(run);
    },
  );
}

function validatedRunTrigger(agentName: string, value: Record<string, unknown> | undefined) {
  const trigger = { ...value };
  if (!isBuilderMode(agentName) || runObjectiveText(trigger)) return trigger;
  throw new ApiError(400, "run_objective_required", "A builder run requires a non-empty objective");
}

function parentGhForResume(value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const gh = source as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof gh.owner === "string") out.owner = gh.owner;
  if (typeof gh.repo === "string") out.repo = gh.repo;
  if (typeof gh.branch === "string") out.branch = gh.branch;
  if (typeof gh.issueNumber === "number") out.issueNumber = gh.issueNumber;
  return out;
}

function auditActor(p: Principal): { type: "user" | "key"; id: string } {
  return { type: p.type, id: p.id };
}

async function streamRunEvents(
  config: AppConfig,
  reply: FastifyReply,
  runId: string,
  afterSeq: number,
  idleMs: number | undefined,
  load: (afterSeq: number) => Promise<unknown[]>,
) {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let closed = false;
  const close = () => {
    closed = true;
  };
  reply.raw.on("close", close);
  const write = (event: string, data: unknown, id?: number) => {
    if (closed || reply.raw.destroyed) return;
    const eventId = id === undefined ? "" : `id: ${id}\n`;
    reply.raw.write(`${eventId}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  write("heartbeat", { ts: new Date().toISOString() });
  let cursor = afterSeq;
  const writeEvents = (events: unknown[]) => {
    for (const event of events) {
      const seq =
        typeof event === "object" && event !== null ? (event as { seq?: unknown }).seq : undefined;
      write("run_event", event, typeof seq === "number" ? seq : undefined);
      if (typeof seq === "number" && seq > cursor) cursor = seq;
    }
  };
  const drainAvailable = async () => {
    while (!closed) {
      const events = await load(cursor);
      writeEvents(events);
      if (events.length < STREAM_BATCH_SIZE) return;
    }
  };
  let drainQueue = Promise.resolve();
  const enqueueDrain = () => {
    drainQueue = drainQueue.then(drainAvailable).catch((error) => {
      reply.log.error({ err: error, runId }, "run stream refresh failed");
      write("stream_error", { message: "Run stream refresh failed" });
      if (!closed) reply.raw.end();
    });
    return drainQueue;
  };
  await enqueueDrain();
  if (idleMs !== undefined && idleMs <= 1_000) {
    const poll = setInterval(() => {
      void enqueueDrain();
    }, 100);
    await waitForStreamEnd(reply, idleMs);
    clearInterval(poll);
    if (!closed) reply.raw.end();
    reply.raw.off("close", close);
    return;
  }
  const sqlClient = postgres(config.databaseUrl, { max: 1 });
  let unlisten: { unlisten: () => Promise<void> } | undefined;
  let safetyRefresh: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    try {
      unlisten = await sqlClient.listen(`run_events:${runId}`, async () => {
        await enqueueDrain();
      });
    } catch {
      await enqueueDrain();
    }
    safetyRefresh = setInterval(() => {
      void enqueueDrain();
    }, 25_000);
    heartbeat = setInterval(() => write("heartbeat", { ts: new Date().toISOString() }), 15_000);
    await waitForStreamEnd(reply, idleMs);
    if (!closed) reply.raw.end();
  } finally {
    if (safetyRefresh) clearInterval(safetyRefresh);
    if (heartbeat) clearInterval(heartbeat);
    await unlisten?.unlisten().catch(() => undefined);
    reply.raw.off("close", close);
    await sqlClient.end().catch(() => undefined);
  }
}

const STREAM_BATCH_SIZE = 100;

function waitForStreamEnd(reply: FastifyReply, timeoutMs: number | undefined) {
  if (reply.raw.destroyed || reply.raw.closed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      reply.raw.off("close", done);
      resolve();
    };
    reply.raw.on("close", done);
    if (timeoutMs !== undefined) timer = setTimeout(done, timeoutMs);
  });
}
