import {
  ConfirmDeliveryAcceptanceBody,
  ConfirmWorkflowPolicyBody,
  DeliveryAcceptanceRequestSchema,
  DeliveryAcceptanceReviewSchema,
  RequestDeliveryAcceptanceBody,
  ReviewWorkflowPolicyBody,
  StoryDeliveryAcceptanceSchema,
  StoryWorkflowPolicyStateSchema,
  StoryWorkflowStatusSchema,
  WorkflowPolicyReviewSchema,
} from "@facility/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import {
  checkDeliveryAcceptanceConfirmation,
  confirmDeliveryAcceptance,
  readDeliveryAcceptance,
  requestDeliveryAcceptance,
  reviewDeliveryAcceptance,
} from "../../stories/delivery-acceptance.js";
import { interactivePlanActor } from "../../stories/plan-confirmation.js";
import {
  checkWorkflowPolicyConfirmation,
  confirmWorkflowPolicy,
  readWorkflowPolicy,
  reviewWorkflowPolicy,
} from "../../stories/workflow-policy.js";
import { readStoryWorkflow, releaseWorkflowQueue } from "../../stories/workflow-status.js";
import type { AppConfig } from "../../types.js";
import { principal } from "./shared.js";

const ProjectParams = z.object({ projectId: z.string() });
const StoryParams = ProjectParams.extend({ storyId: z.string() });
const RequestParams = StoryParams.extend({ requestId: z.string() });
const projectBase = "/v1/projects/:projectId/workflow-policy";
const storyBase = "/v1/projects/:projectId/workspace-stories/:storyId";
function assertKey(request: FastifyRequest, key: string) {
  if (request.headers["idempotency-key"] !== key)
    throw new ApiError(
      400,
      "workflow_idempotency_key_mismatch",
      "Use the same idempotency key in the header and body",
    );
}
export async function registerStoryWorkflowRoutes(app: FastifyInstance, config: AppConfig) {
  const projectScope = (request: FastifyRequest) => ({
    orgId: principal(request).orgId,
    projectId: (request.params as z.infer<typeof ProjectParams>).projectId,
  });
  const scope = (request: FastifyRequest) => ({
    ...projectScope(request),
    storyId: (request.params as z.infer<typeof StoryParams>).storyId,
  });
  const requestId = (request: FastifyRequest) =>
    (request.params as z.infer<typeof RequestParams>).requestId;
  const noStore = (reply: { header(name: string, value: string): unknown }) =>
    reply.header("cache-control", "private, no-store");
  const webUrl = config.webUrl ?? config.publicUrl;
  app.get(
    projectBase,
    {
      config: { permission: "projects:read" },
      schema: {
        params: ProjectParams,
        response: { 200: StoryWorkflowPolicyStateSchema },
        operationId: "getProjectWorkflowPolicy",
      },
    },
    async (request, reply) => {
      noStore(reply);
      return readWorkflowPolicy(app.facilityDb, projectScope(request));
    },
  );
  app.post(
    `${projectBase}/review`,
    {
      config: { permission: "projects:write" },
      schema: {
        params: ProjectParams,
        body: ReviewWorkflowPolicyBody,
        response: { 200: WorkflowPolicyReviewSchema },
        operationId: "reviewProjectWorkflowPolicy",
      },
    },
    async (request, reply) => {
      const actor = interactivePlanActor(request);
      const body = request.body as z.infer<typeof ReviewWorkflowPolicyBody>;
      assertKey(request, body.idempotency_key);
      noStore(reply);
      return reviewWorkflowPolicy(
        app.facilityDb,
        app.storyDomain.catalog,
        projectScope(request),
        body.expected_revision,
        body.policy,
        actor,
        config.secretMasterKey,
      );
    },
  );
  app.post(
    `${projectBase}/confirm`,
    {
      config: { permission: "projects:write", idempotent: true },
      preValidation: async (request) => {
        const actor = interactivePlanActor(request);
        const parsed = ConfirmWorkflowPolicyBody.safeParse(request.body);
        if (!parsed.success)
          throw new ApiError(
            400,
            "workflow_confirmation_invalid",
            "Use the exact policy confirmation from the review page",
          );
        assertKey(request, parsed.data.idempotency_key);
        await checkWorkflowPolicyConfirmation(
          app.facilityDb,
          projectScope(request),
          parsed.data,
          actor,
          config.secretMasterKey,
        );
      },
      schema: {
        params: ProjectParams,
        body: ConfirmWorkflowPolicyBody,
        response: { 200: StoryWorkflowPolicyStateSchema },
        operationId: "confirmProjectWorkflowPolicy",
      },
    },
    async (request, reply) => {
      const result = await confirmWorkflowPolicy(
        app.facilityDb,
        app.storyDomain.catalog,
        projectScope(request),
        request.body as z.infer<typeof ConfirmWorkflowPolicyBody>,
        interactivePlanActor(request),
        config.secretMasterKey,
      );
      await releaseWorkflowQueue(app.facilityDb, projectScope(request), (queue, data) =>
        app.enqueue(queue, data),
      );
      noStore(reply);
      return result;
    },
  );
  app.get(
    `${storyBase}/workflow`,
    {
      config: { permission: "projects:read" },
      schema: {
        params: StoryParams,
        response: { 200: StoryWorkflowStatusSchema },
        operationId: "getStoryWorkflow",
      },
    },
    async (request, reply) => {
      noStore(reply);
      return readStoryWorkflow(app.facilityDb, scope(request));
    },
  );
  app.get(
    `${storyBase}/delivery-acceptance`,
    {
      config: { permission: "projects:read" },
      schema: {
        params: StoryParams,
        response: { 200: StoryDeliveryAcceptanceSchema },
        operationId: "getStoryDeliveryAcceptance",
      },
    },
    async (request, reply) => {
      noStore(reply);
      return readDeliveryAcceptance(app.facilityDb, scope(request));
    },
  );
  app.post(
    `${storyBase}/delivery-acceptance`,
    {
      config: {
        permission: "projects:write",
        idempotent: true,
        auditAction: "story.delivery.acceptance_requested",
      },
      schema: {
        params: StoryParams,
        body: RequestDeliveryAcceptanceBody,
        response: { 200: DeliveryAcceptanceRequestSchema },
        operationId: "requestStoryDeliveryAcceptance",
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof RequestDeliveryAcceptanceBody>;
      assertKey(request, body.idempotency_key);
      noStore(reply);
      const value = principal(request);
      return requestDeliveryAcceptance(
        app.facilityDb,
        scope(request),
        body,
        {
          type: value.type === "key" ? "service" : "user",
          id: value.type === "user" ? (value.userId ?? value.id) : value.id,
          name: value.name?.slice(0, 120) ?? null,
        },
        webUrl,
      );
    },
  );
  app.get(
    `${storyBase}/delivery-acceptance/:requestId`,
    {
      config: { permission: "projects:write" },
      schema: {
        params: RequestParams,
        response: { 200: DeliveryAcceptanceReviewSchema },
        operationId: "reviewStoryDeliveryAcceptance",
      },
    },
    async (request, reply) => {
      noStore(reply);
      return reviewDeliveryAcceptance(
        app.facilityDb,
        scope(request),
        requestId(request),
        interactivePlanActor(request),
        config.secretMasterKey,
        webUrl,
      );
    },
  );
  app.post(
    `${storyBase}/delivery-acceptance/:requestId/confirm`,
    {
      config: {
        permission: "projects:write",
        idempotent: true,
        auditAction: "story.delivery.accepted",
      },
      preValidation: async (request) => {
        const actor = interactivePlanActor(request);
        const body = ConfirmDeliveryAcceptanceBody.safeParse(request.body);
        if (!body.success)
          throw new ApiError(
            400,
            "workflow_confirmation_invalid",
            "Use the proof from the exact delivery review page",
          );
        assertKey(request, body.data.idempotency_key);
        await checkDeliveryAcceptanceConfirmation(
          app.facilityDb,
          scope(request),
          requestId(request),
          body.data.proof,
          actor,
          config.secretMasterKey,
        );
      },
      schema: {
        params: RequestParams,
        body: ConfirmDeliveryAcceptanceBody,
        response: { 200: StoryDeliveryAcceptanceSchema },
        operationId: "confirmStoryDeliveryAcceptance",
      },
    },
    async (request, reply) => {
      noStore(reply);
      return confirmDeliveryAcceptance(
        app.facilityDb,
        scope(request),
        requestId(request),
        (request.body as z.infer<typeof ConfirmDeliveryAcceptanceBody>).proof,
        interactivePlanActor(request),
        config.secretMasterKey,
      );
    },
  );
}
