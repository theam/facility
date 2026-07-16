import { auditEvents, llmRequests, outcomes, platformIssues, verifyAuditChain } from "@facility/db";
import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readEnvelopeObject } from "../../envelopes.js";
import { ApiError, notFound } from "../../errors.js";
import { analyticsOverview, queryAnalytics } from "../../watchtower/analytics.js";
import {
  AnalyticsOverviewSchema,
  AnalyticsRowSchema,
  AuditEventSchema,
  assertBareRowProjectScope,
  assertProjectScope,
  IsoDateTime,
  IssueIdParams,
  LlmRequestSchema,
  OutcomeSchema,
  PageQuery,
  type PageQueryValue,
  PlatformIssueSchema,
  principal,
  type V1RouteContext,
} from "./shared.js";

export async function registerAnalyticsRoutes(app: FastifyInstance, context: V1RouteContext) {
  const { db } = context;
  app.get(
    "/v1/analytics",
    {
      config: { permission: "analytics:read" },
      schema: {
        querystring: PageQuery.extend({
          projectId: z.string().optional(),
          from: IsoDateTime.optional(),
          to: IsoDateTime.optional(),
          groupBy: z.enum(["day", "agent", "model"]).default("day"),
        }),
        response: { 200: z.array(AnalyticsRowSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const q = request.query as {
        projectId?: string;
        from?: string;
        to?: string;
        groupBy: "day" | "agent" | "model";
      } & PageQueryValue;
      assertProjectScope(p, q.projectId);
      return queryAnalytics(db, p.orgId, { ...q, projectId: p.projectId ?? q.projectId });
    },
  );

  app.get(
    "/v1/analytics/overview",
    {
      config: { permission: "analytics:read" },
      schema: { querystring: PageQuery, response: { 200: AnalyticsOverviewSchema } },
    },
    async (request) => {
      const p = principal(request);
      const query = request.query as PageQueryValue;
      return analyticsOverview(db, p.orgId, p.projectId ?? undefined, query);
    },
  );
}

export async function registerIssuesAuditRoutes(app: FastifyInstance, context: V1RouteContext) {
  const { db } = context;
  app.get(
    "/v1/issues",
    {
      config: { permission: "issues:read" },
      schema: {
        querystring: PageQuery.extend({
          state: z.string().optional(),
          kind: z.string().optional(),
        }),
        response: { 200: z.array(PlatformIssueSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const q = request.query as PageQueryValue & { state?: string; kind?: string };
      const clauses = [eq(platformIssues.orgId, p.orgId)];
      if (q.state) clauses.push(eq(platformIssues.state, q.state));
      if (q.kind) clauses.push(eq(platformIssues.kind, q.kind));
      if (p.projectId) clauses.push(eq(platformIssues.projectId, p.projectId));
      return db
        .select()
        .from(platformIssues)
        .where(and(...clauses))
        .orderBy(desc(platformIssues.lastSeen), desc(platformIssues.id))
        .limit(q.limit)
        .offset(q.offset);
    },
  );

  for (const action of ["ack", "resolve"] as const) {
    app.post(
      `/v1/issues/:issueId/${action}`,
      {
        config: {
          permission: "issues:write",
          auditAction: action === "ack" ? "issue.acked" : "issue.resolved",
        },
        schema: { params: IssueIdParams, response: { 200: PlatformIssueSchema } },
      },
      async (request) => {
        const p = principal(request);
        const { issueId } = request.params as { issueId: string };
        const issue = (
          await db
            .select()
            .from(platformIssues)
            .where(and(eq(platformIssues.orgId, p.orgId), eq(platformIssues.id, issueId)))
            .limit(1)
        )[0];
        if (!issue) throw notFound("Issue not found");
        assertBareRowProjectScope(p, issue.projectId, "Issue not found");
        // Valid transitions: ack moves open → acked; resolve moves open/acked →
        // resolved. Re-issuing the terminal state is idempotent.
        const target = action === "ack" ? "acked" : "resolved";
        const allowedFrom = action === "ack" ? ["open"] : ["open", "acked"];
        if (issue.state === target) return issue;
        if (!allowedFrom.includes(issue.state)) {
          throw new ApiError(
            409,
            "invalid_transition",
            `Cannot ${action} an issue in state "${issue.state}".`,
          );
        }
        // Pin the update to the allowed prior state (so a concurrent transition
        // cannot be clobbered — e.g. ack racing a resolve) AND to the project we
        // just scope-checked (so a concurrent fingerprint-driven project move
        // can't slip the row out from under the authorization). 0 rows updated
        // means the row moved under us — reconcile from the current row.
        const [updated] = await db
          .update(platformIssues)
          .set({ state: target, updatedAt: new Date() })
          .where(
            and(
              eq(platformIssues.orgId, p.orgId),
              eq(platformIssues.id, issueId),
              issue.projectId ? eq(platformIssues.projectId, issue.projectId) : undefined,
              inArray(platformIssues.state, allowedFrom),
            ),
          )
          .returning();
        if (updated) return updated;
        const current = (
          await db
            .select()
            .from(platformIssues)
            .where(and(eq(platformIssues.orgId, p.orgId), eq(platformIssues.id, issueId)))
            .limit(1)
        )[0];
        if (current?.state === target) return current;
        throw new ApiError(409, "invalid_transition", "Issue state changed concurrently.");
      },
    );
  }

  app.get(
    "/v1/audit",
    {
      config: { permission: "audit:read" },
      schema: {
        querystring: z.object({
          from: z.coerce.number().optional(),
          to: z.coerce.number().optional(),
          // Wall-clock window — the seq-based from/to stay for chain slicing.
          createdFrom: z.string().datetime({ offset: true }).optional(),
          createdTo: z.string().datetime({ offset: true }).optional(),
          projectId: z.string().optional(),
          actor: z.string().optional(),
          action: z.string().optional(),
          actionPrefix: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
          cursor: z.coerce.number().optional(),
        }),
        response: {
          200: z.object({ items: z.array(AuditEventSchema), nextCursor: z.number().nullable() }),
        },
      },
    },
    async (request) => {
      const p = principal(request);
      const q = request.query as {
        from?: number;
        to?: number;
        createdFrom?: string;
        createdTo?: string;
        projectId?: string;
        actor?: string;
        action?: string;
        actionPrefix?: string;
        limit?: number;
        cursor?: number;
      };
      const limit = Math.min(Math.max(Number(q.limit ?? 200), 1), 500);
      const clauses = [eq(auditEvents.orgId, p.orgId)];
      if (p.projectId) clauses.push(eq(auditEvents.projectId, p.projectId));
      // A requested project filter never widens a project-scoped principal —
      // the clamp above still applies; for org principals it narrows the view.
      if (q.projectId) {
        assertProjectScope(p, q.projectId);
        clauses.push(eq(auditEvents.projectId, q.projectId));
      }
      if (q.from) clauses.push(gte(auditEvents.seq, q.from));
      if (q.to) clauses.push(lte(auditEvents.seq, q.to));
      if (q.createdFrom) clauses.push(gte(auditEvents.createdAt, new Date(q.createdFrom)));
      if (q.createdTo) clauses.push(lte(auditEvents.createdAt, new Date(q.createdTo)));
      if (q.cursor) clauses.push(lt(auditEvents.seq, q.cursor));
      if (q.action) clauses.push(eq(auditEvents.action, q.action));
      if (q.actionPrefix && !q.action) {
        clauses.push(sql`${auditEvents.action} like ${`${q.actionPrefix.replaceAll("%", "")}%`}`);
      }
      if (q.actor) {
        const [actorType, actorId] = q.actor.includes(":") ? q.actor.split(":", 2) : [];
        if (actorType && actorId) {
          clauses.push(
            sql`${auditEvents.actor}->>'type' = ${actorType} AND ${auditEvents.actor}->>'id' = ${actorId}`,
          );
        } else {
          clauses.push(sql`${auditEvents.actor}->>'id' = ${q.actor}`);
        }
      }
      const rows = await db
        .select()
        .from(auditEvents)
        .where(and(...clauses))
        .orderBy(desc(auditEvents.seq))
        .limit(limit + 1);
      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor: rows.length > limit ? (items.at(-1)?.seq ?? null) : null,
      };
    },
  );

  // PR-level outcomes as a first-class list: the inbox's "PRs awaiting review"
  // and overview boards read open agent PRs from here (rows are written at
  // PR-open by the platform lane and at PR-close by the webhook collector).
  app.get(
    "/v1/outcomes",
    {
      config: { permission: "runs:read" },
      schema: {
        querystring: z.object({
          projectId: z.string().optional(),
          state: z.enum(["open", "terminal", "all"]).default("open"),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: z.array(OutcomeSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const q = request.query as {
        projectId?: string;
        state: "open" | "terminal" | "all";
        limit: number;
      };
      assertProjectScope(p, q.projectId);
      const projectId = p.projectId ?? q.projectId;
      const clauses = [eq(outcomes.orgId, p.orgId)];
      if (projectId) clauses.push(eq(outcomes.projectId, projectId));
      if (q.state === "open") clauses.push(sql`${outcomes.terminalAt} is null`);
      if (q.state === "terminal") clauses.push(sql`${outcomes.terminalAt} is not null`);
      const rows = await db
        .select()
        .from(outcomes)
        .where(and(...clauses))
        .orderBy(desc(outcomes.openedAt))
        .limit(q.limit);
      return rows.map((row) => ({
        ...row,
        hoursToTerminal: row.hoursToTerminal === null ? null : Number(row.hoursToTerminal),
      }));
    },
  );

  app.get(
    "/v1/llm-requests",
    {
      config: { permission: "spend:read" },
      schema: {
        querystring: z.object({
          projectId: z.string().optional(),
          from: IsoDateTime.optional(),
          to: IsoDateTime.optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          cursor: IsoDateTime.optional(),
        }),
        response: {
          200: z.object({ items: z.array(LlmRequestSchema), nextCursor: z.string().nullable() }),
        },
      },
    },
    async (request) => {
      const p = principal(request);
      const q = request.query as {
        projectId?: string;
        from?: string;
        to?: string;
        limit?: number;
        cursor?: string;
      };
      assertProjectScope(p, q.projectId);
      const projectId = p.projectId ?? q.projectId;
      const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 500);
      const clauses = [eq(llmRequests.orgId, p.orgId)];
      if (projectId) clauses.push(eq(llmRequests.projectId, projectId));
      if (q.from) clauses.push(gte(llmRequests.createdAt, new Date(q.from)));
      if (q.to) clauses.push(lte(llmRequests.createdAt, new Date(q.to)));
      if (q.cursor) clauses.push(lt(llmRequests.createdAt, new Date(q.cursor)));
      const rows = await db
        .select()
        .from(llmRequests)
        .where(and(...clauses))
        .orderBy(desc(llmRequests.createdAt))
        .limit(limit + 1);
      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor: rows.length > limit ? (items.at(-1)?.createdAt?.toISOString() ?? null) : null,
      };
    },
  );

  app.get(
    "/v1/llm-requests/:requestId/envelope",
    {
      // The envelope is the full request/response transcript — audit-grade, not
      // spend data. `spend:read` (cost dashboards) must NOT see it; require the
      // stricter `audit:read` even though the row's cost fields are spend-visible.
      config: { permission: "audit:read" },
      schema: {
        params: z.object({ requestId: z.string() }),
        response: { 200: z.object({ llmRequest: LlmRequestSchema, envelope: z.unknown() }) },
      },
    },
    async (request) => {
      const p = principal(request);
      const { requestId } = request.params as { requestId: string };
      const row = (
        await db
          .select()
          .from(llmRequests)
          .where(and(eq(llmRequests.orgId, p.orgId), eq(llmRequests.id, requestId)))
          .limit(1)
      )[0];
      if (!row) throw notFound("LLM request not found");
      assertBareRowProjectScope(p, row.projectId, "LLM request not found");
      return {
        llmRequest: row,
        envelope: await readEnvelopeObject(
          context.config,
          row.responseUri ?? row.requestUri,
          row.orgId,
        ),
      };
    },
  );

  app.get(
    "/v1/audit/verify",
    {
      config: { permission: "audit:read" },
      schema: {
        querystring: z.object({}),
        response: { 200: z.object({ ok: z.boolean(), firstBreakSeq: z.number().nullable() }) },
      },
    },
    async (request) => verifyAuditChain(db, principal(request).orgId),
  );
}

export async function registerIssuesAuditAnalyticsRoutes(
  app: FastifyInstance,
  context: V1RouteContext,
) {
  await registerAnalyticsRoutes(app, context);
  await registerIssuesAuditRoutes(app, context);
}
