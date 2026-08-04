import { type FacilityDb, repos } from "@facility/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound } from "../errors.js";
import { createGithubClientFactory } from "../github/client.js";
import {
  adoptFingerprints,
  kickstartPreview,
  kickstartRepo,
  upgradeRepo,
  verifyFingerprints,
} from "../github/kickstart.js";
import type { AppConfig, Principal } from "../types.js";

const IdParams = z.object({ projectId: z.string(), repoId: z.string().optional() });
const Answers = z.object({
  defaultBranch: z.string().optional(),
  packageInstallCmd: z.string().optional(),
  provisionCmd: z.string().optional(),
  checkCmds: z.array(z.string()).optional(),
  modules: z.array(z.string()).optional(),
  modelTier: z.string().optional(),
  board: z
    .object({ org: z.string(), project: z.union([z.string(), z.number()]) })
    .nullable()
    .optional(),
  execution_lane: z.record(z.string(), z.enum(["repo", "platform"])).optional(),
  preview: z
    .object({
      enabled: z.boolean(),
      image: z.string().min(1).max(300),
      command: z.array(z.string().min(1).max(500)).max(30).optional(),
      port: z.number().int().min(1).max(65_535),
      readinessPath: z.string().min(1).max(200).startsWith("/").optional(),
      ttlHours: z.number().int().min(1).max(168).optional(),
    })
    .optional(),
});

const DetectionSchema = z.object({
  isGitRepo: z.boolean(),
  defaultBranch: z.string(),
  packageManager: z.enum(["pnpm", "yarn", "npm", "none"]),
  checks: z.array(z.string()),
  provision: z.string(),
  org: z.string(),
  workflowNames: z.array(z.string()),
  deploymentProviders: z.array(z.string()),
  board: z.object({ org: z.string(), project: z.number().int() }).nullable(),
  previewConfigured: z.boolean(),
  suggestedModules: z.array(z.string()),
  existing: z.object({
    agentsMd: z.boolean(),
    claudeMd: z.boolean(),
    claudeSettings: z.boolean(),
    standard: z.boolean(),
  }),
});
const RenderedFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  executable: z.boolean().optional(),
  mode: z.enum(["100644", "100755", "120000"]).optional(),
});
const ManifestSchema = z.object({
  version: z.literal(1),
  files: z.array(z.object({ path: z.string(), sha256: z.string() })),
  manifestHash: z.string(),
});
const PullRequestSchema = z.object({ number: z.number().int(), url: z.string().url() });
const PreviewSchema = z.object({
  detection: DetectionSchema,
  files: z.array(
    z.object({
      path: z.string(),
      size: z.number().int().nonnegative(),
      sha256: z.string(),
      mode: z.enum(["100644", "100755", "120000"]).optional(),
      action: z.enum(["create", "update"]),
    }),
  ),
  skipped: z.array(z.string()),
});
const KickstartSchema = z.object({
  branch: z.string(),
  commitSha: z.string(),
  pr: PullRequestSchema,
  files: z.array(RenderedFileSchema),
  manifest: ManifestSchema.extend({ templateSet: z.string() }),
});
const FingerprintVerificationSchema = z.union([
  z.object({ status: z.literal("unknown") }),
  z.object({
    status: z.enum(["ok", "drifted"]),
    diff: z.object({
      missing: z.array(z.string()),
      modified: z.array(z.string()),
      extra: z.array(z.string()),
    }),
  }),
]);
const UpgradeSchema = z.object({
  branch: z.string(),
  commitSha: z.string(),
  pr: PullRequestSchema,
});

function principal(request: { principal?: Principal }) {
  if (!request.principal) throw new ApiError(401, "unauthorized", "Authentication required");
  return request.principal;
}

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
        response: { 200: PreviewSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      const { repoId } = request.query as { repoId: string };
      const repo = await loadRepo(db, p.orgId, projectId, repoId);
      return kickstartPreview(db, factory(), repo, { defaultBranch: repo.defaultBranch });
    },
  );

  app.post(
    "/v1/projects/:projectId/kickstart",
    {
      config: { permission: "projects:kickstart", auditAction: "project.kickstarted" },
      schema: {
        params: IdParams,
        body: z.object({
          repoId: z.string(),
          answers: Answers,
          mode: z.literal("pr").default("pr"),
        }),
        response: { 200: KickstartSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      const body = request.body as { repoId: string; answers: z.infer<typeof Answers>; mode: "pr" };
      const repo = await loadRepo(db, p.orgId, projectId, body.repoId);
      return kickstartRepo({
        db,
        factory: factory(),
        config,
        principal: p,
        projectId,
        repo,
        answers: {
          ...body.answers,
          defaultBranch: body.answers.defaultBranch ?? repo.defaultBranch,
        },
      });
    },
  );

  app.post(
    "/v1/repos/:repoId/fingerprints/adopt",
    {
      config: { permission: "projects:write", auditAction: "fingerprints.adopted" },
      schema: { params: z.object({ repoId: z.string() }), response: { 200: ManifestSchema } },
    },
    async (request) => {
      const p = principal(request);
      const { repoId } = request.params as { repoId: string };
      const repo = await loadRepoById(db, p.orgId, repoId);
      // A project-scoped key may only touch its own project's repos — the repoId
      // is org-addressed, so pin it to the principal's project (404, no oracle).
      if (p.projectId && repo.projectId !== p.projectId) {
        throw new ApiError(404, "not_found", "Repo not found");
      }
      return adoptFingerprints({ db, factory: factory(), repo, principal: p });
    },
  );

  app.post(
    "/v1/repos/:repoId/fingerprints/verify",
    {
      config: { permission: "projects:write", auditAction: "fingerprints.verified" },
      schema: {
        params: z.object({ repoId: z.string() }),
        response: { 200: FingerprintVerificationSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { repoId } = request.params as { repoId: string };
      const repo = await loadRepoById(db, p.orgId, repoId);
      if (p.projectId && repo.projectId !== p.projectId) {
        throw new ApiError(404, "not_found", "Repo not found");
      }
      return verifyFingerprints({ db, factory: factory(), repo });
    },
  );

  app.post(
    "/v1/projects/:projectId/upgrade",
    {
      config: { permission: "projects:kickstart", auditAction: "project.upgraded" },
      schema: {
        params: IdParams,
        body: z.object({ repoId: z.string(), toVersion: z.string().optional() }),
        response: { 200: UpgradeSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      const body = request.body as { repoId: string; toVersion?: string };
      const repo = await loadRepo(db, p.orgId, projectId, body.repoId);
      return upgradeRepo({ db, factory: factory(), repo, toVersion: body.toVersion });
    },
  );
}

async function loadRepo(db: FacilityDb, orgId: string, projectId: string, repoId: string) {
  const repo = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.projectId, projectId), eq(repos.id, repoId)))
      .limit(1)
  )[0];
  if (!repo) throw notFound("Repository not found");
  return repo;
}

async function loadRepoById(db: FacilityDb, orgId: string, repoId: string) {
  const repo = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.id, repoId)))
      .limit(1)
  )[0];
  if (!repo) throw notFound("Repository not found");
  return repo;
}
