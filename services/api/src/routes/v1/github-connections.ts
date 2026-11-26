import { newId } from "@facility/core";
import { githubConnections, githubInstallations } from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound } from "../../errors.js";
import {
  ConnectionSecrets,
  inspectApp,
  inspectInstallation,
  openConnection,
  sealConnection,
} from "../../github/connections.js";
import { DateValue, principal, type V1RouteContext } from "./shared.js";

const Connection = z.object({
  id: z.string(),
  name: z.string(),
  appId: z.number(),
  slug: z.string(),
  disabledAt: DateValue.nullable(),
  webhookUrl: z.string(),
});
const Params = z.object({ connectionId: z.string() });
const InstallationNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Create = ConnectionSecrets.extend({
  name: z.string().trim().min(1).max(100),
  appId: InstallationNumber,
  installationId: InstallationNumber,
});

export async function registerGithubConnectionRoutes(
  app: FastifyInstance,
  { db, config }: V1RouteContext,
) {
  const present = (row: typeof githubConnections.$inferSelect) => ({
    id: row.id,
    name: row.name,
    appId: row.appId,
    slug: row.slug,
    disabledAt: row.disabledAt,
    webhookUrl: `${config.publicUrl.replace(/\/$/, "")}/webhooks/github/${row.id}`,
  });
  async function load(orgId: string, id: string) {
    const row = (
      await db
        .select()
        .from(githubConnections)
        .where(and(eq(githubConnections.orgId, orgId), eq(githubConnections.id, id)))
        .limit(1)
    )[0];
    if (!row) throw notFound("GitHub connection not found");
    return row;
  }
  app.get(
    "/v1/github/connections",
    {
      config: { permission: ["repos:read", "org:write"], orgAdmin: true },
      schema: { response: { 200: z.array(Connection) } },
    },
    async (request) =>
      (
        await db
          .select()
          .from(githubConnections)
          .where(eq(githubConnections.orgId, principal(request).orgId))
      ).map(present),
  );

  app.post(
    "/v1/github/connections",
    {
      config: { permission: "org:write", orgAdmin: true, auditAction: "github.connection.created" },
      schema: { body: Create, response: { 200: Connection } },
    },
    async (request) => {
      const actor = principal(request);
      const body = request.body as z.infer<typeof Create>;
      // The environment App is deliberately kept on the legacy webhook route.
      if (String(body.appId) === config.githubAppId)
        throw new ApiError(
          409,
          "default_app",
          "This App is already configured as the instance default",
        );
      const metadata = await inspectInstallation(body.appId, body.privateKey, body.installationId);
      const scope = { id: newId("ghc"), orgId: actor.orgId, appId: body.appId };
      const credentials = await sealConnection(scope, body, config.secretMasterKey);
      try {
        return await db.transaction(async (tx) => {
          const row = (
            await tx
              .insert(githubConnections)
              .values({ ...scope, name: body.name, slug: metadata.slug, credentials })
              .returning()
          )[0];
          if (!row) throw new ApiError(500, "insert_failed", "Could not create connection");
          await tx
            .insert(githubInstallations)
            .values({ id: newId("ghi"), orgId: actor.orgId, connectionId: row.id, ...metadata });
          return present(row);
        });
      } catch (error) {
        if (
          (error as { code?: string }).code === "23505" ||
          (error as { cause?: { code?: string } }).cause?.code === "23505"
        )
          throw new ApiError(
            409,
            "github_connection_exists",
            "This App or installation is already registered",
          );
        throw error;
      }
    },
  );

  app.post(
    "/v1/github/connections/:connectionId/installations",
    {
      config: {
        permission: "org:write",
        orgAdmin: true,
        auditAction: "github.installation.connected",
      },
      schema: {
        params: Params,
        body: z.object({ installationId: InstallationNumber }),
        response: { 200: z.object({ ok: z.boolean() }) },
      },
    },
    async (request) => {
      const actor = principal(request);
      const row = await load(actor.orgId, (request.params as z.infer<typeof Params>).connectionId);
      if (row.disabledAt)
        throw new ApiError(409, "github_connection_disabled", "Enable the connection first");
      const secrets = await openConnection(row, config.secretMasterKey);
      const metadata = await inspectInstallation(
        row.appId,
        secrets.privateKey,
        (request.body as { installationId: number }).installationId,
      );
      const inserted = await db
        .insert(githubInstallations)
        .values({ id: newId("ghi"), orgId: actor.orgId, connectionId: row.id, ...metadata })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length)
        throw new ApiError(409, "installation_exists", "Installation is already registered");
      return { ok: true };
    },
  );

  const Update = z.object({
    name: z.string().trim().min(1).max(100).optional(),
    disabled: z.boolean().optional(),
    secrets: ConnectionSecrets.optional(),
  });
  app.patch(
    "/v1/github/connections/:connectionId",
    {
      config: { permission: "org:write", orgAdmin: true, auditAction: "github.connection.updated" },
      schema: { params: Params, body: Update, response: { 200: Connection } },
    },
    async (request) => {
      const actor = principal(request);
      const row = await load(actor.orgId, (request.params as z.infer<typeof Params>).connectionId);
      const body = request.body as z.infer<typeof Update>;
      let credentials: string | undefined;
      let slug: string | undefined;
      if (body.secrets || body.disabled === false) {
        const secrets = body.secrets ?? (await openConnection(row, config.secretMasterKey));
        ({ slug } = await inspectApp(row.appId, secrets.privateKey));
        // Enabling must never re-store a stale copy over a concurrent rotation.
        if (body.secrets) credentials = await sealConnection(row, secrets, config.secretMasterKey);
      }
      const updated = (
        await db
          .update(githubConnections)
          .set({
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.disabled === undefined
              ? {}
              : { disabledAt: body.disabled ? new Date() : null }),
            ...(credentials ? { credentials } : {}),
            ...(slug ? { slug } : {}),
            revision: sql`${githubConnections.revision} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(githubConnections.orgId, actor.orgId),
              eq(githubConnections.id, row.id),
              eq(githubConnections.revision, row.revision),
            ),
          )
          .returning()
      )[0];
      if (!updated)
        throw new ApiError(
          409,
          "github_connection_changed",
          "Connection changed. Reload and retry.",
        );
      return present(updated);
    },
  );
}
