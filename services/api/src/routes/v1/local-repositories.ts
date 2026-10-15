import { basename } from "node:path";
import { can, newId } from "@facility/core";
import { type FacilityDb, projectRepositories, projects } from "@facility/db";
import { and, eq, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound } from "../../errors.js";
import { LocalRepositoryError } from "../../repositories/local.js";
import { localKickstart } from "../../repositories/local-kickstart.js";
import { LocalReviewError } from "../../repositories/local-review.js";
import { isLocalAlias, LOCAL_REPOSITORY_OWNER } from "../../repositories/sources.js";
import { principal, type V1RouteContext } from "./shared.js";

const ProjectParams = z.object({ projectId: z.string() });
const RepositoryParams = z.object({ projectId: z.string(), repoId: z.string() });
const StoryParams = z.object({ projectId: z.string(), storyId: z.string() });
const ExportParams = StoryParams.extend({ exportId: z.string() });
const Sha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);

const RegisterLocalRepositoryBody = z.object({
  /** Absolute path on the machine running Facility, under an approved root. */
  path: z.string().min(1).max(4_096),
  /** Name used as `local:<alias>` in .facility.yml; defaults to the directory name. */
  alias: z.string().min(1).max(100).optional(),
  /** Defaults to the branch currently checked out in the repository. */
  defaultBranch: z.string().min(1).max(200).optional(),
});

const KickstartAnswers = z.object({
  provisionCmd: z.string().max(4_000).optional(),
  startCmd: z.string().min(1).max(4_000).optional(),
  readyCmd: z.string().min(1).max(4_000).optional(),
  servicePort: z.number().int().min(1).max(65_535).optional(),
  models: z
    .object({
      build: z.string().min(1).max(160).optional(),
      review: z.string().min(1).max(160).optional(),
      plan: z.string().min(1).max(160).optional(),
      codexBuild: z.string().min(1).max(160).optional(),
      codexPlan: z.string().min(1).max(160).optional(),
    })
    .strict()
    .optional(),
});

type Actor = { type: "user" | "service" | "system"; id: string };

export async function registerLocalRepositoryRoutes(app: FastifyInstance, context: V1RouteContext) {
  const { db } = context;
  const domain = app.storyDomain;
  const host = () => domain.localRepositories.host;

  app.get(
    "/v1/local-repositories/status",
    {
      config: { permission: "repos:write" },
      schema: { operationId: "getLocalRepositoryStatus" },
    },
    async () => ({
      enabled: host().enabled,
      roots: context.config.localRepositoryRoots ?? [],
      workspaceDriver: context.config.workspaceDriver,
    }),
  );

  app.post(
    "/v1/projects/:projectId/repos/local",
    {
      config: { permission: "repos:write", auditAction: "repo.local_added", idempotent: true },
      schema: {
        params: ProjectParams,
        body: RegisterLocalRepositoryBody,
        operationId: "registerLocalRepository",
      },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId } = request.params as z.infer<typeof ProjectParams>;
      const body = request.body as z.infer<typeof RegisterLocalRepositoryBody>;
      await activeProject(db, actor.orgId, projectId);
      // Validation reads Git metadata only; no hook, setup, or repository command runs.
      const inspection = await translate(() => host().inspect(body.path, body.defaultBranch));
      const alias = body.alias ?? basename(inspection.path).replace(/\.git$/i, "");
      if (!isLocalAlias(alias)) {
        throw new ApiError(
          400,
          "local_repository_alias_invalid",
          "Use an alias of letters, digits, '.', '_' or '-' that does not end in .git",
        );
      }
      const row = await db.transaction(async (transaction) => {
        const tx = transaction as unknown as FacilityDb;
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${actor.orgId}:${projectId}`}))`,
        );
        // One organization owns a host path: another tenant can never register it.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`facility:local-path:${inspection.path}`}))`,
        );
        const claimed = await tx
          .select({ id: projectRepositories.id })
          .from(projectRepositories)
          .where(
            and(
              eq(projectRepositories.source, "local"),
              eq(projectRepositories.sourcePath, inspection.path),
              ne(projectRepositories.orgId, actor.orgId),
            ),
          )
          .limit(1);
        if (claimed.length > 0) {
          throw new ApiError(
            409,
            "local_repository_claimed",
            "This repository path is registered by another organization",
          );
        }
        const existing = await tx
          .select({
            role: projectRepositories.role,
            source: projectRepositories.source,
            name: projectRepositories.name,
            sourcePath: projectRepositories.sourcePath,
          })
          .from(projectRepositories)
          .where(
            and(
              eq(projectRepositories.orgId, actor.orgId),
              eq(projectRepositories.projectId, projectId),
            ),
          );
        if (existing.some((repository) => repository.source !== "local")) {
          throw new ApiError(
            409,
            "repository_sources_mixed",
            "This project uses GitHub repositories; create a separate project for local repositories",
          );
        }
        if (
          existing.some(
            (repository) =>
              repository.sourcePath === inspection.path ||
              repository.name.toLowerCase() === alias.toLowerCase(),
          )
        ) {
          throw new ApiError(
            409,
            "local_repository_exists",
            "This project already has a local repository with that path or alias",
          );
        }
        return (
          await tx
            .insert(projectRepositories)
            .values({
              id: newId("repo"),
              orgId: actor.orgId,
              projectId,
              installationId: null,
              owner: LOCAL_REPOSITORY_OWNER,
              name: alias,
              defaultBranch: inspection.defaultBranch,
              role: existing.some((repository) => repository.role === "primary")
                ? "related"
                : "primary",
              source: "local",
              sourcePath: inspection.path,
            })
            .returning()
        )[0];
      });
      if (!row) throw new ApiError(500, "insert_failed", "Could not register repository");
      return {
        ...row,
        headSha: inspection.headSha,
        warnings: inspection.warnings,
        manifestName: `local:${row.name}`,
        // Stated before any import: uncommitted and untracked files are not part of the source.
        importContract:
          "Facility imports committed history from the default branch only. Uncommitted and untracked files in your checkout are never copied.",
      };
    },
  );

  app.post(
    "/v1/projects/:projectId/repos/:repoId/local-kickstart",
    {
      config: { permission: "projects:kickstart" },
      schema: {
        params: RepositoryParams,
        body: z.object({ answers: KickstartAnswers.default({}) }),
        operationId: "previewLocalKickstart",
      },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId, repoId } = request.params as z.infer<typeof RepositoryParams>;
      const body = request.body as { answers: z.infer<typeof KickstartAnswers> };
      const repository = await translate(() =>
        domain.localRepositories.repository(actor.orgId, projectId, repoId),
      );
      return translate(() => localKickstart(host(), repository, body.answers));
    },
  );

  const reviewBase = "/v1/projects/:projectId/workspace-stories/:storyId/local-review";

  app.get(
    reviewBase,
    {
      config: { permission: "stories:read" },
      schema: { params: StoryParams, operationId: "getLocalReview" },
    },
    async (request, reply) => {
      const actor = principal(request);
      const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
      reply.header("cache-control", "private, no-store");
      // Reading never resumes suspended compute for someone who cannot run workspaces.
      return translate(() =>
        domain.localReview.state(actor.orgId, projectId, storyId, {
          wake: can(actor.permissions, "workspaces:execute"),
        }),
      );
    },
  );

  app.post(
    `${reviewBase}/approve`,
    {
      config: { permission: "stories:write", auditAction: "story.local_review.approved" },
      schema: {
        params: StoryParams,
        body: z.object({ commit_sha: Sha, note: z.string().max(4_000).optional() }),
        operationId: "approveLocalReview",
      },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
      const body = request.body as { commit_sha: string; note?: string };
      return translate(() =>
        domain.localReview.approve(
          { orgId: actor.orgId, projectId, storyId, commitSha: body.commit_sha, note: body.note },
          reviewActor(actor),
        ),
      );
    },
  );

  app.post(
    `${reviewBase}/request-changes`,
    {
      config: { permission: "stories:write", auditAction: "story.local_review.changes_requested" },
      schema: {
        params: StoryParams,
        body: z.object({ commit_sha: Sha.optional(), note: z.string().trim().min(1).max(4_000) }),
        operationId: "requestLocalReviewChanges",
      },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
      const body = request.body as { commit_sha?: string; note: string };
      return translate(() =>
        domain.localReview.requestChanges(
          { orgId: actor.orgId, projectId, storyId, commitSha: body.commit_sha, note: body.note },
          reviewActor(actor),
        ),
      );
    },
  );

  app.post(
    `${reviewBase}/checks`,
    {
      config: { permission: "workspaces:execute", auditAction: "story.local_checks.run" },
      schema: { params: StoryParams, operationId: "runLocalReviewChecks" },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
      return translate(() =>
        domain.localReview.runChecks({ orgId: actor.orgId, projectId, storyId }),
      );
    },
  );

  app.post(
    `${reviewBase}/refresh-source`,
    {
      config: { permission: "workspaces:execute", auditAction: "story.local_source.refreshed" },
      schema: {
        params: StoryParams,
        body: z.object({ repository_id: z.string().min(1).max(200).optional() }).default({}),
        operationId: "refreshLocalReviewSource",
      },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
      const body = request.body as { repository_id?: string };
      return translate(() =>
        domain.localReview.refreshSource({
          orgId: actor.orgId,
          projectId,
          storyId,
          repositoryId: body.repository_id,
        }),
      );
    },
  );

  app.post(
    `${reviewBase}/exports`,
    {
      config: { permission: "workspaces:execute", auditAction: "story.local_export.created" },
      schema: { params: StoryParams, operationId: "createLocalReviewExport" },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId, storyId } = request.params as z.infer<typeof StoryParams>;
      return translate(() =>
        domain.localReview.createExport(
          { orgId: actor.orgId, projectId, storyId },
          reviewActor(actor),
        ),
      );
    },
  );

  for (const kind of ["bundle", "patch"] as const) {
    app.get(
      `${reviewBase}/exports/:exportId/${kind}`,
      {
        config: { permission: "stories:read" },
        schema: {
          params: ExportParams,
          operationId: kind === "bundle" ? "downloadLocalExportBundle" : "downloadLocalExportPatch",
        },
      },
      async (request, reply) => {
        const actor = principal(request);
        const { projectId, storyId, exportId } = request.params as z.infer<typeof ExportParams>;
        const row = await translate(() =>
          domain.localReview.exportFile({ orgId: actor.orgId, projectId, storyId, exportId }),
        );
        reply.header("cache-control", "private, no-store");
        reply.header("x-content-type-options", "nosniff");
        reply.header(
          "content-disposition",
          `attachment; filename="${row.id}.${kind === "bundle" ? "bundle" : "patch"}"`,
        );
        if (kind === "bundle") {
          reply.header("x-facility-bundle-sha256", row.bundleSha256);
          reply.type("application/octet-stream");
          return reply.send(row.bundle);
        }
        reply.type("text/x-patch; charset=utf-8");
        return reply.send(row.patch);
      },
    );
  }
}

async function activeProject(db: FacilityDb, orgId: string, projectId: string) {
  const project = (
    await db
      .select({ status: projects.status })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
      .limit(1)
  )[0];
  if (!project) throw notFound("Project not found");
  if (project.status !== "active") {
    throw new ApiError(409, "project_archived", "Project is archived");
  }
}

function reviewActor(actor: ReturnType<typeof principal>): Actor {
  return { type: actor.type === "key" ? "service" : "user", id: actor.id };
}

async function translate<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof LocalRepositoryError || error instanceof LocalReviewError) {
      throw new ApiError(error.statusCode, error.code, error.message, undefined, true);
    }
    const value = error as { code?: unknown; message?: unknown; statusCode?: unknown };
    if (typeof value.code === "string" && error instanceof Error && error.name.endsWith("Error")) {
      if (["ProjectEnvironmentError", "AgentCatalogError"].includes(error.name)) {
        throw new ApiError(
          typeof value.statusCode === "number" ? value.statusCode : 409,
          value.code,
          typeof value.message === "string" ? value.message : value.code,
        );
      }
    }
    throw error;
  }
}
