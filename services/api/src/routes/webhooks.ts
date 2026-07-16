import { createHmac, timingSafeEqual } from "node:crypto";
import { open } from "@facility/core";
import { inboundEvents, integrations } from "@facility/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { resolveGithubIntegration } from "../github/processor.js";
import { parseGithubJson, verifyGithubSignature } from "../github/webhook.js";
import { processGenericInboundEvent } from "../integrations/inbound.js";
import type { AppConfig } from "../types.js";

const Ok = z.object({ ok: z.boolean(), replayed: z.boolean().optional() });
const INBOUND_SIGNATURE_MAX_AGE_SECONDS = 300;

export async function registerWebhookRoutes(app: FastifyInstance, config: AppConfig) {
  await app.register(async (webhookApp) => {
    webhookApp.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    webhookApp.post(
      "/webhooks/github",
      {
        config: { public: true },
        schema: { response: { 202: Ok, 401: Ok } },
      },
      async (request, reply) => {
        const secret = config.githubAppWebhookSecret;
        if (!secret) return reply.status(401).send({ ok: false });
        const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
        const signature = request.headers["x-hub-signature-256"];
        if (
          !verifyGithubSignature(
            rawBody,
            Array.isArray(signature) ? signature[0] : signature,
            secret,
          )
        ) {
          return reply.status(401).send({ ok: false });
        }
        const delivery = request.headers["x-github-delivery"];
        const eventType = request.headers["x-github-event"];
        if (typeof delivery !== "string" || typeof eventType !== "string") {
          return reply.status(401).send({ ok: false });
        }
        const payload = parseGithubJson(rawBody) as Record<string, unknown>;
        const integration = await resolveGithubIntegration(app.facilityDb, payload);
        if (!integration) {
          // HMAC-valid but we can't unambiguously attribute it to an org
          // (unknown installation in a multi-org deployment). Drop, don't guess.
          request.log.warn({ delivery, eventType }, "github webhook: unresolved installation");
          return reply.status(202).send({ ok: true });
        }
        const id = `gh_${delivery}`;
        const inserted = await app.facilityDb
          .insert(inboundEvents)
          .values({
            id,
            orgId: integration.orgId,
            integrationId: integration.integrationId,
            verified: true,
            eventType,
            payload,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted.length === 0) return reply.status(202).send({ ok: true, replayed: true });
        await app.enqueue("github.webhook", { inboundEventId: id });
        return reply.status(202).send({ ok: true });
      },
    );

    webhookApp.post(
      "/webhooks/inbound/:integrationId",
      {
        config: { public: true },
        schema: {
          params: z.object({ integrationId: z.string() }),
          response: { 202: Ok, 401: Ok },
        },
      },
      async (request, reply) => {
        const { integrationId } = request.params as { integrationId: string };
        const integration = (
          await app.facilityDb
            .select()
            .from(integrations)
            .where(
              and(
                eq(integrations.id, integrationId),
                eq(integrations.enabled, true),
                eq(integrations.kind, "generic_inbound"),
              ),
            )
            .limit(1)
        )[0];
        if (!integration?.sealedSecret) return reply.status(401).send({ ok: false });
        const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
        const signature = headerString(request.headers["x-facility-signature"]);
        const timestamp = headerString(request.headers["x-facility-timestamp"]);
        const deliveryId = headerString(request.headers["x-facility-delivery"]);
        const eventType = headerString(request.headers["x-facility-event"]);
        if (!timestamp || !deliveryId || !eventType) {
          return reply.status(401).send({ ok: false });
        }
        const secret = await open(integration.sealedSecret, config.secretMasterKey);
        if (
          !verifyInboundSignature(rawBody, { signature, timestamp, deliveryId, eventType }, secret)
        ) {
          return reply.status(401).send({ ok: false });
        }
        const payload = parseJson(rawBody);
        // Scope idempotency to the integration: a delivery id is only unique per
        // sender, so a global `in_${deliveryId}` would let one integration's
        // delivery id suppress a different integration's event.
        const id = `in_${integration.id}_${deliveryId}`;
        const inserted = await app.facilityDb
          .insert(inboundEvents)
          .values({
            id,
            orgId: integration.orgId,
            integrationId: integration.id,
            verified: true,
            eventType,
            payload,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted.length === 0) return reply.status(202).send({ ok: true, replayed: true });
        await processGenericInboundEvent(app.facilityDb, id, app.enqueue);
        return reply.status(202).send({ ok: true });
      },
    );
  });
}

function verifyInboundSignature(
  body: Buffer,
  headers: {
    signature?: string;
    timestamp?: string;
    deliveryId?: string;
    eventType?: string;
  },
  secret: string,
): boolean {
  const { signature, timestamp, deliveryId, eventType } = headers;
  if (
    !signature?.startsWith("sha256=") ||
    !timestamp ||
    !/^\d{10}$/.test(timestamp) ||
    !deliveryId ||
    !eventType
  ) {
    return false;
  }
  const sentAt = Number(timestamp);
  const now = Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(sentAt) || Math.abs(now - sentAt) > INBOUND_SIGNATURE_MAX_AGE_SECONDS) {
    return false;
  }
  const expected = `sha256=${createHmac("sha256", secret)
    .update(`${timestamp}.${deliveryId}.${eventType}.`)
    .update(body)
    .digest("hex")}`;
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseJson(body: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new ApiError(400, "bad_request", "Invalid JSON payload");
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function headerString(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}
