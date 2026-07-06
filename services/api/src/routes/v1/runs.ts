import { newId } from "@facility/core";
import { agentDefs, projects, runEvents, runs, steerMessages, withOrg } from "@facility/db";
import { and, desc, eq, notInArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import postgres from "postgres";
import { z } from "zod";
import { readTranscriptObject } from "../../envelopes.js";
import { ApiError, notFound } from "../../errors.js";
import { cancelRun } from "../../sandbox/orchestrator.js";
import { appendRunEvents, TERMINAL_RUN_STATUSES } from "../../sandbox/state.js";
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
  assertProjectInOrg as sharedAssertProjectInOrg,
  type V1RouteContext,
} from "./shared.js";

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
      const query = request.query as { status?: string; limit: number; offset: number };
      const clauses = [eq(runs.orgId, p.orgId), eq(runs.projectId, projectId)];
      if (query.status) clauses.push(eq(runs.status, query.status));
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

  app.post(
    "/v1/projects/:projectId/runs",
    {
      config: { permission: "runs:trigger", auditAction: "run.started" },
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
      const agent = await resolveRunAgentDef(p.orgId, projectId, body);
      const run = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId: p.orgId,
            projectId,
            agentDefId: agent.id,
            mode: body.mode,
            engine: body.engine,
            trigger: body.trigger ?? {},
            createdBy: { type: p.type, id: p.id },
          })
          .returning()
      )[0];
      if (run) {
        await db.insert(runEvents).values({
          orgId: p.orgId,
          runId: run.id,
          seq: 1,
          type: "queued",
          data: { queue: "runs.dispatch" },
        });
        await app.enqueue("runs.dispatch", { runId: run.id, orgId: p.orgId });
      }
      return run && redactRunSecrets(run);
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
      const row = (
        await db
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
      if (!row) return redactRunSecrets(existing);
      // cancelRun needs the raw sandbox (driver ref + key ids); redact only the
      // response copy — redactRunSecrets returns a fresh object, leaving row intact.
      await cancelRun(config, row);
      return redactRunSecrets(row);
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
        querystring: z.object({ afterSeq: z.coerce.number().optional() }),
        response: { 200: z.array(RunEventSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const { runId } = request.params as { runId: string };
      const { afterSeq = 0 } = request.query as { afterSeq?: number };
      await loadRun(p, runId);
      return withOrg(db, p.orgId).runEvents.listAfter(runId, afterSeq);
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
          idleMs: z.coerce.number().int().min(50).max(25_000).optional(),
        }),
      },
    },
    async (request, reply) => {
      const p = principal(request);
      const { runId } = request.params as { runId: string };
      const { afterSeq = 0, idleMs = 25_000 } = request.query as {
        afterSeq?: number;
        idleMs?: number;
      };
      await loadRun(p, runId);
      await streamRunEvents(config, reply, runId, afterSeq, idleMs, async (seq) =>
        withOrg(db, p.orgId).runEvents.listAfter(runId, seq, 10),
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
        response: { 200: AnyObject },
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
            body: (request.body as { body: string }).body,
          })
          .returning()
      )[0];
      // Route through appendRunEvents so the seq allocation shares the per-run
      // advisory lock (and NOTIFY) with the runner's high-frequency ingest — no
      // duplicate-key race between a steer and a concurrent event batch.
      await appendRunEvents(db, p.orgId, runId, [
        { type: "steer", data: { text: (request.body as { body: string }).body, author: p.id } },
      ]);
      return message;
    },
  );
}

async function streamRunEvents(
  config: AppConfig,
  reply: FastifyReply,
  runId: string,
  afterSeq: number,
  idleMs: number,
  load: (afterSeq: number) => Promise<unknown[]>,
) {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const write = (event: string, data: unknown) =>
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  write("heartbeat", { ts: new Date().toISOString() });
  let cursor = afterSeq;
  const writeEvents = async (events: unknown[]) => {
    for (const event of events) {
      write("run_event", event);
      const seq =
        typeof event === "object" && event !== null ? (event as { seq?: unknown }).seq : undefined;
      if (typeof seq === "number" && seq > cursor) cursor = seq;
    }
  };
  await writeEvents(await load(cursor));
  if (idleMs <= 1_000) {
    const poll = setInterval(() => {
      void (async () => {
        await writeEvents(await load(cursor));
      })();
    }, 100);
    await new Promise((resolve) => setTimeout(resolve, idleMs));
    clearInterval(poll);
    reply.raw.end();
    return;
  }
  const sqlClient = postgres(config.databaseUrl, { max: 1 });
  let done = false;
  const close = () => {
    done = true;
  };
  reply.raw.on("close", close);
  let unlisten: { unlisten: () => Promise<void> } | undefined;
  let safetyRefresh: NodeJS.Timeout | undefined;
  try {
    try {
      unlisten = await sqlClient.listen(`run_events:${runId}`, async () => {
        await writeEvents(await load(cursor));
      });
    } catch {
      await writeEvents(await load(cursor));
    }
    safetyRefresh = setInterval(() => {
      void (async () => {
        await writeEvents(await load(cursor));
      })();
    }, 25_000);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, idleMs);
      reply.raw.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (!done) reply.raw.end();
    void unlisten?.unlisten().catch(() => undefined);
  } finally {
    if (safetyRefresh) clearInterval(safetyRefresh);
    reply.raw.off("close", close);
    void sqlClient.end().catch(() => undefined);
  }
}
