import {
  CancelConsultationBody,
  ConsultationHandoffSchema,
  ConsultationOptionsSchema,
  ConsultationQuery,
  ConsultationSchema,
  ConsultationsSchema,
  can,
  RequestConsultationBody,
} from "@facility/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import { principal } from "./shared.js";

const StoryParams = z.object({ projectId: z.string(), storyId: z.string() });
const ConsultationParams = StoryParams.extend({
  consultationId: z.string().regex(/^cons_[a-f0-9]{32}$/),
});
const base = "/v1/projects/:projectId/workspace-stories/:storyId/consultations";
export async function registerStoryConsultationRoutes(app: FastifyInstance) {
  const scope = (request: FastifyRequest) => {
    const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
    return { orgId: principal(request).orgId, projectId, storyId };
  };
  const view = (request: FastifyRequest) => ({
    costsVisible: can(principal(request).permissions, "costs:read"),
  });
  const surface = (request: FastifyRequest) =>
    request.headers["x-facility-surface"] === "mcp" ? ("mcp" as const) : ("ui" as const);
  const id = (request: FastifyRequest) =>
    (request.params as z.infer<typeof ConsultationParams>).consultationId;
  const headers = (reply: { header: (key: string, value: string) => unknown }) => {
    reply.header("cache-control", "private, no-store");
  };
  app.get(
    `${base}/options`,
    {
      config: { permission: "workspaces:execute" },
      schema: {
        params: StoryParams,
        response: { 200: ConsultationOptionsSchema },
        operationId: "getStoryConsultationOptions",
      },
    },
    async (request, reply) => {
      headers(reply);
      return app.storyDomain.consultations.options(scope(request), surface(request), view(request));
    },
  );
  app.get(
    base,
    {
      config: { permission: "projects:read" },
      schema: {
        params: StoryParams,
        querystring: ConsultationQuery,
        response: { 200: ConsultationsSchema },
        operationId: "getStoryConsultations",
      },
    },
    async (request, reply) => {
      headers(reply);
      return app.storyDomain.consultations.list(
        scope(request),
        request.query as z.infer<typeof ConsultationQuery>,
        view(request),
      );
    },
  );
  app.get(
    `${base}/:consultationId`,
    {
      config: { permission: "projects:read" },
      schema: {
        params: ConsultationParams,
        response: { 200: ConsultationSchema },
        operationId: "getStoryConsultation",
      },
    },
    async (request, reply) => {
      headers(reply);
      return app.storyDomain.consultations.get(scope(request), id(request), view(request));
    },
  );
  app.get(
    `${base}/:consultationId/handoff`,
    {
      config: { permission: "projects:read" },
      schema: {
        params: ConsultationParams,
        response: { 200: ConsultationHandoffSchema },
        operationId: "getStoryConsultationHandoff",
      },
    },
    async (request, reply) => {
      headers(reply);
      return app.storyDomain.consultations.handoff(scope(request), id(request));
    },
  );
  app.post(
    base,
    {
      config: {
        permission: "workspaces:execute",
        idempotent: true,
        auditAction: "story.consultation.requested",
      },
      schema: {
        params: StoryParams,
        body: RequestConsultationBody,
        response: { 202: ConsultationSchema },
        operationId: "requestStoryConsultation",
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof RequestConsultationBody>;
      assertKey(request, body.idempotency_key);
      const current = principal(request);
      const result = await app.storyDomain.consultations.request(
        scope(request),
        body,
        { type: current.type, id: current.userId ?? current.id, name: current.name ?? null },
        surface(request),
        // HTTP write receipts may be replayed after cost visibility is revoked.
        // Read fresh cost amounts through the permission-checked GET endpoints.
        { costsVisible: false },
      );
      headers(reply);
      return reply.status(202).send(result);
    },
  );
  app.post(
    `${base}/:consultationId/cancel`,
    {
      config: {
        permission: "workspaces:execute",
        idempotent: true,
        auditAction: "story.consultation.cancel_requested",
      },
      schema: {
        params: ConsultationParams,
        body: CancelConsultationBody,
        response: { 200: ConsultationSchema },
        operationId: "cancelStoryConsultation",
      },
    },
    async (request, reply) => {
      assertKey(request, (request.body as z.infer<typeof CancelConsultationBody>).idempotency_key);
      headers(reply);
      return app.storyDomain.consultations.cancel(scope(request), id(request), {
        costsVisible: false,
      });
    },
  );
}
function assertKey(request: FastifyRequest, key: string) {
  if (request.headers["idempotency-key"] !== key)
    throw new ApiError(
      400,
      "consultation_idempotency_key_mismatch",
      "Provide the same idempotency key in the header and body",
    );
}
