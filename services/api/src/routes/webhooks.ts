import { githubInstallations, githubWebhookEvents, projectRepositories } from "@facility/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseGithubJson, verifyGithubSignature } from "../github/webhook.js";
import type { AppConfig } from "../types.js";

const Response = z.object({ ok: z.boolean(), replayed: z.boolean().optional() });

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
        config: { public: true, rateLimit: false },
        schema: { response: { 202: Response, 400: Response, 401: Response } },
      },
      async (request, reply) => {
        const secret = config.githubAppWebhookSecret;
        const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
        const signature = header(request.headers["x-hub-signature-256"]);
        const delivery = header(request.headers["x-github-delivery"]);
        const eventType = header(request.headers["x-github-event"]);
        if (
          !secret ||
          !delivery ||
          !eventType ||
          !verifyGithubSignature(rawBody, signature, secret)
        ) {
          return reply.status(401).send({ ok: false });
        }

        let payload: Record<string, unknown>;
        try {
          const parsed = parseGithubJson(rawBody);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return reply.status(400).send({ ok: false });
          }
          payload = parsed as Record<string, unknown>;
        } catch {
          return reply.status(400).send({ ok: false });
        }
        const installationNumber = githubInstallationNumber(payload);
        if (!installationNumber) {
          request.log.warn({ delivery, eventType }, "github webhook has no installation identity");
          return reply.status(202).send({ ok: true });
        }
        const installation = (
          await app.facilityDb
            .select()
            .from(githubInstallations)
            .where(eq(githubInstallations.installationId, installationNumber))
            .limit(1)
        )[0];
        if (!installation || installation.suspendedAt) {
          request.log.warn(
            { delivery, eventType, installationNumber },
            "github webhook installation is unknown or suspended",
          );
          return reply.status(202).send({ ok: true });
        }

        const repositoryIdentity = githubRepositoryIdentity(payload);
        const repository = repositoryIdentity
          ? (
              await app.facilityDb
                .select({
                  id: projectRepositories.id,
                  projectId: projectRepositories.projectId,
                })
                .from(projectRepositories)
                .where(
                  and(
                    eq(projectRepositories.orgId, installation.orgId),
                    eq(projectRepositories.installationId, installation.id),
                    eq(projectRepositories.owner, repositoryIdentity.owner),
                    eq(projectRepositories.name, repositoryIdentity.name),
                  ),
                )
                .limit(1)
            )[0]
          : undefined;

        const id = `gh_${installation.id}_${delivery}`;
        const inserted = await app.facilityDb
          .insert(githubWebhookEvents)
          .values({
            id,
            orgId: installation.orgId,
            installationId: installation.id,
            projectId: repository?.projectId,
            repositoryId: repository?.id,
            eventType,
            payload,
            verified: true,
          })
          .onConflictDoNothing()
          .returning({ id: githubWebhookEvents.id });
        if (inserted.length === 0) {
          return reply.status(202).send({ ok: true, replayed: true });
        }
        if (!githubWebhookRequiresWorker(eventType, payload)) {
          await app.facilityDb
            .update(githubWebhookEvents)
            .set({ processedAt: new Date() })
            .where(eq(githubWebhookEvents.id, id));
          return reply.status(202).send({ ok: true });
        }
        await app.enqueue("github.webhook", { inboundEventId: id });
        return reply.status(202).send({ ok: true });
      },
    );
  });
}

export function githubWebhookRequiresWorker(eventType: string, payload: Record<string, unknown>) {
  if (eventType !== "workflow_run") return true;
  return payload.action === "completed";
}

function githubInstallationNumber(payload: Record<string, unknown>) {
  const installation = payload.installation;
  if (!installation || typeof installation !== "object" || Array.isArray(installation)) {
    return undefined;
  }
  const id = (installation as Record<string, unknown>).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function githubRepositoryIdentity(payload: Record<string, unknown>) {
  const repository = payload.repository;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) return undefined;
  const value = repository as Record<string, unknown>;
  const fullName = typeof value.full_name === "string" ? value.full_name.split("/") : [];
  const ownerObject = value.owner;
  const owner =
    ownerObject && typeof ownerObject === "object" && !Array.isArray(ownerObject)
      ? (ownerObject as Record<string, unknown>).login
      : fullName[0];
  const name = typeof value.name === "string" ? value.name : fullName[1];
  return typeof owner === "string" && owner && typeof name === "string" && name
    ? { owner, name }
    : undefined;
}

function header(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}
