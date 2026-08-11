import { generateApiKey, newId, normalizeClaudeCodeOAuthToken, seal } from "@facility/core";
import { budgets, providerCredentials, virtualKeys } from "@facility/db";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertBudgetAgentInProject, resolveBudgetScope } from "../../budget-scope.js";
import { ApiError, notFound } from "../../errors.js";
import type { Principal } from "../../types.js";
import {
  assertBareRowProjectScope,
  assertProjectScope,
  BudgetSchema,
  CreatedVirtualKeySchema,
  definedFields,
  IdParams,
  IsoDateTime,
  Ok,
  PageQuery,
  type PageQueryValue,
  ProviderPublicSchema,
  principal,
  publicRow,
  SpendRowSchema,
  assertProjectInOrg as sharedAssertProjectInOrg,
  type V1RouteContext,
  VirtualKeyPublicSchema,
  validateApiProviderBaseUrl,
} from "./shared.js";

export async function registerProvidersBudgetsSpendRoutes(
  app: FastifyInstance,
  context: V1RouteContext,
) {
  const { db, config } = context;
  const assertProjectInOrg = (
    p: Principal,
    projectId: string | null | undefined,
    statusCode?: number,
  ) => sharedAssertProjectInOrg(db, p, projectId, statusCode);
  app.get(
    "/v1/providers",
    {
      config: { permission: "providers:read", orgAdmin: true },
      schema: { querystring: PageQuery, response: { 200: z.array(ProviderPublicSchema) } },
    },
    async (request) => {
      const p = principal(request);
      const query = request.query as PageQueryValue;
      return (
        await db
          .select()
          .from(providerCredentials)
          .where(eq(providerCredentials.orgId, p.orgId))
          .orderBy(asc(providerCredentials.provider), asc(providerCredentials.name))
          .limit(query.limit)
          .offset(query.offset)
      ).map((row) => ({
        id: row.id,
        provider: row.provider,
        name: row.name,
        authMode: row.authMode,
        baseUrl: row.baseUrl,
        createdAt: row.createdAt,
      }));
    },
  );

  app.post(
    "/v1/providers",
    {
      config: { permission: "providers:write", auditAction: "provider.created", orgAdmin: true },
      schema: {
        body: z.object({
          provider: z.enum(["anthropic", "openai"]),
          name: z.string().trim().min(1),
          authMode: z.enum(["api_key", "oauth"]).default("api_key"),
          baseUrl: z.string().optional(),
          secret: z.string().min(1),
        }),
        response: { 200: ProviderPublicSchema.nullable() },
      },
    },
    async (request) => {
      const p = principal(request);
      const body = request.body as {
        provider: "anthropic" | "openai";
        name: string;
        authMode?: "api_key" | "oauth";
        baseUrl?: string;
        secret: string;
      };
      const authMode = body.authMode ?? "api_key";
      if (authMode === "oauth" && body.provider !== "anthropic") {
        throw new ApiError(
          400,
          "oauth_provider_unsupported",
          "Claude Code OAuth is only supported for the Anthropic provider",
        );
      }
      if (authMode === "oauth" && body.baseUrl) {
        throw new ApiError(
          400,
          "oauth_base_url_forbidden",
          "Claude Code OAuth credentials can only be sent to Anthropic's default API URL",
        );
      }
      const secret =
        authMode === "oauth" ? normalizeClaudeCodeOAuthToken(body.secret) : body.secret;
      if (!secret) {
        throw new ApiError(
          400,
          "invalid_provider_secret",
          "Claude Code OAuth token is malformed; paste the output from `claude setup-token`",
        );
      }
      const baseUrl = body.baseUrl
        ? await validateApiProviderBaseUrl(body.baseUrl, config.facilityInsecureDev)
        : undefined;
      const sealedSecret = await seal(secret, config.secretMasterKey);
      const row = (
        await db
          .insert(providerCredentials)
          .values({
            id: newId("prov"),
            orgId: p.orgId,
            provider: body.provider,
            name: body.name,
            authMode,
            baseUrl,
            sealedSecret,
            createdBy: p.id,
          })
          .returning()
      )[0];
      // Push-invalidate the gateway provider-credential cache so a newly added
      // (or first-ever, replacing the dev fallback) credential is used
      // immediately, not after the gateway's 60s TTL.
      await db
        .execute(
          sql`select pg_notify('facility_provider_changed', ${`${p.orgId}:${body.provider}`})`,
        )
        .catch(() => undefined);
      return row
        ? {
            id: row.id,
            provider: row.provider,
            name: row.name,
            authMode: row.authMode,
            baseUrl: row.baseUrl,
            createdAt: row.createdAt,
          }
        : null;
    },
  );

  app.delete(
    "/v1/providers/:providerId",
    {
      config: { permission: "providers:write", auditAction: "provider.deleted", orgAdmin: true },
      schema: { params: z.object({ providerId: z.string() }), response: { 200: Ok } },
    },
    async (request) => {
      const p = principal(request);
      const removed = await db
        .delete(providerCredentials)
        .where(
          and(
            eq(providerCredentials.orgId, p.orgId),
            eq(providerCredentials.id, (request.params as { providerId: string }).providerId),
          ),
        )
        .returning({ provider: providerCredentials.provider });
      // Push-invalidate the gateway provider-credential cache: a removed secret
      // (or a fail-over to the next-oldest credential for this provider) must
      // take effect now, not after the 60s TTL. Mirrors the key-revoke NOTIFY.
      for (const row of removed) {
        await db
          .execute(
            sql`select pg_notify('facility_provider_changed', ${`${p.orgId}:${row.provider}`})`,
          )
          .catch(() => undefined);
      }
      return { ok: true };
    },
  );

  app.post(
    "/v1/projects/:projectId/virtual-keys",
    {
      config: { permission: "keys:issue", auditAction: "key.issued" },
      schema: {
        params: IdParams,
        body: z.object({
          name: z.string(),
          allowedModels: z.array(z.string()).optional(),
          expiresAt: IsoDateTime.optional(),
        }),
        response: { 200: CreatedVirtualKeySchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      const body = request.body as { name: string; allowedModels?: string[]; expiresAt?: string };
      // Verify the project is in the principal's org (not just scope): an org
      // admin could otherwise mint a key with a foreign project's id, producing a
      // mismatched org/project row the gateway then trusts.
      await sharedAssertProjectInOrg(db, p, projectId);
      const key = await generateApiKey("fvk");
      const row = (
        await db
          .insert(virtualKeys)
          .values({
            id: key.id,
            orgId: p.orgId,
            projectId,
            name: body.name,
            prefix: key.lookup,
            last4: key.last4,
            hash: key.hash,
            allowedModels: body.allowedModels,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
          })
          .returning()
      )[0];
      return { ...publicRow(row ?? {}), secret: key.secret };
    },
  );

  app.get(
    "/v1/projects/:projectId/virtual-keys",
    {
      config: { permission: "keys:issue" },
      schema: {
        params: IdParams,
        querystring: PageQuery,
        response: { 200: z.array(VirtualKeyPublicSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      const query = request.query as PageQueryValue;
      assertProjectScope(p, projectId);
      return (
        await db
          .select()
          .from(virtualKeys)
          .where(and(eq(virtualKeys.orgId, p.orgId), eq(virtualKeys.projectId, projectId)))
          .orderBy(desc(virtualKeys.createdAt), desc(virtualKeys.id))
          .limit(query.limit)
          .offset(query.offset)
      ).map(publicRow);
    },
  );

  app.delete(
    "/v1/projects/:projectId/virtual-keys/:keyId",
    {
      config: { permission: "keys:issue", auditAction: "key.revoked" },
      schema: {
        params: z.object({ projectId: z.string(), keyId: z.string() }),
        response: { 200: Ok },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId, keyId } = request.params as { projectId: string; keyId: string };
      assertProjectScope(p, projectId);
      const revoked = await db
        .update(virtualKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(virtualKeys.orgId, p.orgId),
            eq(virtualKeys.projectId, projectId),
            eq(virtualKeys.id, keyId),
            isNull(virtualKeys.revokedAt),
          ),
        )
        .returning({ prefix: virtualKeys.prefix });
      // Push-invalidate the gateway key cache immediately, exactly like run-key
      // revocation — a manually revoked key must stop working now, not after the
      // gateway's cache TTL.
      for (const row of revoked) {
        await db
          .execute(sql`select pg_notify('facility_key_revoked', ${row.prefix})`)
          .catch(() => undefined);
      }
      return { ok: true };
    },
  );

  app.get(
    "/v1/budgets",
    {
      config: { permission: "budgets:read" },
      schema: { querystring: PageQuery, response: { 200: z.array(BudgetSchema) } },
    },
    async (request) => {
      const p = principal(request);
      const query = request.query as PageQueryValue;
      const clauses = [eq(budgets.orgId, p.orgId)];
      if (p.projectId) clauses.push(eq(budgets.projectId, p.projectId));
      return db
        .select()
        .from(budgets)
        .where(and(...clauses))
        .orderBy(desc(budgets.createdAt), desc(budgets.id))
        .limit(query.limit)
        .offset(query.offset);
    },
  );
  app.post(
    "/v1/budgets",
    {
      config: { permission: "budgets:write", auditAction: "budget.created" },
      schema: {
        body: z.object({
          // Enum-bound to exactly what the gateway enforces — an unrecognized
          // scope/period/mode would store a budget the runtime silently ignores.
          scope: z.enum(["org", "project", "agent_def"]),
          projectId: z.string().optional(),
          agentDefId: z.string().optional(),
          period: z.enum(["daily", "weekly", "monthly"]),
          limitCents: z.number().int().nonnegative(),
          mode: z.enum(["soft", "hard"]),
          enabled: z.boolean().default(true),
        }),
        response: { 200: BudgetSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const body = request.body as {
        scope: "org" | "project" | "agent_def";
        projectId?: string;
        agentDefId?: string;
        period: "daily" | "weekly" | "monthly";
        limitCents: number;
        mode: "soft" | "hard";
        enabled: boolean;
      };
      // Centralized scope coherence + authorization (shared with PATCH + the HITL
      // executor): org budgets null their project/agent, project/agent budgets
      // require a project, agent budgets require an agent def, and a project-scoped
      // principal can't create an org-wide budget.
      const resolved = resolveBudgetScope({
        scope: body.scope,
        projectId: body.projectId,
        agentDefId: body.agentDefId,
        principalProjectId: p.projectId ?? null,
      });
      await assertProjectInOrg(p, resolved.projectId);
      if (resolved.scope === "agent_def" && resolved.projectId && resolved.agentDefId) {
        await assertBudgetAgentInProject(db, p.orgId, resolved.projectId, resolved.agentDefId);
      }
      return (
        await db
          .insert(budgets)
          .values({
            id: newId("bud"),
            orgId: p.orgId,
            scope: resolved.scope,
            projectId: resolved.projectId,
            agentDefId: resolved.agentDefId,
            period: body.period,
            limitCents: body.limitCents,
            mode: body.mode,
            enabled: body.enabled,
          })
          .returning()
      )[0];
    },
  );

  async function loadBudget(p: Principal, budgetId: string) {
    const budget = (
      await db
        .select()
        .from(budgets)
        .where(and(eq(budgets.orgId, p.orgId), eq(budgets.id, budgetId)))
        .limit(1)
    )[0];
    if (!budget) throw notFound("Budget not found");
    assertBareRowProjectScope(p, budget.projectId, "Budget not found");
    return budget;
  }

  app.get(
    "/v1/budgets/:budgetId",
    {
      config: { permission: "budgets:read" },
      schema: { params: z.object({ budgetId: z.string() }), response: { 200: BudgetSchema } },
    },
    async (request) => {
      const p = principal(request);
      return loadBudget(p, (request.params as { budgetId: string }).budgetId);
    },
  );

  app.patch(
    "/v1/budgets/:budgetId",
    {
      config: { permission: "budgets:write", auditAction: "budget.updated" },
      schema: {
        params: z.object({ budgetId: z.string() }),
        // Same enum/positive-limit invariants as create — PATCH must not be a
        // back door to an unenforceable or org-wide budget.
        body: z.object({
          scope: z.enum(["org", "project", "agent_def"]).optional(),
          projectId: z.string().optional(),
          agentDefId: z.string().optional(),
          period: z.enum(["daily", "weekly", "monthly"]).optional(),
          limitCents: z.number().int().nonnegative().optional(),
          mode: z.enum(["soft", "hard"]).optional(),
          enabled: z.boolean().optional(),
        }),
        response: { 200: BudgetSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { budgetId } = request.params as { budgetId: string };
      const body = request.body as {
        scope?: "org" | "project" | "agent_def";
        projectId?: string;
        agentDefId?: string;
        period?: "daily" | "weekly" | "monthly";
        limitCents?: number;
        mode?: "soft" | "hard";
        enabled?: boolean;
      };
      await loadBudget(p, budgetId);
      // scope/project/agent are only mutable together, through the shared resolver:
      // widening to org nulls the project (so it becomes a true org budget the
      // project owner can no longer touch) and is refused for a project principal.
      // Other fields update independently.
      const resolved =
        body.scope === undefined
          ? undefined
          : resolveBudgetScope({
              scope: body.scope,
              projectId: body.projectId,
              agentDefId: body.agentDefId,
              principalProjectId: p.projectId ?? null,
            });
      if (resolved) await assertProjectInOrg(p, resolved.projectId);
      if (resolved?.scope === "agent_def" && resolved.projectId && resolved.agentDefId) {
        await assertBudgetAgentInProject(db, p.orgId, resolved.projectId, resolved.agentDefId);
      }
      return (
        await db
          .update(budgets)
          .set({
            ...definedFields({
              period: body.period,
              limitCents: body.limitCents,
              mode: body.mode,
              enabled: body.enabled,
              updatedAt: new Date(),
            }),
            ...(resolved
              ? {
                  scope: resolved.scope,
                  projectId: resolved.projectId,
                  agentDefId: resolved.agentDefId,
                }
              : {}),
          })
          // The project-scope guard is on the mutation predicate itself (not just
          // the loadBudget preflight), so a concurrent scope/project change can't
          // let a project-scoped principal mutate a row that stopped belonging to
          // its project between the read and the write.
          .where(
            and(
              eq(budgets.orgId, p.orgId),
              eq(budgets.id, budgetId),
              p.projectId ? eq(budgets.projectId, p.projectId) : undefined,
            ),
          )
          .returning()
      )[0];
    },
  );
  app.delete(
    "/v1/budgets/:budgetId",
    {
      config: { permission: "budgets:write", auditAction: "budget.deleted" },
      schema: { params: z.object({ budgetId: z.string() }), response: { 200: Ok } },
    },
    async (request) => {
      const p = principal(request);
      const { budgetId } = request.params as { budgetId: string };
      await loadBudget(p, budgetId);
      await db
        .delete(budgets)
        .where(
          and(
            eq(budgets.orgId, p.orgId),
            eq(budgets.id, budgetId),
            p.projectId ? eq(budgets.projectId, p.projectId) : undefined,
          ),
        );
      return { ok: true };
    },
  );

  app.get(
    "/v1/spend",
    {
      config: { permission: "spend:read" },
      schema: {
        querystring: PageQuery.extend({
          projectId: z.string().optional(),
          from: IsoDateTime.optional(),
          to: IsoDateTime.optional(),
          groupBy: z.enum(["model", "agent", "task", "day"]).optional(),
        }),
        response: { 200: z.array(SpendRowSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const q = request.query as {
        projectId?: string;
        from?: string;
        to?: string;
        groupBy?: "model" | "agent" | "task" | "day";
      } & PageQueryValue;
      // Normalize explicit values exactly as before; only implicit bounds move
      // to the database clock.
      const from = q.from ? new Date(q.from).toISOString() : null;
      const to = q.to ? new Date(q.to).toISOString() : null;
      // Defaults must use the database clock because created_at defaults do.
      // PostgreSQL keeps microseconds that JavaScript Date would truncate.
      const upperBound = sql`coalesce(${to}::timestamptz, current_timestamp)`;
      const lowerBound = sql`coalesce(${from}::timestamptz, ${upperBound} - interval '720 hours')`;
      await assertProjectInOrg(p, q.projectId);
      const projectId = p.projectId ?? q.projectId;
      const groupExpr =
        q.groupBy === "day"
          ? sql`date_trunc('day', created_at)::text`
          : q.groupBy === "agent"
            ? sql`coalesce(agent_def_id, 'none')`
            : q.groupBy === "task"
              ? sql`coalesce(task_id, 'none')`
              : sql`model`;
      const result = projectId
        ? await db.execute(
            sql`SELECT ${groupExpr} AS bucket, floor(coalesce(sum(cost_cents), 0) + 0.5)::int AS cost_cents FROM llm_requests WHERE org_id = ${p.orgId} AND project_id = ${projectId} AND created_at >= ${lowerBound} AND created_at <= ${upperBound} GROUP BY 1 ORDER BY 1 LIMIT ${q.limit} OFFSET ${q.offset}`,
          )
        : await db.execute(
            sql`SELECT ${groupExpr} AS bucket, floor(coalesce(sum(cost_cents), 0) + 0.5)::int AS cost_cents FROM llm_requests WHERE org_id = ${p.orgId} AND created_at >= ${lowerBound} AND created_at <= ${upperBound} GROUP BY 1 ORDER BY 1 LIMIT ${q.limit} OFFSET ${q.offset}`,
          );
      return Array.from(result as Iterable<Record<string, unknown>>);
    },
  );
}
