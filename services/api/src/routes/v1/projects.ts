import { newId } from "@facility/core";
import { type FacilityDb, githubInstallations, projectRepositories, projects } from "@facility/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound } from "../../errors.js";
import { createGithubClientFactory } from "../../github/client.js";
import {
  AnyObject,
  DateValue,
  definedFields,
  IdParams,
  Ok,
  PageQuery,
  type PageQueryValue,
  principal,
  type V1RouteContext,
} from "./shared.js";

const ProjectSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  settings: AnyObject,
  status: z.string(),
  createdAt: DateValue,
  updatedAt: DateValue,
});

const RepositorySchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  installationId: z.string().nullable(),
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
  role: z.enum(["primary", "related"]),
  createdAt: DateValue,
  updatedAt: DateValue,
});

export async function registerProjectRoutes(app: FastifyInstance, context: V1RouteContext) {
  const { db } = context;

  app.get(
    "/v1/projects",
    {
      config: { permission: "projects:read" },
      schema: {
        querystring: PageQuery.extend({ status: z.string().optional() }),
        response: { 200: z.array(ProjectSchema) },
      },
    },
    async (request) => {
      const actor = principal(request);
      const query = request.query as PageQueryValue & { status?: string };
      const filters = [eq(projects.orgId, actor.orgId)];
      if (query.status) filters.push(eq(projects.status, query.status));
      if (actor.projectId) filters.push(eq(projects.id, actor.projectId));
      return db
        .select(projectColumns)
        .from(projects)
        .where(and(...filters))
        .orderBy(asc(projects.name), asc(projects.id))
        .limit(query.limit)
        .offset(query.offset);
    },
  );

  app.post(
    "/v1/projects",
    {
      config: { permission: "projects:write", auditAction: "project.created", idempotent: true },
      schema: {
        body: z.object({
          name: z.string().min(1).max(160),
          slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          description: z.string().max(2_000).optional(),
          settings: AnyObject.optional(),
        }),
        response: { 200: ProjectSchema },
      },
    },
    async (request) => {
      const actor = principal(request);
      const body = request.body as {
        name: string;
        slug: string;
        description?: string;
        settings?: Record<string, unknown>;
      };
      const row = (
        await db
          .insert(projects)
          .values({
            id: newId("proj"),
            orgId: actor.orgId,
            name: body.name,
            slug: body.slug,
            description: body.description,
            settings: body.settings ?? {},
          })
          .returning(projectColumns)
      )[0];
      if (!row) throw new ApiError(500, "insert_failed", "Could not create project");
      return row;
    },
  );

  app.get(
    "/v1/projects/:projectId",
    {
      config: { permission: "projects:read" },
      schema: { params: IdParams, response: { 200: ProjectSchema } },
    },
    async (request) => loadProject(db, principal(request).orgId, projectId(request)),
  );

  app.patch(
    "/v1/projects/:projectId",
    {
      config: { permission: "projects:write", auditAction: "project.updated", idempotent: true },
      schema: {
        params: IdParams,
        body: z.object({
          name: z.string().min(1).max(160).optional(),
          description: z.string().max(2_000).nullable().optional(),
          settings: AnyObject.optional(),
        }),
        response: { 200: ProjectSchema },
      },
    },
    async (request) => {
      const actor = principal(request);
      const id = projectId(request);
      const body = request.body as {
        name?: string;
        description?: string | null;
        settings?: Record<string, unknown>;
      };
      const row = (
        await db
          .update(projects)
          .set(definedFields({ ...body, updatedAt: new Date() }))
          .where(and(eq(projects.orgId, actor.orgId), eq(projects.id, id)))
          .returning(projectColumns)
      )[0];
      if (!row) throw notFound("Project not found");
      return row;
    },
  );

  app.delete(
    "/v1/projects/:projectId",
    {
      config: { permission: "projects:write", auditAction: "project.archived", idempotent: true },
      schema: { params: IdParams, response: { 200: Ok } },
    },
    async (request) => {
      const actor = principal(request);
      await db
        .update(projects)
        .set({ status: "archived", updatedAt: new Date() })
        .where(and(eq(projects.orgId, actor.orgId), eq(projects.id, projectId(request))));
      return { ok: true };
    },
  );

  app.get(
    "/v1/projects/:projectId/repos",
    {
      config: { permission: "repos:read" },
      schema: {
        params: IdParams,
        querystring: PageQuery,
        response: { 200: z.array(RepositorySchema) },
      },
    },
    async (request) => {
      const actor = principal(request);
      const query = request.query as PageQueryValue;
      return db
        .select()
        .from(projectRepositories)
        .where(
          and(
            eq(projectRepositories.orgId, actor.orgId),
            eq(projectRepositories.projectId, projectId(request)),
          ),
        )
        .orderBy(asc(projectRepositories.role), asc(projectRepositories.createdAt))
        .limit(query.limit)
        .offset(query.offset);
    },
  );

  app.post(
    "/v1/projects/:projectId/repos",
    {
      config: { permission: "repos:write", auditAction: "repo.added", idempotent: true },
      schema: {
        params: IdParams,
        body: z.object({
          owner: z.string().min(1).max(100),
          name: z.string().min(1).max(100),
          defaultBranch: z.string().min(1).max(200).default("main"),
          mode: z.enum(["connect", "create"]).optional(),
          create: z.boolean().optional(),
          private: z.boolean().default(true),
          description: z.string().max(2_000).optional(),
          autoInit: z.boolean().default(true),
        }),
        response: { 200: RepositorySchema },
      },
    },
    async (request) => {
      const actor = principal(request);
      const id = projectId(request);
      await loadProject(db, actor.orgId, id);
      const body = request.body as {
        owner: string;
        name: string;
        defaultBranch: string;
        mode?: "connect" | "create";
        create?: boolean;
        private: boolean;
        description?: string;
        autoInit: boolean;
      };
      const installation = (
        await db
          .select()
          .from(githubInstallations)
          .where(
            and(
              eq(githubInstallations.orgId, actor.orgId),
              eq(githubInstallations.accountLogin, body.owner),
              isNull(githubInstallations.suspendedAt),
            ),
          )
          .limit(1)
      )[0];
      if (!installation) {
        throw new ApiError(
          400,
          "github_installation_required",
          "A GitHub App installation for this repository owner is required",
        );
      }
      const repository = await resolveGithubRepository(
        app,
        context,
        installation.installationId,
        body,
      );
      return db.transaction(async (transaction) => {
        const tx = transaction as unknown as FacilityDb;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${actor.orgId}:${id}`}))`);
        const primary = (
          await tx
            .select({ id: projectRepositories.id })
            .from(projectRepositories)
            .where(
              and(
                eq(projectRepositories.orgId, actor.orgId),
                eq(projectRepositories.projectId, id),
                eq(projectRepositories.role, "primary"),
              ),
            )
            .limit(1)
        )[0];
        const row = (
          await tx
            .insert(projectRepositories)
            .values({
              id: newId("repo"),
              orgId: actor.orgId,
              projectId: id,
              installationId: installation.id,
              owner: repository.owner,
              name: repository.name,
              defaultBranch: repository.defaultBranch ?? body.defaultBranch,
              role: primary ? "related" : "primary",
            })
            .returning()
        )[0];
        if (!row) throw new ApiError(500, "insert_failed", "Could not connect repository");
        return row;
      });
    },
  );

  app.delete(
    "/v1/projects/:projectId/repos/:repoId",
    {
      config: { permission: "repos:write", auditAction: "repo.removed", idempotent: true },
      schema: {
        params: z.object({ projectId: z.string(), repoId: z.string() }),
        response: { 200: Ok },
      },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId: id, repoId } = request.params as { projectId: string; repoId: string };
      await db.transaction(async (transaction) => {
        const tx = transaction as unknown as FacilityDb;
        const removed = (
          await tx
            .delete(projectRepositories)
            .where(
              and(
                eq(projectRepositories.orgId, actor.orgId),
                eq(projectRepositories.projectId, id),
                eq(projectRepositories.id, repoId),
              ),
            )
            .returning({ role: projectRepositories.role })
        )[0];
        if (removed?.role === "primary") {
          const replacement = (
            await tx
              .select({ id: projectRepositories.id })
              .from(projectRepositories)
              .where(
                and(
                  eq(projectRepositories.orgId, actor.orgId),
                  eq(projectRepositories.projectId, id),
                ),
              )
              .orderBy(asc(projectRepositories.createdAt))
              .limit(1)
          )[0];
          if (replacement) {
            await tx
              .update(projectRepositories)
              .set({ role: "primary", updatedAt: new Date() })
              .where(eq(projectRepositories.id, replacement.id));
          }
        }
      });
      return { ok: true };
    },
  );
}

const projectColumns = {
  id: projects.id,
  orgId: projects.orgId,
  name: projects.name,
  slug: projects.slug,
  description: projects.description,
  settings: projects.settings,
  status: projects.status,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
};

async function loadProject(db: FacilityDb, orgId: string, id: string) {
  const row = (
    await db
      .select(projectColumns)
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.id, id)))
      .limit(1)
  )[0];
  if (!row) throw notFound("Project not found");
  return row;
}

function projectId(request: { params: unknown }) {
  return (request.params as { projectId: string }).projectId;
}

async function resolveGithubRepository(
  app: FastifyInstance,
  context: V1RouteContext,
  installationId: number,
  body: {
    owner: string;
    name: string;
    mode?: "connect" | "create";
    create?: boolean;
    private: boolean;
    description?: string;
    autoInit: boolean;
  },
) {
  const factory = app.githubClientFactory ?? createGithubClientFactory(context.config);
  const octokit = await factory(installationId);
  if (body.create === true || body.mode === "create") {
    if (!octokit.rest.repos.createInOrg) {
      throw new ApiError(
        500,
        "github_create_unavailable",
        "GitHub repository creation unavailable",
      );
    }
    const response = await octokit.rest.repos.createInOrg({
      org: body.owner,
      name: body.name,
      private: body.private,
      description: body.description,
      auto_init: body.autoInit,
    });
    return {
      owner: response.data.owner?.login ?? body.owner,
      name: response.data.name,
      defaultBranch: response.data.default_branch ?? "main",
    };
  }
  if (!octokit.rest.repos.get) {
    throw new ApiError(500, "github_lookup_unavailable", "GitHub repository lookup unavailable");
  }
  try {
    const response = await octokit.rest.repos.get({ owner: body.owner, repo: body.name });
    return {
      owner: response.data.owner?.login ?? body.owner,
      name: response.data.name,
      defaultBranch: response.data.default_branch ?? "main",
    };
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      throw new ApiError(
        400,
        "github_repo_not_found",
        `GitHub repository ${body.owner}/${body.name} is not available to the App installation`,
      );
    }
    throw error;
  }
}
