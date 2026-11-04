import {
  ConfirmPlanDecisionBody,
  PlanDecisionRequestResult,
  PlanDecisionReviewSchema,
  ProposeStoryPlanBody,
  RequestPlanDecisionBody,
  StoryPlanQuery,
  StoryPlanRepositoriesQuery,
  StoryPlanRepositoriesSchema,
  StoryPlanSchema,
  StoryPlansSchema,
} from "@facility/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import { interactivePlanActor } from "../../stories/plan-confirmation.js";
import {
  checkStoryPlanConfirmation,
  confirmStoryPlanDecision,
  proposeStoryPlan,
  readStoryPlanRepositories,
  readStoryPlanRevision,
  readStoryPlans,
  requestStoryPlanDecision,
  reviewStoryPlanDecision,
} from "../../stories/plans.js";
import { releaseWorkflowQueue } from "../../stories/workflow-status.js";
import type { AppConfig } from "../../types.js";
import { principal } from "./shared.js";

const StoryParams = z.object({ projectId: z.string(), storyId: z.string() });
const RevisionParams = StoryParams.extend({
  revision: z.coerce.number().int().min(1).max(2_147_483_647),
});
const DecisionParams = StoryParams.extend({ requestId: z.string() });
const base = "/v1/projects/:projectId/workspace-stories/:storyId/plan";

export async function registerStoryPlanRoutes(app: FastifyInstance, config: AppConfig) {
  const options = { webUrl: config.webUrl ?? config.publicUrl };
  const scope = (request: FastifyRequest) => {
    const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
    return { orgId: principal(request).orgId, projectId, storyId };
  };
  const actor = (request: FastifyRequest) => {
    const value = principal(request);
    return {
      type: value.type === "key" ? ("service" as const) : ("user" as const),
      id: value.type === "user" ? (value.userId ?? value.id) : value.id,
      name: value.name?.slice(0, 120) ?? null,
    };
  };
  app.get(
    `${base}/repositories`,
    {
      config: { permission: "projects:write" },
      schema: {
        params: StoryParams,
        querystring: StoryPlanRepositoriesQuery,
        response: { 200: StoryPlanRepositoriesSchema },
        operationId: "getStoryPlanRepositories",
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      return readStoryPlanRepositories(
        app.facilityDb,
        scope(request),
        request.query as z.infer<typeof StoryPlanRepositoriesQuery>,
      );
    },
  );
  app.get(
    base,
    {
      config: { permission: "projects:read" },
      schema: {
        params: StoryParams,
        querystring: StoryPlanQuery,
        response: { 200: StoryPlansSchema },
        operationId: "getStoryPlans",
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      return readStoryPlans(app.facilityDb, scope(request), {
        ...options,
        ...(request.query as z.infer<typeof StoryPlanQuery>),
      });
    },
  );
  app.get(
    `${base}/revisions/:revision`,
    {
      config: { permission: "projects:read" },
      schema: {
        params: RevisionParams,
        response: { 200: StoryPlanSchema },
        operationId: "getStoryPlanRevision",
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      return readStoryPlanRevision(
        app.facilityDb,
        scope(request),
        (request.params as z.infer<typeof RevisionParams>).revision,
      );
    },
  );
  app.post(
    base,
    {
      config: {
        permission: "projects:write",
        idempotent: true,
        auditAction: "story.plan.proposed",
      },
      schema: {
        params: StoryParams,
        body: ProposeStoryPlanBody,
        response: { 200: StoryPlansSchema },
        operationId: "proposeStoryPlan",
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof ProposeStoryPlanBody>;
      assertKey(request, body.idempotency_key);
      reply.header("cache-control", "private, no-store");
      return proposeStoryPlan(
        app.facilityDb,
        app.storyDomain.catalog,
        scope(request),
        body,
        actor(request),
        options,
      );
    },
  );
  app.post(
    `${base}/decisions`,
    {
      config: {
        permission: "projects:write",
        idempotent: true,
        auditAction: "story.plan.decision_requested",
      },
      schema: {
        params: StoryParams,
        body: RequestPlanDecisionBody,
        response: { 200: PlanDecisionRequestResult },
        operationId: "requestStoryPlanDecision",
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof RequestPlanDecisionBody>;
      assertKey(request, body.idempotency_key);
      reply.header("cache-control", "private, no-store");
      return requestStoryPlanDecision(
        app.facilityDb,
        scope(request),
        body,
        actor(request),
        options,
      );
    },
  );
  app.get(
    `${base}/decisions/:requestId`,
    {
      config: { permission: "projects:write" },
      schema: {
        params: DecisionParams,
        response: { 200: PlanDecisionReviewSchema },
        operationId: "reviewStoryPlanDecision",
      },
    },
    async (request, reply) => {
      const interactive = interactivePlanActor(request);
      reply.header("cache-control", "private, no-store");
      return reviewStoryPlanDecision(
        app.facilityDb,
        scope(request),
        (request.params as z.infer<typeof DecisionParams>).requestId,
        interactive,
        config.secretMasterKey,
        options,
      );
    },
  );
  app.post(
    `${base}/decisions/:requestId/confirm`,
    {
      config: {
        permission: "projects:write",
        idempotent: true,
        auditAction: "story.plan.decision_confirmed",
      },
      // preValidation precedes the global idempotency preHandler, including on replay.
      preValidation: async (request) => {
        const interactive = interactivePlanActor(request);
        const body = ConfirmPlanDecisionBody.safeParse(request.body);
        if (!body.success)
          throw new ApiError(
            400,
            "plan_confirmation_invalid",
            "Provide the confirmation proof and idempotency key from the review page",
          );
        assertKey(request, body.data.idempotency_key);
        await checkStoryPlanConfirmation(
          app.facilityDb,
          scope(request),
          (request.params as z.infer<typeof DecisionParams>).requestId,
          body.data.proof,
          interactive,
          config.secretMasterKey,
        );
      },
      schema: {
        params: DecisionParams,
        body: ConfirmPlanDecisionBody,
        response: { 200: StoryPlansSchema },
        operationId: "confirmStoryPlanDecision",
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof ConfirmPlanDecisionBody>;
      reply.header("cache-control", "private, no-store");
      const result = await confirmStoryPlanDecision(
        app.facilityDb,
        scope(request),
        (request.params as z.infer<typeof DecisionParams>).requestId,
        body.proof,
        interactivePlanActor(request),
        config.secretMasterKey,
        options,
      );
      if (result.state.status === "approved")
        await releaseWorkflowQueue(app.facilityDb, scope(request), (queue, data) =>
          app.enqueue(queue, data),
        );
      return result;
    },
  );
}

function assertKey(request: FastifyRequest, key: string) {
  if (request.headers["idempotency-key"] !== key)
    throw new ApiError(
      400,
      "plan_idempotency_key_mismatch",
      "Provide the same idempotency key in the header and body",
    );
}
