import { newId } from "@facility/core";
import {
  agentDefs,
  githubInstallations,
  projects,
  registryItems,
  repos,
  sandboxProfiles,
  withOrg,
} from "@facility/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound } from "../../errors.js";
import { createGithubClientFactory } from "../../github/client.js";
import { projectHealth } from "../../watchtower/health.js";
import {
  AnyObject,
  assertProjectScope,
  definedFields,
  IdParams,
  Ok,
  PageQuery,
  type PageQueryValue,
  ProjectRepoSchema,
  ProjectSchema,
  principal,
  type V1RouteContext,
} from "./shared.js";

export async function registerProjectsReposRoutes(app: FastifyInstance, context: V1RouteContext) {
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
      const p = principal(request);
      const query = request.query as PageQueryValue & { status?: string };
      const clauses = [eq(projects.orgId, p.orgId)];
      if (query.status) clauses.push(eq(projects.status, query.status));
      if (p.projectId) clauses.push(eq(projects.id, p.projectId));
      return db
        .select()
        .from(projects)
        .where(and(...clauses))
        .orderBy(asc(projects.name), asc(projects.id))
        .limit(query.limit)
        .offset(query.offset);
    },
  );

  app.post(
    "/v1/projects",
    {
      config: {
        permission: "projects:write",
        auditAction: "project.created",
        idempotent: true,
      },
      schema: {
        body: z.object({
          name: z.string(),
          slug: z.string(),
          description: z.string().optional(),
          settings: AnyObject.optional(),
        }),
        response: { 200: ProjectSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const body = request.body as {
        name: string;
        slug: string;
        description?: string;
        settings?: Record<string, unknown>;
      };
      const project = (
        await db
          .insert(projects)
          .values({
            id: newId("proj"),
            orgId: p.orgId,
            name: body.name,
            slug: body.slug,
            description: body.description,
            settings: body.settings ?? { default_branch: "main", check_cmds: [] },
          })
          .returning()
      )[0];
      if (!project) throw new ApiError(500, "insert_failed", "Could not create project");
      await seedProjectHarnessAgents(p.orgId, project.id);
      return project;
    },
  );

  app.get(
    "/v1/projects/:projectId",
    {
      config: { permission: "projects:read" },
      schema: { params: IdParams, response: { 200: ProjectSchema } },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      const row = await withOrg(db, p.orgId).projects.byId(projectId);
      if (!row) throw notFound("Project not found");
      return row;
    },
  );

  app.get(
    "/v1/projects/:projectId/health",
    {
      config: { permission: "projects:read" },
      schema: {
        params: IdParams,
        response: {
          200: z.object({
            status: z.enum(["ok", "warn", "red"]),
            signals: z.array(AnyObject),
          }),
        },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      return projectHealth(db, p.orgId, projectId);
    },
  );

  app.patch(
    "/v1/projects/:projectId",
    {
      config: { permission: "projects:write", auditAction: "project.updated" },
      schema: {
        params: IdParams,
        body: z.object({
          name: z.string().optional(),
          description: z.string().optional(),
          status: z.string().optional(),
          settings: AnyObject.optional(),
        }),
        response: { 200: ProjectSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      return (
        await db
          .update(projects)
          .set(
            definedFields({
              name: (request.body as { name?: string }).name,
              description: (request.body as { description?: string }).description,
              status: (request.body as { status?: string }).status,
              settings: (request.body as { settings?: Record<string, unknown> }).settings,
              updatedAt: new Date(),
            }),
          )
          .where(and(eq(projects.orgId, p.orgId), eq(projects.id, projectId)))
          .returning()
      )[0];
    },
  );

  app.delete(
    "/v1/projects/:projectId",
    {
      config: { permission: "projects:write", auditAction: "project.deleted" },
      schema: { params: IdParams, response: { 200: Ok } },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      await db
        .update(projects)
        .set({ status: "archived", updatedAt: new Date() })
        .where(and(eq(projects.orgId, p.orgId), eq(projects.id, projectId)));
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
        response: { 200: z.array(ProjectRepoSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      const query = request.query as PageQueryValue;
      return db
        .select()
        .from(repos)
        .where(and(eq(repos.orgId, p.orgId), eq(repos.projectId, projectId)))
        .orderBy(asc(repos.createdAt), asc(repos.id))
        .limit(query.limit)
        .offset(query.offset);
    },
  );

  app.post(
    "/v1/projects/:projectId/repos",
    {
      config: { permission: "repos:write", auditAction: "repo.added" },
      schema: {
        params: IdParams,
        body: z.object({
          owner: z.string(),
          name: z.string(),
          defaultBranch: z.string().default("main"),
          mode: z.enum(["connect", "create"]).optional(),
          create: z.boolean().optional(),
          private: z.boolean().default(true),
          description: z.string().optional(),
          autoInit: z.boolean().default(true),
        }),
        response: { 200: ProjectRepoSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
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
      const creation = body.create === true || body.mode === "create";
      const installation = await loadGithubInstallation(p.orgId, body.owner);
      const githubRepo = creation
        ? await createGithubRepository({
            installationId: installation.installationId,
            owner: body.owner,
            name: body.name,
            description: body.description,
            private: body.private,
            autoInit: body.autoInit,
          })
        : await loadGithubRepository({
            installationId: installation.installationId,
            owner: body.owner,
            name: body.name,
          });
      const row = (
        await db
          .insert(repos)
          .values({
            id: newId("repo"),
            orgId: p.orgId,
            projectId,
            installationId: installation.id,
            owner: githubRepo.owner,
            name: githubRepo.name,
            defaultBranch: githubRepo.defaultBranch ?? body.defaultBranch,
          })
          .returning()
      )[0];
      if (row) {
        await app.enqueue("github.issues-sync", { repoId: row.id, orgId: p.orgId });
      }
      return row;
    },
  );

  async function loadGithubInstallation(orgId: string, owner: string) {
    const installation = await findGithubInstallation(orgId, owner);
    if (!installation) {
      throw new ApiError(
        400,
        "github_installation_required",
        "A GitHub App installation for this owner is required to connect or create repositories",
      );
    }
    return installation;
  }

  async function findGithubInstallation(orgId: string, owner: string) {
    return (
      await db
        .select()
        .from(githubInstallations)
        .where(
          and(
            eq(githubInstallations.orgId, orgId),
            eq(githubInstallations.accountLogin, owner),
            isNull(githubInstallations.suspendedAt),
          ),
        )
        .limit(1)
    )[0];
  }

  async function loadGithubRepository(input: {
    installationId: number;
    owner: string;
    name: string;
  }) {
    const factory = app.githubClientFactory ?? createGithubClientFactory(context.config);
    const octokit = await factory(input.installationId);
    if (!octokit.rest.repos.get) {
      throw new ApiError(500, "github_lookup_unavailable", "GitHub repository lookup unavailable");
    }
    try {
      const response = await octokit.rest.repos.get({ owner: input.owner, repo: input.name });
      return {
        owner: response.data.owner?.login ?? input.owner,
        name: response.data.name,
        defaultBranch: response.data.default_branch ?? "main",
      };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        (error as { status?: unknown }).status === 404
      ) {
        throw new ApiError(
          400,
          "github_repo_not_found",
          `GitHub repository ${input.owner}/${input.name} was not found in the App installation`,
        );
      }
      throw error;
    }
  }

  async function createGithubRepository(input: {
    installationId: number;
    owner: string;
    name: string;
    description?: string;
    private: boolean;
    autoInit: boolean;
  }) {
    const factory = app.githubClientFactory ?? createGithubClientFactory(context.config);
    const octokit = await factory(input.installationId);
    if (!octokit.rest.repos.createInOrg) {
      throw new ApiError(
        500,
        "github_create_unavailable",
        "GitHub repository creation unavailable",
      );
    }
    const response = await octokit.rest.repos.createInOrg({
      org: input.owner,
      name: input.name,
      private: input.private,
      description: input.description,
      auto_init: input.autoInit,
    });
    return {
      owner: response.data.owner?.login ?? input.owner,
      name: response.data.name,
      defaultBranch: response.data.default_branch ?? "main",
    };
  }

  app.delete(
    "/v1/projects/:projectId/repos/:repoId",
    {
      config: { permission: "repos:write", auditAction: "repo.removed" },
      schema: {
        params: z.object({ projectId: z.string(), repoId: z.string() }),
        response: { 200: Ok },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId, repoId } = request.params as { projectId: string; repoId: string };
      await db
        .delete(repos)
        .where(and(eq(repos.orgId, p.orgId), eq(repos.projectId, projectId), eq(repos.id, repoId)));
      return { ok: true };
    },
  );

  async function seedProjectHarnessAgents(orgId: string, projectId: string) {
    const items = await db
      .select()
      .from(registryItems)
      .where(and(eq(registryItems.orgId, orgId), eq(registryItems.scope, "bundled")));
    const byName = new Map(items.map((item) => [item.name, item]));
    const sandbox = (
      await db
        .select()
        .from(sandboxProfiles)
        .where(eq(sandboxProfiles.orgId, orgId))
        .orderBy(asc(sandboxProfiles.createdAt))
        .limit(1)
    )[0];
    const productChain = byName.get("product-chain");
    const poContract = byName.get("po-agent");
    const learningContract = byName.get("learning-agent");
    if (productChain && poContract) {
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId,
          name: "project-owner",
          engine: "claude_code",
          model: { model: "claude-sonnet-5" },
          contractItemId: poContract.id,
          harnessItemId: productChain.id,
          triggers: [
            { type: "schedule", config: { cron: "0 6 * * *", timezone: "UTC" } },
            { type: "manual", config: {} },
          ],
          sandboxProfileId: sandbox?.id,
          permissions: ["kb:write", "tasks:write", "hitl:write"],
          enabled: true,
        })
        .onConflictDoNothing();
    }
    if (learningContract) {
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId,
          name: "learning",
          engine: "codex",
          model: { primary: "gpt-5.5" },
          contractItemId: learningContract.id,
          harnessItemId: productChain?.id,
          triggers: [{ type: "schedule", config: { cron: "0 3 * * *", timezone: "UTC" } }],
          sandboxProfileId: sandbox?.id,
          permissions: ["runs:read", "hitl:write", "kb:read"],
          enabled: true,
        })
        .onConflictDoNothing();
    }
  }
}
