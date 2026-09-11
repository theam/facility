import { newId } from "@facility/core";
import { auditEvents, projectBudgets } from "@facility/db";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { GithubPipelineService } from "../../github/pipeline.js";
import { InsightsService } from "../../insights/overview.js";
import { AnyObject, DateValue, principal, type V1RouteContext } from "./shared.js";

const ProjectParams = z.object({ projectId: z.string() });
const DaysQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
const CostsQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const BudgetBody = z.object({
  monthly_limit_cents: z.number().int().min(0).max(2_000_000_000),
  warning_percent: z.number().int().min(1).max(100).default(80),
  enabled: z.boolean().default(true),
});
const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const BudgetResponse = z.object({
  id: z.string().nullable(),
  enabled: z.boolean(),
  monthly_limit_cents: z.number().nullable(),
  warning_percent: z.number().nullable(),
  window_start: DateValue,
  window_end: DateValue,
  spent_cents: z.number(),
  remaining_cents: z.number().nullable(),
  percent_used: z.number().nullable(),
  state: z.enum(["not_configured", "disabled", "ok", "warning", "exceeded"]),
  enforcement: z.literal("block_new_turns"),
});
const UsageSummary = z.object({
  turns: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costCents: z.number(),
  unpricedTurns: z.number(),
});
const TurnUsage = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  storyId: z.string(),
  turnId: z.string(),
  agentName: z.string(),
  engine: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costCents: z.number().nullable(),
  priced: z.boolean(),
  source: z.enum(["provider", "price_book", "unpriced"]),
  durationMs: z.number(),
  status: z.enum(["succeeded", "failed"]),
  createdAt: DateValue,
});
const CostsResponse = z.object({
  from: DateValue,
  to: DateValue,
  summary: UsageSummary,
  usage: z.array(TurnUsage),
});
const AuditEvent = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string().nullable(),
  actor: AnyObject,
  action: z.string(),
  target: AnyObject,
  payload: AnyObject,
  requestId: z.string().nullable(),
  createdAt: DateValue,
});
const ObservabilityUsage = UsageSummary.extend({ durationMs: z.number() });
const ObservabilityResponse = z.object({
  period: z.object({ from: DateValue, to: DateValue, days: z.number() }),
  health: z.enum(["healthy", "attention", "degraded"]),
  turns: z.object({
    total: z.number(),
    queued: z.number(),
    running: z.number(),
    succeeded: z.number(),
    failed: z.number(),
    canceled: z.number(),
    successRate: z.number().nullable(),
  }),
  usage: ObservabilityUsage,
  budget: z.object({
    id: z.string().nullable(),
    enabled: z.boolean(),
    monthlyLimitCents: z.number().nullable(),
    warningPercent: z.number().nullable(),
    windowStart: DateValue,
    windowEnd: DateValue,
    spentCents: z.number(),
    remainingCents: z.number().nullable(),
    percentUsed: z.number().nullable(),
    state: z.enum(["not_configured", "disabled", "ok", "warning", "exceeded"]),
    enforcement: z.literal("block_new_turns"),
  }),
  workspaces: z.object({
    total: z.number(),
    states: z.record(z.string(), z.number()),
    retained: z.number(),
  }),
  github: z.object({
    openIssues: z.number(),
    openPullRequests: z.number(),
    failedChecks: z.number(),
    webhookEvents: z.number(),
    failedWebhooks: z.number(),
  }),
  analytics: z.object({
    activeAgents: z.number(),
    mergedPullRequests: z.number(),
    ciEvidenceMerges: z.number(),
    ciEvidenceRate: z.number().nullable(),
    observedFirstPassMerges: z.number(),
    observedFirstPassRate: z.number().nullable(),
    averagePullRequestLeadTimeHours: z.number().nullable(),
  }),
  attention: z.object({ open: z.number() }),
  daily: z.array(
    z.object({
      day: z.string(),
      started: z.number(),
      succeeded: z.number(),
      failed: z.number(),
      costCents: z.number(),
      tokens: z.number(),
      mergedPullRequests: z.number(),
    }),
  ),
  byAgent: z.array(ObservabilityUsage.extend({ name: z.string() })),
  byModel: z.array(ObservabilityUsage.extend({ name: z.string() })),
  recentAudit: z.array(AuditEvent),
});
const PipelinePullRequest = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string().url(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  ciState: z.enum(["pending", "success", "failure"]).nullable(),
  ciFailureNames: z.array(z.string()),
  headSha: z.string(),
});
const PipelineStage = z.enum([
  "backlog",
  "planning",
  "building",
  "validating",
  "review",
  "shipped",
]);
const PipelineItem = z.object({
  key: z.string(),
  source: z.enum(["issue", "pull_request"]),
  number: z.number(),
  title: z.string(),
  url: z.string().url(),
  repository: z.string(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  updatedAt: DateValue,
  stage: PipelineStage,
  state: z.string(),
  story: z
    .object({
      id: z.string(),
      status: z.string(),
      activeAgentName: z.string().nullable(),
      branch: z.string().nullable(),
    })
    .nullable(),
  pullRequests: z.array(PipelinePullRequest),
});
const PipelineResponse = z.object({
  generatedAt: DateValue,
  counts: z.object({
    backlog: z.number(),
    planning: z.number(),
    building: z.number(),
    validating: z.number(),
    review: z.number(),
    shipped: z.number(),
  }),
  stages: z.object({
    backlog: z.array(PipelineItem),
    planning: z.array(PipelineItem),
    building: z.array(PipelineItem),
    validating: z.array(PipelineItem),
    review: z.array(PipelineItem),
    shipped: z.array(PipelineItem),
  }),
});
const SyncResponse = z.object({
  repositories: z.number(),
  issues: z.number(),
  pullRequests: z.number(),
  ciUpdates: z.number(),
});

export async function registerInsightsPipelineRoutes(
  app: FastifyInstance,
  context: V1RouteContext,
) {
  const { db } = context;
  const insights = new InsightsService(db, app.storyDomain.costs);
  const pipeline = new GithubPipelineService(db);

  app.get(
    "/v1/projects/:projectId/costs",
    {
      config: { permission: "costs:read" },
      schema: {
        params: ProjectParams,
        querystring: CostsQuery,
        response: { 200: CostsResponse },
        operationId: "getProjectCosts",
      },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId } = request.params as z.infer<typeof ProjectParams>;
      const query = request.query as z.infer<typeof CostsQuery>;
      const to = query.to ?? new Date();
      const from = query.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1_000);
      return app.storyDomain.costs.usage(actor.orgId, projectId, from, to, query.limit);
    },
  );

  app.get(
    "/v1/projects/:projectId/budget",
    {
      config: { permission: "budgets:read" },
      schema: {
        params: ProjectParams,
        response: { 200: BudgetResponse },
        operationId: "getProjectBudget",
      },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId } = request.params as z.infer<typeof ProjectParams>;
      const state = await app.storyDomain.costs.budgetState(actor.orgId, projectId);
      return presentBudget(state);
    },
  );

  app.patch(
    "/v1/projects/:projectId/budget",
    {
      config: { permission: "budgets:write", auditAction: "budget.updated", idempotent: true },
      schema: {
        params: ProjectParams,
        body: BudgetBody,
        response: { 200: BudgetResponse },
        operationId: "updateProjectBudget",
      },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId } = request.params as z.infer<typeof ProjectParams>;
      const body = request.body as z.infer<typeof BudgetBody>;
      await db
        .insert(projectBudgets)
        .values({
          id: newId("bud"),
          orgId: actor.orgId,
          projectId,
          monthlyLimitCents: body.monthly_limit_cents,
          warningPercent: body.warning_percent,
          enabled: body.enabled,
          updatedBy: actor.id,
        })
        .onConflictDoUpdate({
          target: projectBudgets.projectId,
          set: {
            monthlyLimitCents: body.monthly_limit_cents,
            warningPercent: body.warning_percent,
            enabled: body.enabled,
            updatedBy: actor.id,
            updatedAt: new Date(),
          },
        });
      return presentBudget(await app.storyDomain.costs.budgetState(actor.orgId, projectId));
    },
  );

  app.get(
    "/v1/projects/:projectId/observability",
    {
      config: { permission: "analytics:read" },
      schema: {
        params: ProjectParams,
        querystring: DaysQuery,
        response: { 200: ObservabilityResponse },
        operationId: "getProjectObservability",
      },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId } = request.params as z.infer<typeof ProjectParams>;
      const { days } = request.query as z.infer<typeof DaysQuery>;
      return insights.overview(actor.orgId, projectId, days);
    },
  );

  app.get(
    "/v1/projects/:projectId/pipeline",
    {
      config: { permission: "github:read" },
      schema: {
        params: ProjectParams,
        response: { 200: PipelineResponse },
        operationId: "getProjectPipeline",
      },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId } = request.params as z.infer<typeof ProjectParams>;
      return pipeline.get(actor.orgId, projectId);
    },
  );

  app.post(
    "/v1/projects/:projectId/github/sync",
    {
      config: { permission: "github:write", auditAction: "github.mirror_synced", idempotent: true },
      schema: {
        params: ProjectParams,
        response: { 200: SyncResponse },
        operationId: "syncProjectGithubMirror",
      },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId } = request.params as z.infer<typeof ProjectParams>;
      return app.storyDomain.mirror.syncProject(actor.orgId, projectId);
    },
  );

  app.get(
    "/v1/projects/:projectId/audit",
    {
      config: { permission: "audit:read" },
      schema: {
        params: ProjectParams,
        querystring: AuditQuery,
        response: { 200: z.object({ events: z.array(AuditEvent) }) },
        operationId: "listProjectAuditEvents",
      },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId } = request.params as z.infer<typeof ProjectParams>;
      const { limit } = request.query as z.infer<typeof AuditQuery>;
      return {
        events: await db
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.orgId, actor.orgId), eq(auditEvents.projectId, projectId)))
          .orderBy(desc(auditEvents.createdAt))
          .limit(limit),
      };
    },
  );
}

function presentBudget(
  state: Awaited<ReturnType<FastifyInstance["storyDomain"]["costs"]["budgetState"]>>,
) {
  return {
    id: state.budget?.id ?? null,
    enabled: state.budget?.enabled ?? false,
    monthly_limit_cents: state.budget?.monthlyLimitCents ?? null,
    warning_percent: state.budget?.warningPercent ?? null,
    window_start: state.windowStart,
    window_end: state.windowEnd,
    spent_cents: state.spentCents,
    remaining_cents: state.remainingCents,
    percent_used: state.percentUsed,
    state: state.state,
    enforcement: "block_new_turns",
  };
}
