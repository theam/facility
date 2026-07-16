import { randomBytes } from "node:crypto";
import { newId, seal } from "@facility/core";
import { inboundEvents, integrations, webhookDeliveries } from "@facility/db";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound } from "../../errors.js";
import {
  AnyObject,
  assertProjectInOrg,
  Ok,
  principal,
  type V1RouteContext,
  WebhookDeliverySchema,
} from "./shared.js";

const IntegrationSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string().nullable(),
  // The catalog also contains platform-managed kinds such as github and
  // github_app. Creation is intentionally narrower, but reads must faithfully
  // represent every integration row the platform itself can create.
  kind: z.string(),
  name: z.string(),
  config: AnyObject,
  enabled: z.boolean(),
  hasSecret: z.boolean(),
  webhookUrl: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
const IntegrationSecretSchema = IntegrationSchema.extend({ secret: z.string() });
const InboundEventSchema = z.object({
  id: z.string(),
  receivedAt: z.date(),
  verified: z.boolean(),
  eventType: z.string(),
  processedAt: z.date().nullable(),
  error: z.string().nullable(),
});

const IntegrationBody = z.object({
  projectId: z.string().optional(),
  kind: z.string().min(1),
  name: z.string().min(1),
  config: AnyObject.default({}),
  secret: z.string().min(16).optional(),
  enabled: z.boolean().default(true),
});

const IntegrationPatch = z.object({
  name: z.string().min(1).optional(),
  config: AnyObject.optional(),
  enabled: z.boolean().optional(),
});

export async function registerIntegrationRoutes(app: FastifyInstance, context: V1RouteContext) {
  const { db, config } = context;

  app.get(
    "/v1/integrations",
    {
      config: { permission: "integrations:read" },
      schema: {
        querystring: z.object({
          projectId: z.string().optional(),
          kind: z.string().min(1).optional(),
          enabled: z
            .enum(["true", "false"])
            .transform((value) => value === "true")
            .optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(IntegrationSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const query = request.query as {
        projectId?: string;
        kind?: string;
        enabled?: boolean;
        limit: number;
        offset: number;
      };
      const clauses = [eq(integrations.orgId, p.orgId)];
      if (p.projectId) clauses.push(eq(integrations.projectId, p.projectId));
      if (query.projectId) {
        if (p.projectId && p.projectId !== query.projectId) return [];
        clauses.push(eq(integrations.projectId, query.projectId));
      }
      if (query.kind) clauses.push(eq(integrations.kind, query.kind));
      if (query.enabled !== undefined) clauses.push(eq(integrations.enabled, query.enabled));
      const rows = await db
        .select()
        .from(integrations)
        .where(and(...clauses))
        .orderBy(desc(integrations.createdAt))
        .limit(query.limit)
        .offset(query.offset);
      return rows.map((row) => publicIntegration(row, config.publicUrl));
    },
  );

  app.get(
    "/v1/integrations/:integrationId",
    {
      config: { permission: "integrations:read" },
      schema: {
        params: z.object({ integrationId: z.string() }),
        response: { 200: IntegrationSchema },
      },
    },
    async (request) => {
      const row = await loadIntegration(
        (request.params as { integrationId: string }).integrationId,
        principal(request),
      );
      return publicIntegration(row, config.publicUrl);
    },
  );

  app.post(
    "/v1/integrations",
    {
      config: { permission: "integrations:write", auditAction: "integration.created" },
      schema: { body: IntegrationBody, response: { 200: IntegrationSecretSchema } },
    },
    async (request) => {
      const p = principal(request);
      const body = request.body as z.infer<typeof IntegrationBody>;
      const projectId = body.projectId ?? p.projectId ?? null;
      if (p.projectId && projectId !== p.projectId) {
        throw notFound("Project not found");
      }
      if (projectId) await assertProjectInOrg(db, p, projectId, 404);
      validateIntegrationConfig(body.kind, body.config, config.facilityInsecureDev);
      const secret = body.secret ?? randomBytes(32).toString("base64url");
      const row = (
        await db
          .insert(integrations)
          .values({
            id: newId("int"),
            orgId: p.orgId,
            projectId,
            kind: body.kind,
            name: body.name,
            config: body.config,
            sealedSecret: await seal(secret, config.secretMasterKey),
            enabled: body.enabled,
          })
          .returning()
      )[0];
      if (!row) throw new ApiError(500, "insert_failed", "Could not create integration");
      return { ...publicIntegration(row, config.publicUrl), secret };
    },
  );

  app.patch(
    "/v1/integrations/:integrationId",
    {
      config: { permission: "integrations:write", auditAction: "integration.updated" },
      schema: {
        params: z.object({ integrationId: z.string() }),
        body: IntegrationPatch,
        response: { 200: IntegrationSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const integrationId = (request.params as { integrationId: string }).integrationId;
      const current = await loadIntegration(integrationId, p);
      const body = request.body as z.infer<typeof IntegrationPatch>;
      validateIntegrationConfig(
        current.kind,
        body.config ?? objectOrEmpty(current.config),
        config.facilityInsecureDev,
      );
      const row = (
        await db
          .update(integrations)
          .set({
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.config === undefined ? {} : { config: body.config }),
            ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
            updatedAt: new Date(),
          })
          .where(and(eq(integrations.orgId, p.orgId), eq(integrations.id, integrationId)))
          .returning()
      )[0];
      if (!row) throw notFound("Integration not found");
      return publicIntegration(row, config.publicUrl);
    },
  );

  app.post(
    "/v1/integrations/:integrationId/rotate-secret",
    {
      config: { permission: "integrations:write", auditAction: "integration.secret_rotated" },
      schema: {
        params: z.object({ integrationId: z.string() }),
        body: z.object({ secret: z.string().min(16).optional() }),
        response: { 200: IntegrationSecretSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const integrationId = (request.params as { integrationId: string }).integrationId;
      await loadIntegration(integrationId, p);
      const secret =
        (request.body as { secret?: string }).secret ?? randomBytes(32).toString("base64url");
      const row = (
        await db
          .update(integrations)
          .set({ sealedSecret: await seal(secret, config.secretMasterKey), updatedAt: new Date() })
          .where(and(eq(integrations.orgId, p.orgId), eq(integrations.id, integrationId)))
          .returning()
      )[0];
      if (!row) throw notFound("Integration not found");
      return { ...publicIntegration(row, config.publicUrl), secret };
    },
  );

  app.get(
    "/v1/integrations/:integrationId/deliveries",
    {
      config: { permission: "integrations:read" },
      schema: {
        params: z.object({ integrationId: z.string() }),
        querystring: z.object({
          status: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(WebhookDeliverySchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const integrationId = (request.params as { integrationId: string }).integrationId;
      await loadIntegration(integrationId, p);
      const query = request.query as { status?: string; limit: number; offset: number };
      const clauses = [
        eq(webhookDeliveries.orgId, p.orgId),
        eq(webhookDeliveries.integrationId, integrationId),
      ];
      if (query.status) clauses.push(eq(webhookDeliveries.status, query.status));
      return db
        .select()
        .from(webhookDeliveries)
        .where(and(...clauses))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(query.limit)
        .offset(query.offset);
    },
  );

  app.get(
    "/v1/integrations/:integrationId/events",
    {
      config: { permission: "integrations:read" },
      schema: {
        params: z.object({ integrationId: z.string() }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(InboundEventSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const integrationId = (request.params as { integrationId: string }).integrationId;
      const query = request.query as { limit: number; offset: number };
      await loadIntegration(integrationId, p);
      return db
        .select({
          id: inboundEvents.id,
          receivedAt: inboundEvents.receivedAt,
          verified: inboundEvents.verified,
          eventType: inboundEvents.eventType,
          processedAt: inboundEvents.processedAt,
          error: inboundEvents.error,
        })
        .from(inboundEvents)
        .where(
          and(eq(inboundEvents.orgId, p.orgId), eq(inboundEvents.integrationId, integrationId)),
        )
        .orderBy(desc(inboundEvents.receivedAt))
        .limit(query.limit)
        .offset(query.offset);
    },
  );

  app.post(
    "/v1/webhook-deliveries/:deliveryId/retry",
    {
      config: { permission: "integrations:write", auditAction: "integration.delivery_retried" },
      schema: {
        params: z.object({ deliveryId: z.string() }),
        response: { 200: WebhookDeliverySchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const deliveryId = (request.params as { deliveryId: string }).deliveryId;
      const row = (
        await db
          .select({ delivery: webhookDeliveries, integration: integrations })
          .from(webhookDeliveries)
          .innerJoin(integrations, eq(integrations.id, webhookDeliveries.integrationId))
          .where(and(eq(webhookDeliveries.orgId, p.orgId), eq(webhookDeliveries.id, deliveryId)))
          .limit(1)
      )[0];
      if (!row || (p.projectId && row.integration.projectId !== p.projectId)) {
        throw notFound("Webhook delivery not found");
      }
      if (!["failed", "dead"].includes(row.delivery.status)) {
        throw new ApiError(
          409,
          "delivery_not_retryable",
          "Only failed or dead webhook deliveries can be retried",
        );
      }
      const delivery = (
        await db
          .update(webhookDeliveries)
          .set({
            status: "pending",
            attempts: 0,
            nextAttemptAt: new Date(),
            responseStatus: null,
            error: null,
            deliveredAt: null,
            updatedAt: new Date(),
          })
          .where(and(eq(webhookDeliveries.orgId, p.orgId), eq(webhookDeliveries.id, deliveryId)))
          .returning()
      )[0];
      if (!delivery) throw notFound("Webhook delivery not found");
      return delivery;
    },
  );

  app.delete(
    "/v1/integrations/:integrationId",
    {
      config: { permission: "integrations:write", auditAction: "integration.deleted" },
      schema: {
        params: z.object({ integrationId: z.string() }),
        response: { 200: Ok },
      },
    },
    async (request) => {
      const p = principal(request);
      const integrationId = (request.params as { integrationId: string }).integrationId;
      await loadIntegration(integrationId, p);
      await db
        .update(integrations)
        .set({ enabled: false, updatedAt: new Date() })
        .where(and(eq(integrations.orgId, p.orgId), eq(integrations.id, integrationId)));
      return { ok: true };
    },
  );

  async function loadIntegration(integrationId: string, p: ReturnType<typeof principal>) {
    const row = (
      await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.orgId, p.orgId), eq(integrations.id, integrationId)))
        .limit(1)
    )[0];
    if (!row || (p.projectId && row.projectId !== p.projectId)) {
      throw notFound("Integration not found");
    }
    return row;
  }
}

function publicIntegration(row: typeof integrations.$inferSelect, publicUrl?: string) {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    kind: row.kind,
    name: row.name,
    config: objectOrEmpty(row.config),
    enabled: row.enabled,
    hasSecret: Boolean(row.sealedSecret),
    ...(row.kind === "generic_inbound" && publicUrl
      ? { webhookUrl: `${publicUrl.replace(/\/$/, "")}/webhooks/inbound/${row.id}` }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function validateIntegrationConfig(
  kind: string,
  config: Record<string, unknown>,
  insecure: boolean,
) {
  if (kind !== "webhook") return;
  if (typeof config.url !== "string") {
    throw new ApiError(400, "webhook_url_required", "Webhook integration requires config.url");
  }
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new ApiError(400, "invalid_webhook_url", "Webhook URL must be absolute");
  }
  if (!insecure && url.protocol !== "https:") {
    throw new ApiError(400, "invalid_webhook_url", "Webhook URL must use HTTPS");
  }
  if (!["https:", ...(insecure ? ["http:"] : [])].includes(url.protocol)) {
    throw new ApiError(400, "invalid_webhook_url", "Webhook URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new ApiError(400, "invalid_webhook_url", "Webhook URL cannot contain credentials");
  }
  if (url.hash) {
    throw new ApiError(400, "invalid_webhook_url", "Webhook URL cannot contain a fragment");
  }
  if (config.url.length > 2_048) {
    throw new ApiError(400, "invalid_webhook_url", "Webhook URL is too long");
  }
  if (config.events !== undefined) {
    if (
      !Array.isArray(config.events) ||
      config.events.length === 0 ||
      config.events.some((event) => !["run.finished", "proposal.decided"].includes(String(event)))
    ) {
      throw new ApiError(
        400,
        "invalid_webhook_events",
        "Webhook config.events must contain run.finished and/or proposal.decided",
      );
    }
  }
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
