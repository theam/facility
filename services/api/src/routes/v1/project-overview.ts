import {
  can,
  DecisionBriefProjectionSchema,
  DeliveryDecisionBriefProjectionSchema,
  DeliveryPullRequestSchema,
  PlanActorSchema,
  StoryDeliverySchema,
} from "@facility/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ATTENTION_STATUSES, ProjectAttentionService } from "../../insights/project-attention.js";
import { ProjectOverviewService, STORY_STATUSES } from "../../insights/project-overview.js";
import { DateValue, principal, type V1RouteContext } from "./shared.js";

const ProjectParams = z.object({ projectId: z.string() });
const StoryStatus = z.enum(STORY_STATUSES);
const StoryReference = z.object({
  storyId: z.string(),
  storyTitle: z.string(),
  storyStatus: StoryStatus,
});
const ActiveTurn = StoryReference.extend({
  turnId: z.string(),
  agentName: z.string(),
  engine: z.string(),
  model: z.string(),
  triggerType: z.string(),
  state: z.enum(["queued", "running"]),
  createdAt: DateValue,
  startedAt: DateValue.nullable(),
  scheduledFor: DateValue.nullable(),
});
const AttentionItem = StoryReference.extend({
  id: z.string(),
  turnId: z.string().nullable(),
  kind: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  createdAt: DateValue,
  action: z.enum(["reply", "retry", "dismiss"]),
});
const AttentionQuery = z.object({
  status: z.enum(ATTENTION_STATUSES).default("open"),
  kind: z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.flatMap((entry) => String(entry).split(","))
        : typeof value === "string"
          ? value.split(",")
          : value,
    z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  ),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
const AttentionNotice = AttentionItem.extend({
  status: z.enum(["open", "resolved"]),
  resolution: z.string().nullable(),
  resolvedAt: DateValue.nullable(),
  action: z.enum(["reply", "retry", "dismiss"]).nullable(),
});
export const ProjectAttentionResponse = z.object({
  generatedAt: DateValue,
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  counts: z.object({ open: z.number(), resolved: z.number() }),
  facets: z.object({ kinds: z.array(z.object({ kind: z.string(), count: z.number() })) }),
  items: z.array(AttentionNotice),
});
const AttentionStoriesQuery = z.object({
  category: z.enum(["all", "plans", "notices", "deliveries", "pulls"]).default("all"),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(25).default(10),
  offset: z.coerce.number().int().min(0).default(0),
  pullOffset: z.coerce.number().int().min(0).default(0),
});
const AttentionDelivery = z.object({
  decisionBrief: DeliveryDecisionBriefProjectionSchema.optional(),
  candidate: StoryDeliverySchema.shape.candidate,
  scopeRevision: z.number(),
  storyStatus: z.string(),
  pullRequests: z.array(
    DeliveryPullRequestSchema.pick({
      repository: true,
      number: true,
      url: true,
      title: true,
      required: true,
      primary: true,
      state: true,
      draft: true,
      headSha: true,
      stale: true,
      checks: true,
    }),
  ),
  acceptance: z.object({
    required: z.boolean().nullable(),
    status: z.enum(["missing", "current", "stale"]),
    receipt: z
      .object({
        id: z.string(),
        revision: z.number(),
        candidateRevision: z.string(),
        confirmedAt: DateValue,
        confirmedBy: PlanActorSchema.extend({ type: z.literal("user") }),
      })
      .nullable(),
  }),
  preview: z
    .object({
      state: z.string(),
      desiredGeneration: z.string(),
      deployedGeneration: z.string().nullable(),
      observedAt: DateValue,
    })
    .nullable(),
  acceptanceReady: z.boolean(),
  blocked: z.object({ code: z.string(), message: z.string() }).nullable(),
  waitingSince: DateValue,
});
export const ProjectAttentionStoriesResponse = z.object({
  generatedAt: DateValue,
  otherPullRequests: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    items: z.array(
      DeliveryPullRequestSchema.pick({
        repository: true,
        number: true,
        title: true,
        url: true,
        draft: true,
        headSha: true,
        stale: true,
        checks: true,
      }).extend({
        observedAt: DateValue,
        updatedAt: DateValue,
        stories: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            status: z.string(),
            relation: z.enum(["delivery", "source"]),
          }),
        ),
      }),
    ),
  }),
  total: z.number(),
  counts: z.object({
    stories: z.number(),
    plans: z.number(),
    notices: z.number(),
    deliveries: z.number(),
  }),
  workflowPolicy: z.object({ available: z.boolean(), error: z.string().nullable() }),
  budget: z.union([
    z.object({ available: z.literal(false), reason: z.literal("permission") }),
    z.object({
      available: z.literal(true),
      state: z.enum(["not_configured", "disabled", "ok", "warning", "exceeded", "unconfirmed"]),
      enabled: z.boolean(),
      monthlyLimitCents: z.number().nullable(),
      spentCents: z.number(),
      remainingCents: z.number().nullable(),
      windowStart: DateValue,
      windowEnd: DateValue,
    }),
  ]),
  limit: z.number(),
  offset: z.number(),
  items: z.array(
    StoryReference.extend({
      waitingSince: DateValue,
      noticeCount: z.number(),
      noticeKinds: z.array(z.object({ kind: z.string(), count: z.number() })),
      delivery: AttentionDelivery.nullable(),
      plan: z
        .object({
          revision: z.number(),
          digest: z.string(),
          proposedAt: DateValue,
          decisionBrief: DecisionBriefProjectionSchema,
        })
        .nullable(),
    }),
  ),
});
const ReviewItem = z.object({
  source: z.enum(["mirror", "story"]),
  storyId: z.string().nullable(),
  storyTitle: z.string().nullable(),
  storyStatus: StoryStatus.nullable(),
  activeAgentName: z.string().nullable(),
  pullRequest: z.object({
    number: z.number(),
    title: z.string(),
    url: z.string(),
    repository: z.string(),
    draft: z.boolean(),
    ciState: z.enum(["pending", "success", "failure"]).nullable(),
    ciFailureNames: z.array(z.string()),
    updatedAt: DateValue,
  }),
});
const RecentTurn = StoryReference.extend({
  turnId: z.string(),
  agentName: z.string(),
  state: z.enum(["succeeded", "failed", "canceled"]),
  triggerType: z.string(),
  endedAt: DateValue,
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  pullRequest: z.object({ number: z.number(), url: z.string() }).nullable(),
});
const BacklogStory = z.object({
  storyId: z.string(),
  title: z.string(),
  status: StoryStatus,
  provider: z.enum(["github", "manual", "schedule"]),
  externalId: z.string(),
  branch: z.string().nullable(),
  activeAgentName: z.string().nullable(),
  pullRequestNumber: z.number().nullable(),
  pullRequestUrl: z.string().nullable(),
  updatedAt: DateValue,
});
const UsageWindow = z.object({
  from: DateValue,
  to: DateValue,
  turns: z.number(),
  pricedTurns: z.number(),
  unpricedTurns: z.number(),
  unmeasuredTurns: z.number(),
  costCents: z.number(),
});
const Unavailable = z.object({ available: z.literal(false), reason: z.literal("permission") });
const AgentSpend = z.object({
  available: z.literal(true),
  month: UsageWindow,
  lastSevenDays: UsageWindow,
  byAgent: z.array(
    z.object({
      agentName: z.string(),
      turns: z.number(),
      unpricedTurns: z.number(),
      costCents: z.number(),
    }),
  ),
});
const BudgetSpend = z.object({
  available: z.literal(true),
  state: z.enum(["not_configured", "disabled", "ok", "warning", "exceeded", "unconfirmed"]),
  enabled: z.boolean(),
  monthlyLimitCents: z.number().nullable(),
  warningPercent: z.number().nullable(),
  windowStart: DateValue,
  windowEnd: DateValue,
  spentCents: z.number(),
  remainingCents: z.number().nullable(),
  percentUsed: z.number().nullable(),
});
export const ProjectOverviewResponse = z.object({
  generatedAt: DateValue,
  activity: z.object({ running: z.array(ActiveTurn), queued: z.array(ActiveTurn) }),
  attention: z.object({ openCount: z.number(), items: z.array(AttentionItem) }),
  review: z.object({ items: z.array(ReviewItem), total: z.number() }),
  recent: z.object({ items: z.array(RecentTurn) }),
  backlog: z.object({
    ready: z.array(BacklogStory),
    counts: z.object(
      Object.fromEntries(STORY_STATUSES.map((status) => [status, z.number()])) as Record<
        (typeof STORY_STATUSES)[number],
        z.ZodNumber
      >,
    ),
    openIssues: z.number(),
    openIssuesWithoutStory: z.number(),
  }),
  environments: z.object({
    retained: z.number(),
    recorded: z.object({
      creating: z.number(),
      running: z.number(),
      sleeping: z.number(),
      error: z.number(),
      deleting: z.number(),
    }),
    lastActivityAt: DateValue.nullable(),
  }),
  spend: z.object({
    agents: z.union([AgentSpend, Unavailable]),
    budget: z.union([BudgetSpend, Unavailable]),
  }),
});

export async function registerProjectOverviewRoutes(app: FastifyInstance, context: V1RouteContext) {
  const service = new ProjectOverviewService(context.db, app.storyDomain.costs);
  const attention = new ProjectAttentionService(context.db);

  app.get(
    "/v1/projects/:projectId/attention/stories",
    {
      config: { permission: "projects:read" },
      schema: {
        params: ProjectParams,
        querystring: AttentionStoriesQuery,
        response: { 200: ProjectAttentionStoriesResponse },
        operationId: "listProjectAttentionStories",
      },
    },
    async (request, reply) => {
      const actor = principal(request);
      const { projectId } = request.params as z.infer<typeof ProjectParams>;
      reply.header("cache-control", "no-store");
      return attention.listStories(
        actor.orgId,
        projectId,
        request.query as z.infer<typeof AttentionStoriesQuery>,
        new Date(),
        { budgets: can(actor.permissions, "budgets:read") },
      );
    },
  );

  app.get(
    "/v1/projects/:projectId/overview",
    {
      config: { permission: "projects:read" },
      schema: {
        params: ProjectParams,
        response: { 200: ProjectOverviewResponse },
        operationId: "getProjectOverview",
      },
    },
    async (request, reply) => {
      const actor = principal(request);
      const { projectId } = request.params as z.infer<typeof ProjectParams>;
      reply.header("cache-control", "no-store");
      // Spend sections follow the same permissions as the dedicated cost and
      // budget routes; the rest of the overview only needs project read access.
      return service.overview(actor.orgId, projectId, {
        costs: can(actor.permissions, "costs:read"),
        budgets: can(actor.permissions, "budgets:read"),
      });
    },
  );

  app.get(
    "/v1/projects/:projectId/attention",
    {
      config: { permission: "projects:read" },
      schema: {
        params: ProjectParams,
        querystring: AttentionQuery,
        response: { 200: ProjectAttentionResponse },
        operationId: "listProjectAttention",
      },
    },
    async (request, reply) => {
      const actor = principal(request);
      const { projectId } = request.params as z.infer<typeof ProjectParams>;
      const query = request.query as z.infer<typeof AttentionQuery>;
      reply.header("cache-control", "no-store");
      return attention.list(actor.orgId, projectId, query);
    },
  );
}
