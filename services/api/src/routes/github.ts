import { type FacilityDb, projectRepositories } from "@facility/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound } from "../errors.js";
import { createGithubClientFactory } from "../github/client.js";
import { kickstartPreview, kickstartRepo } from "../github/kickstart.js";
import type { AppConfig, Principal } from "../types.js";

const IdParams = z.object({ projectId: z.string() });
const Answers = z.object({
  defaultBranch: z.string().min(1).max(200).optional(),
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

const DetectionSchema = z.object({
  defaultBranch: z.string(),
  packageManager: z.enum(["pnpm", "yarn", "npm", "none"]),
  checks: z.array(z.string()),
  setup: z.string().optional(),
  start: z.string(),
  ready: z.string().optional(),
  servicePort: z.number().int().min(1).max(65_535),
});
const RenderedFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  mode: z.literal("100644"),
});
const ManifestSchema = z.object({
  version: z.literal(1),
  files: z.array(z.object({ path: z.string(), sha256: z.string() })),
  manifestHash: z.string(),
  templateSet: z.literal("0.12"),
});
const PullRequestSchema = z.object({ number: z.number().int(), url: z.string().url() });

export async function registerGithubRoutes(app: FastifyInstance, config: AppConfig) {
  const db = app.facilityDb;
  const factory = () => createGithubClientFactory(config);

  app.get(
    "/v1/projects/:projectId/kickstart/preview",
    {
      config: { permission: "projects:kickstart" },
      schema: {
        params: IdParams,
        querystring: z.object({ repoId: z.string() }),
        response: {
          200: z.object({
            detection: DetectionSchema,
            files: z.array(
              z.object({
                path: z.string(),
                size: z.number().int().nonnegative(),
                sha256: z.string(),
                mode: z.literal("100644"),
                action: z.enum(["create", "update"]),
              }),
            ),
            skipped: z.array(z.string()),
          }),
        },
      },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId } = request.params as { projectId: string };
      const { repoId } = request.query as { repoId: string };
      const repository = await loadRepository(db, actor.orgId, projectId, repoId);
      return kickstartPreview(db, factory(), repository, {
        defaultBranch: repository.defaultBranch,
      });
    },
  );

  app.post(
    "/v1/projects/:projectId/kickstart",
    {
      config: {
        permission: "projects:kickstart",
        auditAction: "project.kickstarted",
        idempotent: true,
      },
      schema: {
        params: IdParams,
        body: z.object({
          repoId: z.string(),
          answers: Answers,
          mode: z.literal("pr").default("pr"),
        }),
        response: {
          200: z.object({
            branch: z.string(),
            commitSha: z.string(),
            pr: PullRequestSchema,
            files: z.array(RenderedFileSchema),
            manifest: ManifestSchema,
          }),
        },
      },
    },
    async (request) => {
      const actor = principal(request);
      const { projectId } = request.params as { projectId: string };
      const body = request.body as { repoId: string; answers: z.infer<typeof Answers>; mode: "pr" };
      const repository = await loadRepository(db, actor.orgId, projectId, body.repoId);
      return kickstartRepo({
        db,
        factory: factory(),
        config,
        principal: actor,
        projectId,
        repo: repository,
        answers: {
          ...body.answers,
          defaultBranch: body.answers.defaultBranch ?? repository.defaultBranch,
        },
      });
    },
  );
}

function principal(request: { principal?: Principal }) {
  if (!request.principal) throw new ApiError(401, "unauthorized", "Authentication required");
  return request.principal;
}

async function loadRepository(db: FacilityDb, orgId: string, projectId: string, repoId: string) {
  const repository = (
    await db
      .select()
      .from(projectRepositories)
      .where(
        and(
          eq(projectRepositories.orgId, orgId),
          eq(projectRepositories.projectId, projectId),
          eq(projectRepositories.id, repoId),
        ),
      )
      .limit(1)
  )[0];
  if (!repository) throw notFound("Repository not found");
  return repository;
}
