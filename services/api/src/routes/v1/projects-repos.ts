import { newId } from "@facility/core";
import {
  agentDefs,
  analysisSandboxProfileId,
  builderSandboxProfileId,
  defaultSandboxProfileId,
  type FacilityDb,
  githubInstallations,
  projects,
  registryItems,
  repos,
  runs,
  sandboxProfiles,
  withOrg,
} from "@facility/db";
import { and, asc, eq, isNull, notInArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { lockBuilderPlanPolicy } from "../../builder-plan-policy.js";
import { ApiError, notFound } from "../../errors.js";
import { laneFor } from "../../github/agent-routing.js";
import { createGithubClientFactory } from "../../github/client.js";
import { ensureProjectKbSpace } from "../../harness.js";
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
          builderPlanPolicy: z.enum(["optional", "required"]).optional(),
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
        builderPlanPolicy?: "optional" | "required";
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
            builderPlanPolicy: body.builderPlanPolicy ?? "optional",
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
            classification: z.enum(["healthy", "degraded", "unhealthy"]),
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
          builderPlanPolicy: z.enum(["optional", "required"]).optional(),
          settings: AnyObject.optional(),
        }),
        response: { 200: ProjectSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const requestedPolicy = (request.body as { builderPlanPolicy?: "optional" | "required" })
        .builderPlanPolicy;
      return db.transaction(async (transaction) => {
        const tx = transaction as unknown as FacilityDb;
        await lockBuilderPlanPolicy(tx, p.orgId, projectId);
        const currentProject = (
          await tx
            .select({ policy: projects.builderPlanPolicy })
            .from(projects)
            .where(and(eq(projects.orgId, p.orgId), eq(projects.id, projectId)))
            .limit(1)
        )[0];
        if (!currentProject) throw notFound("Project not found");
        if (requestedPolicy === "required" && currentProject.policy !== "required") {
          await assertPlatformBuilderLanes(tx, p.orgId, projectId);
          await assertNoActiveRuns(tx, p.orgId, projectId);
        }
        return (
          await tx
            .update(projects)
            .set(
              definedFields({
                name: (request.body as { name?: string }).name,
                description: (request.body as { description?: string }).description,
                status: (request.body as { status?: string }).status,
                builderPlanPolicy: (request.body as { builderPlanPolicy?: "optional" | "required" })
                  .builderPlanPolicy,
                settings: (request.body as { settings?: Record<string, unknown> }).settings,
                updatedAt: new Date(),
              }),
            )
            .where(and(eq(projects.orgId, p.orgId), eq(projects.id, projectId)))
            .returning()
        )[0];
      });
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
      const project = (
        await db
          .select({ policy: projects.builderPlanPolicy })
          .from(projects)
          .where(and(eq(projects.orgId, p.orgId), eq(projects.id, projectId)))
          .limit(1)
      )[0];
      if (!project) throw notFound("Project not found");
      if (project.policy === "required") {
        throw new ApiError(
          409,
          "builder_plan_platform_lane_required",
          "Set Builder plan policy to optional before connecting a repository; configure its Builder lane as platform, then re-enable required",
        );
      }
      const creation = body.create === true || body.mode === "create";
      const installation = await loadGithubInstallation(p.orgId, body.owner);
      const row = await db.transaction(async (transaction) => {
        const tx = transaction as unknown as FacilityDb;
        await lockBuilderPlanPolicy(tx, p.orgId, projectId);
        const currentProject = (
          await tx
            .select({ policy: projects.builderPlanPolicy })
            .from(projects)
            .where(and(eq(projects.orgId, p.orgId), eq(projects.id, projectId)))
            .limit(1)
        )[0];
        if (!currentProject) throw notFound("Project not found");
        if (currentProject.policy === "required") {
          throw new ApiError(
            409,
            "builder_plan_platform_lane_required",
            "Set Builder plan policy to optional before connecting a repository; configure its Builder lane as platform, then re-enable required",
          );
        }
        // Keep the project lock through the remote create/load and local insert.
        // Activation cannot slip between the final policy read and the new,
        // initially-unverified repository row becoming visible.
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
        return (
          await tx
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
      });
      if (row) {
        await app.enqueue("github.issues-sync", { repoId: row.id, orgId: p.orgId });
      }
      return row;
    },
  );

  async function assertPlatformBuilderLanes(
    database: FacilityDb,
    orgId: string,
    projectId: string,
  ) {
    const projectRepos = await database
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.projectId, projectId)));
    const now = Date.now();
    const incompatible = projectRepos.filter(
      (repo) =>
        laneFor(repo, "builder") !== "platform" ||
        laneFor(repo, "codex-builder") !== "platform" ||
        !repo.fingerprint ||
        repo.fingerprintStatus !== "ok" ||
        !repo.fingerprintVerifiedAt ||
        now - repo.fingerprintVerifiedAt.getTime() > 5 * 60_000,
    );
    if (incompatible.length > 0) {
      throw new ApiError(
        409,
        "builder_plan_platform_lane_required",
        "Builder plan policy required needs a recent verified default-branch Facility fingerprint and platform lanes for /builder and /codex-builder in every connected repository",
        {
          repos: incompatible.map((repo) => ({
            repo: `${repo.owner}/${repo.name}`,
            fingerprintStatus: repo.fingerprintStatus,
            fingerprintVerifiedAt: repo.fingerprintVerifiedAt?.toISOString() ?? null,
          })),
        },
      );
    }
  }

  async function assertNoActiveRuns(database: FacilityDb, orgId: string, projectId: string) {
    const active = await database
      .select({
        id: runs.id,
      })
      .from(runs)
      .where(
        and(
          eq(runs.orgId, orgId),
          eq(runs.projectId, projectId),
          notInArray(runs.status, ["succeeded", "failed", "canceled"]),
        ),
      );
    if (active.length > 0) {
      throw new ApiError(
        409,
        "builder_plan_active_runs_present",
        "Wait for every existing run to finish before enabling the required plan policy",
        { runIds: active.map((run) => run.id) },
      );
    }
  }

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
      await db.transaction(async (transaction) => {
        const tx = transaction as unknown as FacilityDb;
        await lockBuilderPlanPolicy(tx, p.orgId, projectId);
        await tx
          .delete(repos)
          .where(
            and(eq(repos.orgId, p.orgId), eq(repos.projectId, projectId), eq(repos.id, repoId)),
          );
      });
      return { ok: true };
    },
  );

  async function seedProjectHarnessAgents(orgId: string, projectId: string) {
    const items = await db
      .select()
      .from(registryItems)
      .where(and(eq(registryItems.orgId, orgId), eq(registryItems.scope, "bundled")));
    const byName = new Map(items.map((item) => [item.name, item]));
    const availableSandboxes = await db
      .select()
      .from(sandboxProfiles)
      .where(and(eq(sandboxProfiles.orgId, orgId), isNull(sandboxProfiles.projectId)))
      .orderBy(asc(sandboxProfiles.createdAt));
    const defaultSandbox =
      availableSandboxes.find((profile) => profile.id === defaultSandboxProfileId(orgId)) ??
      availableSandboxes[0];
    const analysisSandbox =
      availableSandboxes.find((profile) => profile.id === analysisSandboxProfileId(orgId)) ??
      defaultSandbox;
    const builderSandbox =
      availableSandboxes.find((profile) => profile.id === builderSandboxProfileId(orgId)) ??
      defaultSandbox;
    const productChain = byName.get("product-chain");
    const poContract = byName.get("po-agent");
    const learningContract = byName.get("learning-agent");
    if (productChain && (poContract || learningContract)) {
      await ensureProjectKbSpace(db, orgId, projectId);
    }
    const existingAgentNames = new Set(
      (
        await db
          .select({ name: agentDefs.name })
          .from(agentDefs)
          .where(and(eq(agentDefs.orgId, orgId), eq(agentDefs.projectId, projectId)))
      ).map((agent) => agent.name),
    );
    const crew = [
      {
        name: "architect",
        sandbox: "analysis",
        engine: "claude_code",
        model: { model: "claude-sonnet-5" },
        contract: "prompts/architect",
        triggers: [
          { type: "github", command: "architect" },
          { type: "manual", config: {} },
        ],
      },
      {
        name: "builder",
        sandbox: "builder",
        engine: "claude_code",
        model: { model: "claude-fable-5" },
        contract: "prompts/builder",
        triggers: [
          { type: "github", command: "builder" },
          { type: "manual", config: {} },
        ],
      },
      {
        name: "codex-architect",
        sandbox: "analysis",
        engine: "codex",
        model: { primary: "gpt-5.6-sol", reasoning_effort: "high" },
        contract: "prompts/architect",
        triggers: [
          { type: "github", command: "codex-architect" },
          { type: "manual", config: {} },
        ],
      },
      {
        name: "codex-builder",
        sandbox: "builder",
        engine: "codex",
        model: { primary: "gpt-5.6-sol", reasoning_effort: "high" },
        contract: "prompts/builder",
        triggers: [
          { type: "github", command: "codex-builder" },
          { type: "manual", config: {} },
        ],
      },
      {
        name: "review",
        sandbox: "analysis",
        engine: "claude_code",
        model: { model: "claude-sonnet-5" },
        contract: "prompts/review",
        triggers: [{ type: "github", event: "pull_request", action: "ready_for_review" }],
      },
      {
        name: "address-review",
        sandbox: "builder",
        engine: "claude_code",
        model: { model: "claude-sonnet-5" },
        contract: "prompts/address-review",
        triggers: [{ type: "github", event: "pull_request_review", action: "submitted" }],
      },
      {
        name: "ci-doctor",
        sandbox: "builder",
        engine: "claude_code",
        model: { model: "claude-sonnet-5" },
        contract: "prompts/doctor",
        triggers: [{ type: "github", event: "workflow_run", action: "completed" }],
      },
      {
        name: "security-sweep",
        sandbox: "analysis",
        engine: "claude_code",
        model: { model: "claude-sonnet-5" },
        contract: "prompts/sweep",
        triggers: [{ type: "schedule", config: { cron: "0 5 * * 1", timezone: "UTC" } }],
      },
    ] as const;
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
          sandboxProfileId: defaultSandbox?.id,
          // Read grants are explicit (write does not imply read in can()): the
          // PO reads its KB, the pipeline, and delegated runs, and may
          // dispatch a read-only architect consult.
          permissions: [
            "kb:read",
            "kb:write",
            "tasks:read",
            "tasks:write",
            "hitl:write",
            "runs:read",
            "runs:trigger",
          ],
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
          sandboxProfileId: defaultSandbox?.id,
          permissions: ["runs:read", "hitl:write", "kb:read"],
          enabled: true,
        })
        .onConflictDoNothing();
    }
    for (const spec of crew) {
      const contract = byName.get(spec.contract);
      if (!contract || existingAgentNames.has(spec.name)) continue;
      await db.insert(agentDefs).values({
        id: newId("agent"),
        orgId,
        projectId,
        name: spec.name,
        engine: spec.engine,
        model: spec.model,
        contractItemId: contract.id,
        triggers: [...spec.triggers],
        // This is a seed-time assignment, not run-time mode inference. Operators
        // can replace it through the existing agent/profile APIs. Keep the
        // managed sets aligned with read-only and delivery repository modes.
        // Delivery agents retain nested Docker but provision services on demand.
        sandboxProfileId:
          spec.sandbox === "analysis"
            ? analysisSandbox?.id
            : spec.sandbox === "builder"
              ? builderSandbox?.id
              : defaultSandbox?.id,
        permissions: ["runs:read"],
        enabled: true,
      });
    }
  }
}
