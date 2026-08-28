import { newId } from "@facility/core";
import { agentDefs, type FacilityDb, projects, registryItems, sandboxProfiles } from "@facility/db";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { lockBuilderPlanPolicy } from "../../builder-plan-policy.js";
import { ApiError } from "../../errors.js";
import {
  nestedDockerSettingIsValid,
  provisioningCommandsAreCoherent,
  provisioningSettingIsValid,
} from "../../sandbox/capabilities.js";
import { validateScheduleTrigger } from "../../schedules.js";
import type { Principal } from "../../types.js";
import {
  AgentDefSchema,
  AnyObject,
  assertBareRowProjectScope,
  assertPermissionsGrantable,
  IdParams,
  Ok,
  PageQuery,
  type PageQueryValue,
  principal,
  SandboxProfileSchema,
  type V1RouteContext,
} from "./shared.js";

export async function registerAgentsSandboxesRoutes(
  app: FastifyInstance,
  _context: V1RouteContext,
) {
  registerCrud(app, "/v1/projects/:projectId/agents", "agents", agentDefs, "agent");
  registerCrud(app, "/v1/sandbox-profiles", "sandboxes", sandboxProfiles, "sbx");
}

const SandboxSetup = AnyObject.superRefine((setup, context) => {
  if (!nestedDockerSettingIsValid(setup)) {
    context.addIssue({
      code: "custom",
      message: "setup.nested_docker must be a boolean",
      path: ["nested_docker"],
    });
  }
  if (!provisioningSettingIsValid(setup)) {
    context.addIssue({
      code: "custom",
      message: "setup.provisioning must be full, deps_only, or none",
      path: ["provisioning"],
    });
  }
  if (!provisioningCommandsAreCoherent(setup)) {
    context.addIssue({
      code: "custom",
      message: "setup command overrides cannot target phases disabled by setup.provisioning",
      path: ["provisioning"],
    });
  }
});

function _objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function registerCrud(
  app: FastifyInstance,
  base: string,
  permissionResource: string,
  // biome-ignore lint/suspicious/noExplicitAny: this CRUD helper is intentionally table-generic.
  table: any,
  prefix: "agent" | "sbx",
) {
  const createBody =
    prefix === "agent"
      ? z.object({
          name: z.string(),
          engine: z.string(),
          model: AnyObject.default({}),
          contractItemId: z.string(),
          harnessItemId: z.string().optional(),
          triggers: z.array(AnyObject).default([]),
          sandboxProfileId: z.string().optional(),
          // Grantable-subset checked at the handler: an agent can never carry a
          // permission its creator couldn't grant (same rule as role writes).
          permissions: z.array(z.string()).optional(),
          enabled: z.boolean().default(true),
        })
      : z.object({
          name: z.string(),
          driver: z.string(),
          image: z.string(),
          setup: SandboxSetup.default({}),
          resources: AnyObject.default({}),
          network: AnyObject.default({}),
        });
  const patchBody =
    prefix === "agent"
      ? z.object({
          name: z.string().optional(),
          engine: z.string().optional(),
          model: AnyObject.optional(),
          contractItemId: z.string().optional(),
          harnessItemId: z.string().optional(),
          triggers: z.array(AnyObject).optional(),
          sandboxProfileId: z.string().optional(),
          permissions: z.array(z.string()).optional(),
          enabled: z.boolean().optional(),
        })
      : z.object({
          name: z.string().optional(),
          driver: z.string().optional(),
          image: z.string().optional(),
          setup: SandboxSetup.optional(),
          resources: AnyObject.optional(),
          network: AnyObject.optional(),
        });
  const responseSchema = prefix === "agent" ? AgentDefSchema : SandboxProfileSchema;

  async function assertCrudProject(p: Principal, projectId: string | undefined) {
    if (!projectId) return;
    if (p.projectId && p.projectId !== projectId) {
      throw new ApiError(404, "not_found", "Project not found");
    }
    const project = (
      await app.facilityDb
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.orgId, p.orgId), eq(projects.id, projectId)))
        .limit(1)
    )[0];
    if (!project) throw new ApiError(404, "not_found", "Project not found");
  }

  async function loadCrudRowForMutation(p: Principal, id: string) {
    const row = (
      await app.facilityDb
        .select()
        .from(table)
        .where(and(eq(table.orgId, p.orgId), eq(table.id, id)))
        .limit(1)
    )[0];
    if (!row) throw new ApiError(404, "not_found", "Resource not found");
    if (table.projectId) {
      assertBareRowProjectScope(p, row.projectId, "Resource not found");
    }
    return row;
  }

  async function assertAgentReferences(
    p: Principal,
    projectId: string | undefined,
    body: { contractItemId?: string; harnessItemId?: string; sandboxProfileId?: string },
  ) {
    if (!projectId) throw new ApiError(400, "project_required", "Agent project is required");
    await assertRegistryItemInAgentProject(p, projectId, body.contractItemId, "contractItemId");
    await assertRegistryItemInAgentProject(p, projectId, body.harnessItemId, "harnessItemId");
    await assertSandboxProfileInAgentProject(p, projectId, body.sandboxProfileId);
  }

  async function assertRegistryItemInAgentProject(
    p: Principal,
    projectId: string,
    itemId: string | undefined,
    field: string,
  ) {
    if (!itemId) return;
    const item = (
      await app.facilityDb
        .select()
        .from(registryItems)
        .where(and(eq(registryItems.orgId, p.orgId), eq(registryItems.id, itemId)))
        .limit(1)
    )[0];
    if (!item || (item.projectId && item.projectId !== projectId)) {
      throw new ApiError(400, "reference_not_in_project", `${field} is not in this project`);
    }
  }

  async function assertSandboxProfileInAgentProject(
    p: Principal,
    projectId: string,
    profileId: string | undefined,
  ) {
    if (!profileId) return;
    const profile = (
      await app.facilityDb
        .select()
        .from(sandboxProfiles)
        .where(and(eq(sandboxProfiles.orgId, p.orgId), eq(sandboxProfiles.id, profileId)))
        .limit(1)
    )[0];
    if (!profile || (profile.projectId && profile.projectId !== projectId)) {
      throw new ApiError(
        400,
        "reference_not_in_project",
        "sandboxProfileId is not in this project",
      );
    }
  }

  app.get(
    base,
    {
      config: { permission: `${permissionResource}:read` },
      schema: {
        params: IdParams,
        querystring: PageQuery,
        response: { 200: z.array(responseSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const params = request.params as { projectId?: string };
      const query = request.query as PageQueryValue;
      const clauses = [eq(table.orgId, p.orgId)];
      await assertCrudProject(p, params.projectId);
      if (params.projectId && table.projectId) clauses.push(eq(table.projectId, params.projectId));
      if (!params.projectId && p.projectId && table.projectId) {
        clauses.push(eq(table.projectId, p.projectId));
      }
      return app.facilityDb
        .select()
        .from(table)
        .where(and(...clauses))
        .orderBy(asc(table.createdAt), asc(table.id))
        .limit(query.limit)
        .offset(query.offset);
    },
  );
  app.post(
    base,
    {
      config: {
        permission: `${permissionResource}:write`,
        auditAction: `${permissionResource}.updated`,
      },
      schema: { params: IdParams, body: createBody, response: { 200: responseSchema } },
    },
    async (request) => {
      const p = principal(request);
      const params = request.params as { projectId?: string };
      await assertCrudProject(p, params.projectId);
      const rowProjectId = params.projectId ?? (prefix === "sbx" ? p.projectId : undefined);
      if (rowProjectId) await assertCrudProject(p, rowProjectId);
      if (prefix === "agent") {
        const body = request.body as {
          name: string;
          engine: string;
          model: Record<string, unknown>;
          contractItemId: string;
          harnessItemId?: string;
          triggers: Record<string, unknown>[];
          sandboxProfileId?: string;
          permissions?: string[];
          enabled: boolean;
        };
        validateAgentSchedules(body.triggers);
        await assertAgentReferences(p, params.projectId, body);
        if (body.permissions) assertPermissionsGrantable(p, body.permissions);
        if (!rowProjectId) throw new ApiError(400, "project_required", "Agent project is required");
        return app.facilityDb.transaction(async (transaction) => {
          const tx = transaction as unknown as FacilityDb;
          await lockBuilderPlanPolicy(tx, p.orgId, rowProjectId);
          return (
            await tx
              .insert(table)
              .values({
                id: newId(prefix),
                orgId: p.orgId,
                projectId: rowProjectId,
                name: body.name,
                engine: body.engine,
                model: body.model,
                contractItemId: body.contractItemId,
                harnessItemId: body.harnessItemId,
                triggers: body.triggers,
                sandboxProfileId: body.sandboxProfileId,
                permissions: body.permissions ?? [],
                enabled: body.enabled,
              })
              .returning()
          )[0];
        });
      }
      const body = request.body as {
        name: string;
        driver: string;
        image: string;
        setup: Record<string, unknown>;
        resources: Record<string, unknown>;
        network: Record<string, unknown>;
      };
      return (
        await app.facilityDb
          .insert(table)
          .values({
            id: newId(prefix),
            orgId: p.orgId,
            projectId: rowProjectId,
            name: body.name,
            driver: body.driver,
            image: body.image,
            setup: body.setup,
            resources: body.resources,
            network: body.network,
          })
          .returning()
      )[0];
    },
  );
  app.patch(
    `${base}/:id`,
    {
      config: {
        permission: `${permissionResource}:write`,
        auditAction: `${permissionResource}.updated`,
      },
      schema: {
        params: z.object({ projectId: z.string().optional(), id: z.string() }),
        body: patchBody,
        response: { 200: responseSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId, id } = request.params as { projectId?: string; id: string };
      await assertCrudProject(p, projectId);
      const existing = await loadCrudRowForMutation(p, id);
      if (projectId && table.projectId && existing.projectId !== projectId) {
        throw new ApiError(404, "not_found", "Resource not found");
      }
      const clauses = [eq(table.orgId, p.orgId), eq(table.id, id)];
      if (projectId && table.projectId) clauses.push(eq(table.projectId, projectId));
      if (prefix === "agent") {
        validateAgentSchedules((request.body as { triggers?: unknown[] }).triggers ?? []);
        await assertAgentReferences(
          p,
          projectId,
          request.body as {
            contractItemId?: string;
            harnessItemId?: string;
            sandboxProfileId?: string;
          },
        );
      }
      const patchPermissions = (request.body as { permissions?: string[] }).permissions;
      if (prefix === "agent" && patchPermissions) {
        assertPermissionsGrantable(p, patchPermissions);
      }
      const set =
        prefix === "agent"
          ? crudDefinedFields({
              name: (request.body as { name?: string }).name,
              engine: (request.body as { engine?: string }).engine,
              model: (request.body as { model?: Record<string, unknown> }).model,
              contractItemId: (request.body as { contractItemId?: string }).contractItemId,
              harnessItemId: (request.body as { harnessItemId?: string }).harnessItemId,
              triggers: (request.body as { triggers?: Record<string, unknown>[] }).triggers,
              sandboxProfileId: (request.body as { sandboxProfileId?: string }).sandboxProfileId,
              permissions: patchPermissions,
              enabled: (request.body as { enabled?: boolean }).enabled,
              updatedAt: new Date(),
            })
          : crudDefinedFields({
              name: (request.body as { name?: string }).name,
              driver: (request.body as { driver?: string }).driver,
              image: (request.body as { image?: string }).image,
              setup: (request.body as { setup?: Record<string, unknown> }).setup,
              resources: (request.body as { resources?: Record<string, unknown> }).resources,
              network: (request.body as { network?: Record<string, unknown> }).network,
              updatedAt: new Date(),
            });
      const update = (database: FacilityDb) =>
        database
          .update(table)
          .set(set)
          .where(and(...clauses))
          .returning();
      if (prefix === "agent") {
        return app.facilityDb.transaction(async (transaction) => {
          const tx = transaction as unknown as FacilityDb;
          await lockBuilderPlanPolicy(tx, p.orgId, existing.projectId);
          return (await update(tx))[0];
        });
      }
      return (await update(app.facilityDb))[0];
    },
  );
  app.delete(
    `${base}/:id`,
    {
      config: {
        permission: `${permissionResource}:write`,
        auditAction: `${permissionResource}.updated`,
      },
      schema: {
        params: z.object({ projectId: z.string().optional(), id: z.string() }),
        response: { 200: Ok },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId, id } = request.params as { projectId?: string; id: string };
      await assertCrudProject(p, projectId);
      const existing = await loadCrudRowForMutation(p, id);
      if (projectId && table.projectId && existing.projectId !== projectId) {
        throw new ApiError(404, "not_found", "Resource not found");
      }
      const clauses = [eq(table.orgId, p.orgId), eq(table.id, id)];
      if (projectId && table.projectId) clauses.push(eq(table.projectId, projectId));
      if (prefix === "agent") {
        await app.facilityDb.transaction(async (transaction) => {
          const tx = transaction as unknown as FacilityDb;
          await lockBuilderPlanPolicy(tx, p.orgId, existing.projectId);
          await tx.delete(table).where(and(...clauses));
        });
      } else {
        await app.facilityDb.delete(table).where(and(...clauses));
      }
      return { ok: true };
    },
  );
}

function validateAgentSchedules(triggers: unknown[]) {
  try {
    for (const trigger of triggers) validateScheduleTrigger(trigger);
  } catch (error) {
    throw new ApiError(
      400,
      "invalid_schedule",
      error instanceof Error ? error.message : "Invalid schedule trigger",
    );
  }
}

function crudDefinedFields<T extends Record<string, unknown>>(fields: T) {
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, unknown] => entry[1] !== undefined),
  );
}
