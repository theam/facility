import { newId } from "@facility/core";
import {
  actionTypes,
  ghCiEvents,
  ghIssues,
  ghPullRequests,
  githubInstallations,
  insertAuditEvent,
  proposals,
  repos,
  runEvents,
  runs,
  users,
} from "@facility/db";
import { and, desc, eq, gte, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound } from "../../errors.js";
import { createGithubClientFactory, type GithubClientFactory } from "../../github/client.js";
import { createGithubClientForRepo, syncRepoFacilityConfig } from "../../github/kickstart.js";
import {
  assertGithubRequestContextSize,
  findAgentDef,
  githubRequestContext,
  loadGithubIssueComments,
} from "../../github/router.js";
import {
  assemblePipelineStories,
  classifyPipeline,
  PIPELINE_STAGES,
  type PipelineAssembly,
  type PipelinePullRequest,
} from "../../pipeline.js";
import {
  assertProjectScope,
  DateValue,
  IdParams,
  JsonValue,
  principal,
  RunSchema,
  type V1RouteContext,
} from "./shared.js";

const InstallationSchema = z.object({
  id: z.string(),
  installationId: z.number(),
  accountLogin: z.string(),
  targetType: z.string(),
  suspendedAt: DateValue.nullable(),
});

const InstallationRepoSchema = z.object({
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  htmlUrl: z.string(),
});

const GithubNumberParam = z.coerce.number().int().positive().max(2_147_483_647);

const LinkedRunSchema = z.object({
  id: z.string(),
  mode: z.string(),
  status: z.string(),
  engine: z.string(),
  pr: JsonValue.optional(),
});

const GhIssueItemSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  labels: JsonValue,
  assignees: JsonValue,
  author: z.string().nullable(),
  htmlUrl: z.string(),
  commentsCount: z.number(),
  ghUpdatedAt: DateValue.nullable(),
  closedAt: DateValue.nullable(),
  linkedRuns: z.array(LinkedRunSchema),
});

const GhIssueDetailSchema = GhIssueItemSchema.extend({
  bodyMd: z.string().nullable(),
  ghCreatedAt: DateValue.nullable(),
  runs: z.array(
    z.object({
      id: z.string(),
      mode: z.string(),
      engine: z.string(),
      status: z.string(),
      startedAt: DateValue.nullable(),
      endedAt: DateValue.nullable(),
      receipt: JsonValue.nullable(),
      pr: JsonValue.optional(),
      triggeredBy: z.string().nullable(),
    }),
  ),
});

const StoryGithubActivitySchema = z.object({
  comments: z.array(
    z.object({
      id: z.number(),
      author: z.string(),
      bodyMd: z.string(),
      createdAt: z.string(),
      url: z.string(),
    }),
  ),
  prs: z.array(
    z.object({
      number: z.number(),
      title: z.string(),
      bodyMd: z.string(),
      author: z.string(),
      url: z.string(),
      state: z.enum(["open", "closed", "merged"]),
      draft: z.boolean(),
      createdAt: z.string().nullable(),
      closedAt: z.string().nullable(),
      mergedAt: z.string().nullable(),
      ciState: z.enum(["pending", "success", "failure"]).nullable(),
      ciFailureNames: z.array(z.string()),
    }),
  ),
  ciEvents: z.array(
    z.object({
      id: z.string(),
      pullNumber: z.number().int(),
      headSha: z.string(),
      state: z.enum(["pending", "success", "failure"]),
      failureNames: z.array(z.string()),
      observedAt: z.string(),
    }),
  ),
});

type StoryGithubPull = z.infer<typeof StoryGithubActivitySchema>["prs"][number];

function activityPullFromPipeline(pull: PipelinePullRequest): StoryGithubPull {
  const currentCiState =
    pull.headSha && pull.ciHeadSha && pull.headSha === pull.ciHeadSha ? pull.ciState : null;
  return {
    number: pull.number,
    title: pull.title,
    bodyMd: "",
    author: "unknown",
    url: pull.url,
    state: pull.state,
    draft: pull.draft,
    createdAt: pull.createdAt?.toISOString() ?? null,
    closedAt: pull.closedAt?.toISOString() ?? null,
    mergedAt: pull.mergedAt?.toISOString() ?? null,
    ciState: currentCiState,
    ciFailureNames: currentCiState === "failure" ? pull.ciFailureNames : [],
  };
}

function activityPullState(state: string): StoryGithubPull["state"] {
  return state === "merged" ? "merged" : state === "closed" ? "closed" : "open";
}

const PipelineStageSchema = z.enum([
  "backlog",
  "planning",
  "building",
  "validating",
  "review",
  "shipped",
]);
const PipelineStageStateSchema = z.enum([
  "ready_to_plan",
  "needs_attention",
  "in_progress",
  "needs_review",
  "ready_to_build",
  "failed",
  "draft_pr",
  "checks_running",
  "checks_failed",
  "awaiting_review",
  "shipped_recently",
]);
const PipelineStageKindSchema = z.enum(["human", "agent", "machine", "done"]);
const PipelinePullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  headSha: z.string().nullable(),
  ciState: z.enum(["pending", "success", "failure"]).nullable(),
  ciHeadSha: z.string().nullable(),
  ciFailureNames: z.array(z.string()),
  createdAt: DateValue.nullable(),
  closedAt: DateValue.nullable(),
  mergedAt: DateValue.nullable(),
  closingIssues: z.array(z.number().int()),
});
const PipelineStorySchema = z.object({
  key: z.string(),
  id: z.string(),
  storyType: z.enum(["issue", "pull_request"]),
  repoId: z.string(),
  repoOwner: z.string(),
  repoName: z.string(),
  number: z.number().int(),
  title: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  author: z.string().nullable(),
  htmlUrl: z.string(),
  commentsCount: z.number().int(),
  ghCreatedAt: DateValue.nullable(),
  ghUpdatedAt: DateValue.nullable(),
  closedAt: DateValue.nullable(),
  stageState: PipelineStageStateSchema,
  runState: z.enum(["live", "failed"]).nullable(),
  currentRun: z
    .object({ id: z.string(), mode: z.string(), status: z.string(), engine: z.string() })
    .nullable(),
  attemptCount: z.number().int(),
  prs: z.array(PipelinePullRequestSchema),
  ciState: z.enum(["pending", "success", "failure"]).nullable(),
  ciUrl: z.string().nullable(),
  ciFailureNames: z.array(z.string()),
});
const PipelineResponseSchema = z.object({
  stages: z.array(
    z.object({
      key: PipelineStageSchema,
      label: z.string(),
      sub: z.string(),
      kind: PipelineStageKindSchema,
      count: z.number().int(),
      stories: z.array(PipelineStorySchema),
    }),
  ),
});
const StoryDetailSchema = z.object({
  key: z.string(),
  id: z.string(),
  storyType: z.enum(["issue", "pull_request"]),
  repoId: z.string(),
  repoOwner: z.string(),
  repoName: z.string(),
  number: z.number().int(),
  title: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  author: z.string().nullable(),
  htmlUrl: z.string(),
  bodyMd: z.string().nullable(),
  commentsCount: z.number().int(),
  ghCreatedAt: DateValue.nullable(),
  ghUpdatedAt: DateValue.nullable(),
  closedAt: DateValue.nullable(),
  prs: z.array(PipelinePullRequestSchema),
  ciState: z.enum(["pending", "success", "failure"]).nullable(),
  ciUrl: z.string().nullable(),
  ciFailureNames: z.array(z.string()),
  stage: z.object({ key: PipelineStageSchema, label: z.string() }).nullable(),
  pipelineStages: z.array(z.object({ key: PipelineStageSchema, label: z.string() })),
  allowLegacyProposalNumber: z.boolean(),
  runs: z.array(
    z.object({
      id: z.string(),
      mode: z.string(),
      engine: z.string(),
      status: z.string(),
      startedAt: DateValue.nullable(),
      endedAt: DateValue.nullable(),
      receipt: JsonValue.nullable(),
      pr: JsonValue.optional(),
      triggeredBy: z.string().nullable(),
    }),
  ),
});

export async function registerGithubV1Routes(app: FastifyInstance, context: V1RouteContext) {
  const { db, config } = context;

  app.get(
    "/v1/github/installations",
    {
      config: { permission: "projects:kickstart" },
      schema: { response: { 200: z.array(InstallationSchema) } },
    },
    async (request) => {
      const p = principal(request);
      // Kickstart creates NEW org-level projects, so installation discovery is an
      // org operation. A project-pinned key must not enumerate the org's whole
      // GitHub App repo inventory through it (that's a cross-project info leak).
      requireOrgPrincipal(p);
      return db
        .select({
          id: githubInstallations.id,
          installationId: githubInstallations.installationId,
          accountLogin: githubInstallations.accountLogin,
          targetType: githubInstallations.targetType,
          suspendedAt: githubInstallations.suspendedAt,
        })
        .from(githubInstallations)
        .where(eq(githubInstallations.orgId, p.orgId));
    },
  );

  app.get(
    "/v1/github/installations/:installationId/repos",
    {
      config: { permission: "projects:kickstart" },
      schema: {
        params: z.object({ installationId: z.coerce.number().int() }),
        querystring: z.object({ query: z.string().optional() }),
        response: {
          200: z.object({
            items: z.array(InstallationRepoSchema),
            truncated: z.boolean(),
          }),
        },
      },
    },
    async (request) => {
      const p = principal(request);
      requireOrgPrincipal(p);
      const { installationId } = request.params as { installationId: number };
      const { query } = request.query as { query?: string };
      const installation = (
        await db
          .select()
          .from(githubInstallations)
          .where(
            and(
              eq(githubInstallations.orgId, p.orgId),
              eq(githubInstallations.installationId, installationId),
            ),
          )
          .limit(1)
      )[0];
      if (!installation) throw notFound("GitHub installation not found");
      if (installation.suspendedAt) {
        throw new ApiError(409, "installation_suspended", "GitHub installation is suspended");
      }
      const factory = app.githubClientFactory ?? createGithubClientFactory(config);
      const octokit = await factory(installation.installationId);
      if (!octokit.request) {
        throw new ApiError(500, "github_request_unavailable", "GitHub request API unavailable");
      }
      const reposFound: InstallationRepo[] = [];
      for (let page = 1; page <= 3; page++) {
        const response = await octokit.request("GET /installation/repositories", {
          per_page: 100,
          page,
        });
        const pageRepos = Array.isArray(response.data.repositories)
          ? (response.data.repositories as InstallationRepo[])
          : [];
        reposFound.push(...pageRepos);
        if (pageRepos.length < 100) break;
      }
      const needle = query?.trim().toLowerCase();
      const items = reposFound
        .filter((repo) => !needle || repo.full_name?.toLowerCase().includes(needle))
        .map((repo) => {
          const [owner, name] = String(repo.full_name ?? "/").split("/", 2);
          return {
            owner: repo.owner?.login ?? owner ?? "",
            name: repo.name ?? name ?? "",
            fullName: repo.full_name ?? `${repo.owner?.login ?? owner}/${repo.name ?? name}`,
            private: Boolean(repo.private),
            defaultBranch: repo.default_branch ?? "main",
            htmlUrl: repo.html_url ?? "",
          };
        })
        .filter((repo) => repo.owner && repo.name);
      return { items, truncated: reposFound.length >= 300 };
    },
  );

  app.get(
    "/v1/projects/:projectId/issues",
    {
      config: { permission: "runs:read" },
      schema: {
        params: IdParams,
        querystring: z.object({
          state: z.enum(["open", "closed", "all"]).default("open"),
          q: z.string().optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: {
          200: z.object({ items: z.array(GhIssueItemSchema), nextCursor: z.string().nullable() }),
        },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      // Project-scoped keys are pinned to their project (404 elsewhere) — same
      // clamp every sibling project route applies.
      assertProjectScope(p, projectId);
      const query = request.query as {
        state: "open" | "closed" | "all";
        q?: string;
        cursor?: string;
        limit: number;
      };
      const clauses = [eq(ghIssues.orgId, p.orgId), eq(ghIssues.projectId, projectId)];
      if (query.state !== "all") clauses.push(eq(ghIssues.state, query.state));
      if (query.q?.trim()) {
        clauses.push(sql`${ghIssues.title} ilike ${`%${query.q.trim()}%`}`);
      }
      const cursor = decodeIssueCursor(query.cursor);
      if (cursor) {
        const cursorClause = or(
          lt(ghIssues.ghUpdatedAt, cursor.updatedAt),
          and(eq(ghIssues.ghUpdatedAt, cursor.updatedAt), lt(ghIssues.number, cursor.number)),
          and(
            eq(ghIssues.ghUpdatedAt, cursor.updatedAt),
            eq(ghIssues.number, cursor.number),
            lt(ghIssues.repoId, cursor.repoId),
          ),
        );
        if (cursorClause) clauses.push(cursorClause);
      }
      const rows = await db
        .select()
        .from(ghIssues)
        .where(and(...clauses))
        .orderBy(desc(ghIssues.ghUpdatedAt), desc(ghIssues.number), desc(ghIssues.repoId))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const linkedRuns = await linkedRunsForIssues(db, p.orgId, projectId, page);
      return {
        items: page.map((issue) =>
          issueItem(issue, linkedRuns.get(repoNumberKey(issue.repoId, issue.number)) ?? []),
        ),
        nextCursor:
          rows.length > query.limit && page.at(-1)
            ? encodeIssueCursor(
                page.at(-1)?.ghUpdatedAt ?? null,
                page.at(-1)?.number ?? 0,
                page.at(-1)?.repoId ?? "",
              )
            : null,
      };
    },
  );

  // The pipeline as data: mirrored issues classified into stages with their
  // current run, PRs, and gates. Server-side source of truth — the Product
  // Owner reads this as a tool; the web can consume it too.
  app.get(
    "/v1/projects/:projectId/pipeline",
    {
      config: { permission: "runs:read" },
      schema: {
        params: IdParams,
        response: { 200: PipelineResponseSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const [assembly, openProposals] = await Promise.all([
        assembleProjectStories(db, p.orgId, projectId),
        loadOpenPlanProposals(db, p.orgId, projectId),
      ]);
      const proposalStoryKeys = proposalKeysForAssembly(assembly, openProposals);
      const staged = classifyPipeline(assembly.stories, proposalStoryKeys);
      return {
        stages: PIPELINE_STAGES.map((stage) => {
          const stories = staged.get(stage.key) ?? [];
          return { ...stage, count: stories.length, stories };
        }),
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/issues/:number",
    {
      config: { permission: "runs:read" },
      schema: {
        params: z.object({ projectId: z.string(), number: GithubNumberParam }),
        querystring: z.object({ repoId: z.string().optional() }),
        response: { 200: GhIssueDetailSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId, number } = request.params as { projectId: string; number: number };
      const { repoId } = request.query as { repoId?: string };
      assertProjectScope(p, projectId);
      const issue = await loadIssue(db, p.orgId, projectId, number, repoId);
      const issueRuns = await fullRunsForIssue(db, p.orgId, projectId, issue);
      // "Who triggered this" — user runs resolve to the member's email; GitHub
      // senders/bots keep their login; system paths get their path name.
      const creatorIds = [
        ...new Set(
          issueRuns
            .map((run) => {
              const createdBy = objectOrEmpty(run.createdBy);
              return createdBy.type === "user" && typeof createdBy.id === "string"
                ? createdBy.id
                : null;
            })
            .filter((id): id is string => id !== null),
        ),
      ];
      const emailById = new Map(
        (creatorIds.length
          ? await db
              .select({ id: users.id, email: users.email })
              .from(users)
              .where(inArray(users.id, creatorIds))
          : []
        ).map((row) => [row.id, row.email]),
      );
      const triggeredByOf = (run: (typeof issueRuns)[number]): string | null => {
        const trigger = objectOrEmpty(run.trigger);
        const createdBy = objectOrEmpty(run.createdBy);
        if (trigger.source === "plan_acceptance") return "plan approval";
        if (trigger.type === "schedule") return "schedule";
        if (createdBy.type === "user" && typeof createdBy.id === "string") {
          return emailById.get(createdBy.id) ?? "a member";
        }
        if (typeof createdBy.id === "string" && createdBy.id) return createdBy.id;
        if (typeof createdBy.login === "string" && createdBy.login) return createdBy.login;
        if (typeof createdBy.name === "string" && createdBy.name) return createdBy.name;
        return null;
      };
      return {
        ...issueItem(issue, issueRuns.map(linkedRunFromRun)),
        bodyMd: issue.bodyMd,
        ghCreatedAt: issue.ghCreatedAt,
        runs: issueRuns.map((run) => {
          const gh = objectOrEmpty(run.gh);
          return {
            id: run.id,
            mode: run.mode,
            engine: run.engine,
            status: run.status,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            receipt: run.receipt,
            pr: gh.pr,
            triggeredBy: triggeredByOf(run),
          };
        }),
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/stories/:number",
    {
      config: { permission: "runs:read" },
      schema: {
        params: z.object({ projectId: z.string(), number: GithubNumberParam }),
        querystring: z.object({
          repoId: z.string().optional(),
          storyType: z.enum(["issue", "pull_request"]).optional(),
        }),
        response: { 200: StoryDetailSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId, number } = request.params as { projectId: string; number: number };
      const { repoId, storyType } = request.query as {
        repoId?: string;
        storyType?: "issue" | "pull_request";
      };
      assertProjectScope(p, projectId);
      const assembly = await assembleSelectedStories(db, p.orgId, projectId, {
        number,
        repoId,
        storyType,
      });
      const matches = assembly.stories.filter(
        (story) =>
          story.number === number &&
          (!repoId || story.repoId === repoId) &&
          (!storyType || story.storyType === storyType),
      );
      if (matches.length === 0) throw notFound("Story not found");
      if (matches.length > 1) {
        throw new ApiError(
          409,
          "ambiguous_story_number",
          "Story number exists in more than one project repository; provide repoId and storyType",
        );
      }
      const selected = matches[0] as (typeof matches)[number];
      const bodyRow =
        selected.storyType === "issue"
          ? (
              await db
                .select({ bodyMd: ghIssues.bodyMd })
                .from(ghIssues)
                .where(and(eq(ghIssues.orgId, p.orgId), eq(ghIssues.id, selected.id)))
                .limit(1)
            )[0]
          : (
              await db
                .select({ bodyMd: ghPullRequests.bodyMd })
                .from(ghPullRequests)
                .where(and(eq(ghPullRequests.orgId, p.orgId), eq(ghPullRequests.id, selected.id)))
                .limit(1)
            )[0];
      const runIds = selected.linkedRuns.map((run) => run.id);
      const storyRuns = runIds.length
        ? await db
            .select()
            .from(runs)
            .where(and(eq(runs.orgId, p.orgId), inArray(runs.id, runIds)))
            .orderBy(desc(runs.queuedAt))
        : [];
      const [openProposals, sameNumberIssues] = await Promise.all([
        loadOpenPlanProposals(db, p.orgId, projectId),
        db
          .select({ id: ghIssues.id })
          .from(ghIssues)
          .where(
            and(
              eq(ghIssues.orgId, p.orgId),
              eq(ghIssues.projectId, projectId),
              eq(ghIssues.number, selected.number),
            ),
          )
          .limit(2),
      ]);
      const staged = classifyPipeline(
        assembly.stories,
        proposalKeysForAssembly(
          assembly,
          openProposals,
          sameNumberIssues.length > 1 ? new Set([selected.number]) : undefined,
        ),
      );
      const stageDefinition = PIPELINE_STAGES.find((stage) =>
        (staged.get(stage.key) ?? []).some((story) => story.key === selected.key),
      );
      const placedStory = stageDefinition
        ? (staged.get(stageDefinition.key) ?? []).find((story) => story.key === selected.key)
        : null;
      const { linkedRuns: _linkedRuns, ...story } = selected;
      return {
        ...story,
        bodyMd: bodyRow?.bodyMd ?? null,
        ciState: placedStory?.ciState ?? null,
        ciUrl: placedStory?.ciUrl ?? null,
        ciFailureNames: placedStory?.ciFailureNames ?? [],
        stage: stageDefinition ? { key: stageDefinition.key, label: stageDefinition.label } : null,
        pipelineStages: PIPELINE_STAGES.map(({ key, label }) => ({ key, label })),
        allowLegacyProposalNumber: selected.storyType === "issue" && sameNumberIssues.length === 1,
        runs: await presentStoryRuns(db, storyRuns),
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/stories/:number/github-activity",
    {
      config: { permission: "runs:read" },
      schema: {
        params: z.object({ projectId: z.string(), number: GithubNumberParam }),
        querystring: z.object({
          repoId: z.string().optional(),
          storyType: z.enum(["issue", "pull_request"]).optional(),
        }),
        response: { 200: StoryGithubActivitySchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId, number } = request.params as { projectId: string; number: number };
      const { repoId, storyType } = request.query as {
        repoId?: string;
        storyType?: "issue" | "pull_request";
      };
      assertProjectScope(p, projectId);
      const assembly = await assembleSelectedStories(db, p.orgId, projectId, {
        number,
        repoId,
        storyType,
      });
      const matches = assembly.stories.filter(
        (story) =>
          story.number === number &&
          (!repoId || story.repoId === repoId) &&
          (!storyType || story.storyType === storyType),
      );
      if (matches.length === 0) throw notFound("Story not found");
      if (matches.length > 1) {
        throw new ApiError(
          409,
          "ambiguous_story_number",
          "Story number exists in more than one project repository; provide repoId and storyType",
        );
      }
      const story = matches[0] as (typeof matches)[number];
      const pullNumbers = [...new Set(story.prs.map((pull) => pull.number))];
      const mirroredPulls = pullNumbers.length
        ? await db
            .select()
            .from(ghPullRequests)
            .where(
              and(
                eq(ghPullRequests.orgId, p.orgId),
                eq(ghPullRequests.repoId, story.repoId),
                inArray(ghPullRequests.number, pullNumbers),
              ),
            )
        : [];
      const ciEvents = pullNumbers.length
        ? await db
            .select()
            .from(ghCiEvents)
            .where(
              and(
                eq(ghCiEvents.orgId, p.orgId),
                eq(ghCiEvents.projectId, projectId),
                eq(ghCiEvents.repoId, story.repoId),
                inArray(ghCiEvents.pullNumber, pullNumbers),
              ),
            )
            .orderBy(ghCiEvents.observedAt, ghCiEvents.id)
        : [];
      const presentedCiEvents = ciEvents.map((event) => ({
        id: event.id,
        pullNumber: event.pullNumber,
        headSha: event.headSha,
        state: event.state as "pending" | "success" | "failure",
        failureNames: event.failureNames,
        observedAt: event.observedAt.toISOString(),
      }));
      const prsByNumber = new Map<number, StoryGithubPull>(
        story.prs.map((pull) => [pull.number, activityPullFromPipeline(pull)]),
      );
      const mirroredNumbers = new Set<number>();
      for (const pull of mirroredPulls) {
        mirroredNumbers.add(pull.number);
        const fallback = prsByNumber.get(pull.number);
        prsByNumber.set(pull.number, {
          number: pull.number,
          title: pull.title,
          bodyMd: pull.bodyMd ?? "",
          author: pull.author ?? "unknown",
          url: pull.htmlUrl,
          state: activityPullState(pull.state),
          draft: pull.draft,
          createdAt: pull.ghCreatedAt?.toISOString() ?? null,
          closedAt: pull.closedAt?.toISOString() ?? null,
          mergedAt: pull.mergedAt?.toISOString() ?? null,
          ciState: fallback?.ciState ?? null,
          ciFailureNames: fallback?.ciFailureNames ?? [],
        });
      }
      const sortedPrs = () => [...prsByNumber.values()].sort((a, b) => a.number - b.number);
      const repo = (
        await db
          .select()
          .from(repos)
          .where(
            and(
              eq(repos.orgId, p.orgId),
              eq(repos.projectId, projectId),
              eq(repos.id, story.repoId),
            ),
          )
          .limit(1)
      )[0];
      if (!repo?.installationId) {
        return { comments: [], prs: sortedPrs(), ciEvents: presentedCiEvents };
      }
      try {
        const factory = app.githubClientFactory ?? createGithubClientFactory(config);
        const client = await createGithubClientForRepo(db, factory, repo);
        const commentNumbers =
          story.storyType === "issue" ? [story.number, ...pullNumbers] : [story.number];
        const uniqueCommentNumbers = [...new Set(commentNumbers)];
        const missingPullNumbers = pullNumbers.filter(
          (pullNumber) => !mirroredNumbers.has(pullNumber),
        );
        const [commentResults, livePullResults] = await Promise.all([
          Promise.allSettled(
            uniqueCommentNumbers.map((commentNumber) => client.listIssueComments(commentNumber)),
          ),
          Promise.allSettled(
            missingPullNumbers.map((pullNumber) => client.getPullRequest(pullNumber)),
          ),
        ]);
        for (const [index, result] of livePullResults.entries()) {
          const pullNumber = missingPullNumbers[index] as number;
          if (result.status === "fulfilled") {
            const fallback = prsByNumber.get(pullNumber);
            if (!fallback) continue;
            prsByNumber.set(pullNumber, {
              ...fallback,
              number: result.value.number,
              title: result.value.title,
              bodyMd: result.value.body,
              author: result.value.author,
              url: result.value.url,
              state: result.value.state,
              draft: result.value.draft,
              createdAt: result.value.createdAt,
              closedAt: result.value.closedAt,
              mergedAt: result.value.mergedAt,
            });
            continue;
          }
          request.log.warn(
            {
              err: result.reason,
              orgId: p.orgId,
              projectId,
              repoId: story.repoId,
              storyType: story.storyType,
              storyNumber: story.number,
              pullNumber,
            },
            "GitHub story pull-request fetch failed; returning mirrored or provenance data",
          );
        }
        const commentPages = commentResults.flatMap((result, index) => {
          if (result.status === "fulfilled") return [result.value];
          request.log.warn(
            {
              err: result.reason,
              orgId: p.orgId,
              projectId,
              repoId: story.repoId,
              storyType: story.storyType,
              storyNumber: story.number,
              commentNumber: uniqueCommentNumbers[index],
            },
            "GitHub story comment fetch failed; returning a partial timeline",
          );
          return [];
        });
        // Bot comments are Facility's own progress/ack noise (and other bots').
        const comments = [
          ...new Map(commentPages.flat().map((comment) => [comment.id, comment])).values(),
        ]
          .filter((comment) => comment.authorType !== "Bot")
          .map(({ authorType: _authorType, body, ...rest }) => ({ ...rest, bodyMd: body }))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return { comments, prs: sortedPrs(), ciEvents: presentedCiEvents };
      } catch (error) {
        // GitHub being unreachable degrades to the Facility-only timeline.
        request.log.warn(
          {
            err: error,
            orgId: p.orgId,
            projectId,
            repoId: story.repoId,
            storyType: story.storyType,
            storyNumber: story.number,
          },
          "GitHub story activity unavailable; returning the Facility-only timeline",
        );
        return { comments: [], prs: sortedPrs(), ciEvents: presentedCiEvents };
      }
    },
  );

  app.post(
    "/v1/projects/:projectId/issues/sync",
    {
      config: { permission: "repos:write" },
      schema: {
        params: IdParams,
        response: { 202: z.object({ queued: z.number().int() }) },
      },
    },
    async (request, reply) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const projectRepos = await db
        .select()
        .from(repos)
        .where(and(eq(repos.orgId, p.orgId), eq(repos.projectId, projectId)));
      let queued = 0;
      for (const repo of projectRepos) {
        await app.enqueue("github.issues-sync", { repoId: repo.id, orgId: p.orgId });
        queued += 1;
      }
      return reply.status(202).send({ queued });
    },
  );

  app.post(
    "/v1/projects/:projectId/issues/:number/trigger",
    {
      config: { permission: "runs:trigger" },
      schema: {
        params: z.object({ projectId: z.string(), number: GithubNumberParam }),
        querystring: z.object({ repoId: z.string().optional() }),
        body: z.object({ agent: z.string().min(1) }),
        response: { 200: RunSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId, number } = request.params as { projectId: string; number: number };
      const { repoId } = request.query as { repoId?: string };
      assertProjectScope(p, projectId);
      const body = request.body as { agent: string };
      const issue = await loadIssue(db, p.orgId, projectId, number, repoId);
      const repo = (
        await db
          .select()
          .from(repos)
          .where(
            and(
              eq(repos.orgId, p.orgId),
              eq(repos.projectId, projectId),
              eq(repos.id, issue.repoId),
            ),
          )
          .limit(1)
      )[0];
      if (!repo) throw notFound("Repository not found");
      // Resolve the local contract before spending a GitHub API request on
      // context that cannot be dispatched.
      const agent = await findAgentDef(db, p.orgId, projectId, body.agent);
      if (!agent) throw new ApiError(400, "agent_not_found", "Agent definition not found");
      const githubFactory =
        app.githubClientFactory ??
        (config.githubAppId && config.githubAppPrivateKey
          ? createGithubClientFactory(config)
          : undefined);
      if (!githubFactory) {
        throw new ApiError(
          503,
          "github_app_unconfigured",
          "GitHub App credentials are required to load the complete issue context",
        );
      }
      const githubClient = await createGithubClientForRepo(db, githubFactory, repo);
      // Control-plane dispatch must consume the same repository-owned runtime
      // configuration as slash-command dispatch. Reconcile at handoff time so a
      // recently merged `.facility.json` cannot leave direct triggers using
      // stale provisioning, checks, models, or execution-lane settings.
      await syncRepoFacilityConfig({ db, client: githubClient, repo });
      const [githubIssue, issueComments] = await Promise.all([
        githubClient.getIssue(number),
        loadGithubIssueComments(githubClient, number),
      ]);
      const issueRequest = githubRequestContext(
        {
          issue: {
            number: githubIssue.number,
            title: githubIssue.title,
            body: githubIssue.body,
            user: { login: githubIssue.user?.login },
            labels: githubIssue.labels ?? [],
            html_url: githubIssue.html_url,
          },
        },
        issueComments,
      );
      assertGithubRequestContextSize(issueRequest);
      // No GitHub userCanWrite check: platform RBAC `runs:trigger` is the authority
      // for control-plane-originated dispatch.
      // No execution_lane gate: an explicit control-plane trigger is platform-lane intent.
      const run = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId: p.orgId,
            projectId,
            agentDefId: agent.id,
            mode: body.agent,
            engine: agent.engine,
            trigger: {
              type: "web_issue",
              ...(p.githubLogin ? { githubLogin: p.githubLogin } : {}),
              repo: { id: repo.id, owner: repo.owner, name: repo.name },
              issue: { number },
              request: issueRequest,
            },
            gh: { owner: repo.owner, repo: repo.name, issueNumber: number },
            createdBy: { type: p.type, id: p.id },
          })
          .returning()
      )[0];
      if (!run) throw new ApiError(500, "insert_failed", "Could not create run");
      await db.insert(runEvents).values({
        orgId: p.orgId,
        runId: run.id,
        seq: 1,
        type: "queued",
        data: { queue: "runs.dispatch" },
      });
      await app.enqueue("runs.dispatch", { runId: run.id, orgId: p.orgId });
      if (p.type === "user") {
        await assignIssueBestEffort(
          db,
          githubFactory,
          repo,
          number,
          p.githubLogin ?? null,
          run.id,
          { type: p.type, id: p.id },
        );
      }
      await ackIssueQueued(db, githubFactory, repo, number, body.agent, run.id);
      await insertAuditEvent(db, {
        orgId: p.orgId,
        projectId,
        actor: { type: p.type, id: p.id },
        action: "run.triggered",
        target: { type: "run", id: run.id },
        payload: { issueNumber: number, agent: body.agent },
      });
      return run;
    },
  );
}

/** Org-level operations refuse project-pinned principals (404, not an oracle). */
function requireOrgPrincipal(p: { projectId?: string | null }) {
  if (p.projectId) throw notFound("Not found");
}

type InstallationRepo = {
  name?: string;
  full_name?: string;
  private?: boolean;
  default_branch?: string;
  html_url?: string;
  owner?: { login?: string };
};

async function assembleProjectStories(
  db: FastifyInstance["facilityDb"],
  orgId: string,
  projectId: string,
) {
  const shippedSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [issueRows, repoRows] = await Promise.all([
    db
      .select()
      .from(ghIssues)
      .where(
        and(
          eq(ghIssues.orgId, orgId),
          eq(ghIssues.projectId, projectId),
          visiblePipelineIssue(shippedSince),
        ),
      ),
    db
      .select({ id: repos.id, owner: repos.owner, name: repos.name })
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.projectId, projectId))),
  ]);
  const linkedPullConditions: SQL[] = [];
  for (const repo of repoRows) {
    const issueNumbers = issueRows
      .filter((issue) => issue.repoId === repo.id)
      .map((issue) => issue.number);
    if (issueNumbers.length === 0) continue;
    linkedPullConditions.push(
      and(
        eq(ghPullRequests.repoId, repo.id),
        sql`${ghPullRequests.closingIssues} && ${integerArray(issueNumbers)}`,
      ) as SQL,
    );
  }
  const pullRows = await db
    .select()
    .from(ghPullRequests)
    .where(
      and(
        eq(ghPullRequests.orgId, orgId),
        eq(ghPullRequests.projectId, projectId),
        or(
          eq(ghPullRequests.state, "open"),
          and(
            eq(ghPullRequests.state, "merged"),
            or(
              gte(ghPullRequests.mergedAt, shippedSince),
              and(isNull(ghPullRequests.mergedAt), gte(ghPullRequests.closedAt, shippedSince)),
              and(
                isNull(ghPullRequests.mergedAt),
                isNull(ghPullRequests.closedAt),
                gte(ghPullRequests.ghUpdatedAt, shippedSince),
              ),
            ),
          ),
          ...linkedPullConditions,
        ),
      ),
    );
  const runRows = await runsForAssembly(db, orgId, projectId, issueRows, pullRows, repoRows);
  return assemblePipelineStories({
    issues: issueRows,
    pullRequests: pullRows,
    repos: repoRows,
    runs: runRows,
  });
}

async function assembleSelectedStories(
  db: FastifyInstance["facilityDb"],
  orgId: string,
  projectId: string,
  identity: {
    number: number;
    repoId?: string;
    storyType?: "issue" | "pull_request";
  },
) {
  const shippedSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const scope = [eq(ghIssues.orgId, orgId), eq(ghIssues.projectId, projectId)];
  const primaryIssues =
    identity.storyType === "pull_request"
      ? []
      : await db
          .select()
          .from(ghIssues)
          .where(
            and(
              ...scope,
              eq(ghIssues.number, identity.number),
              ...(identity.repoId ? [eq(ghIssues.repoId, identity.repoId)] : []),
            ),
          );
  const primaryPulls =
    identity.storyType === "issue"
      ? []
      : await db
          .select()
          .from(ghPullRequests)
          .where(
            and(
              eq(ghPullRequests.orgId, orgId),
              eq(ghPullRequests.projectId, projectId),
              eq(ghPullRequests.number, identity.number),
              ...(identity.repoId ? [eq(ghPullRequests.repoId, identity.repoId)] : []),
            ),
          );

  const linkedPullConditions = primaryIssues.map(
    (issue) =>
      and(
        eq(ghPullRequests.repoId, issue.repoId),
        sql`${ghPullRequests.closingIssues} @> ARRAY[${issue.number}]::integer[]`,
      ) as SQL,
  );
  const linkedPulls = linkedPullConditions.length
    ? await db
        .select()
        .from(ghPullRequests)
        .where(
          and(
            eq(ghPullRequests.orgId, orgId),
            eq(ghPullRequests.projectId, projectId),
            or(...linkedPullConditions),
          ),
        )
    : [];
  let pullRows = uniqueRows([...primaryPulls, ...linkedPulls]);

  const referencedIssueConditions: SQL[] = [];
  for (const pull of primaryPulls) {
    if (pull.closingIssues.length === 0) continue;
    referencedIssueConditions.push(
      and(eq(ghIssues.repoId, pull.repoId), inArray(ghIssues.number, pull.closingIssues)) as SQL,
    );
  }
  const referencedIssues = referencedIssueConditions.length
    ? await db
        .select()
        .from(ghIssues)
        .where(
          and(
            eq(ghIssues.orgId, orgId),
            eq(ghIssues.projectId, projectId),
            // Keep detail assembly identical to board assembly. Otherwise an
            // open PR linked only to an old closed issue is rendered as an
            // orphan PR on the board, then becomes an issue story here and
            // the board link 404s.
            visiblePipelineIssue(shippedSince),
            or(...referencedIssueConditions),
          ),
        )
    : [];
  let issueRows = uniqueRows([...primaryIssues, ...referencedIssues]);
  const repoIds = [...new Set([...issueRows, ...pullRows].map((row) => row.repoId))];
  const repoRows = repoIds.length
    ? await db
        .select({ id: repos.id, owner: repos.owner, name: repos.name })
        .from(repos)
        .where(
          and(eq(repos.orgId, orgId), eq(repos.projectId, projectId), inArray(repos.id, repoIds)),
        )
    : [];
  let runRows = await runsForAssembly(db, orgId, projectId, issueRows, pullRows, repoRows);

  const repoIdByName = new Map(
    repoRows.map((repo) => [`${repo.owner}/${repo.name}`.toLowerCase(), repo.id]),
  );
  const runPullConditions: SQL[] = [];
  const runIssueConditions: SQL[] = [];
  for (const run of runRows) {
    const gh = objectOrEmpty(run.gh);
    const owner = typeof gh.owner === "string" ? gh.owner : null;
    const repoName = typeof gh.repo === "string" ? gh.repo : null;
    const runRepoId =
      owner && repoName ? repoIdByName.get(`${owner}/${repoName}`.toLowerCase()) : null;
    if (!runRepoId) continue;
    const pullNumber = numberOrUndefined(objectOrEmpty(gh.pr).number);
    if (pullNumber) {
      runPullConditions.push(
        and(eq(ghPullRequests.repoId, runRepoId), eq(ghPullRequests.number, pullNumber)) as SQL,
      );
    }
    const issueNumber = numberOrUndefined(gh.issueNumber);
    if (issueNumber) {
      runIssueConditions.push(
        and(eq(ghIssues.repoId, runRepoId), eq(ghIssues.number, issueNumber)) as SQL,
      );
    }
  }
  const [runPulls, runIssues] = await Promise.all([
    runPullConditions.length
      ? db
          .select()
          .from(ghPullRequests)
          .where(
            and(
              eq(ghPullRequests.orgId, orgId),
              eq(ghPullRequests.projectId, projectId),
              or(...runPullConditions),
            ),
          )
      : [],
    runIssueConditions.length
      ? db
          .select()
          .from(ghIssues)
          .where(
            and(
              eq(ghIssues.orgId, orgId),
              eq(ghIssues.projectId, projectId),
              visiblePipelineIssue(shippedSince),
              or(...runIssueConditions),
            ),
          )
      : [],
  ]);
  pullRows = uniqueRows([...pullRows, ...runPulls]);
  issueRows = uniqueRows([...issueRows, ...runIssues]);

  // Run provenance can reveal the issue before GitHub has indexed a closing
  // reference. Once revealed, expand the same closing-reference neighborhood
  // the project board uses so detail and activity payloads share one story.
  const expandedLinkedPullConditions = issueRows.map(
    (issue) =>
      and(
        eq(ghPullRequests.repoId, issue.repoId),
        sql`${ghPullRequests.closingIssues} @> ARRAY[${issue.number}]::integer[]`,
      ) as SQL,
  );
  const expandedReferencedIssueConditions: SQL[] = [];
  for (const pull of pullRows) {
    if (pull.closingIssues.length === 0) continue;
    expandedReferencedIssueConditions.push(
      and(eq(ghIssues.repoId, pull.repoId), inArray(ghIssues.number, pull.closingIssues)) as SQL,
    );
  }
  const [expandedLinkedPulls, expandedReferencedIssues] = await Promise.all([
    expandedLinkedPullConditions.length
      ? db
          .select()
          .from(ghPullRequests)
          .where(
            and(
              eq(ghPullRequests.orgId, orgId),
              eq(ghPullRequests.projectId, projectId),
              or(...expandedLinkedPullConditions),
            ),
          )
      : [],
    expandedReferencedIssueConditions.length
      ? db
          .select()
          .from(ghIssues)
          .where(
            and(
              eq(ghIssues.orgId, orgId),
              eq(ghIssues.projectId, projectId),
              visiblePipelineIssue(shippedSince),
              or(...expandedReferencedIssueConditions),
            ),
          )
      : [],
  ]);
  pullRows = uniqueRows([...pullRows, ...expandedLinkedPulls]);
  issueRows = uniqueRows([...issueRows, ...expandedReferencedIssues]);
  runRows = await runsForAssembly(db, orgId, projectId, issueRows, pullRows, repoRows);
  return assemblePipelineStories({
    issues: issueRows,
    pullRequests: pullRows,
    repos: repoRows,
    runs: runRows,
  });
}

async function runsForAssembly(
  db: FastifyInstance["facilityDb"],
  orgId: string,
  projectId: string,
  issueRows: Array<{ repoId: string; number: number }>,
  pullRows: Array<{ repoId: string; number: number }>,
  repoRows: Array<{ id: string; owner: string; name: string }>,
) {
  const repoScopes: SQL[] = [];
  for (const repo of repoRows) {
    const issueNumbers = issueRows
      .filter((issue) => issue.repoId === repo.id)
      .map((issue) => issue.number);
    const pullNumbers = pullRows
      .filter((pull) => pull.repoId === repo.id)
      .map((pull) => pull.number);
    const numberScopes: SQL[] = [];
    const directNumbers = [...new Set([...issueNumbers, ...pullNumbers])];
    if (directNumbers.length > 0) {
      numberScopes.push(inArray(sql<number>`(${runs.gh}->>'issueNumber')::int`, directNumbers));
    }
    if (pullNumbers.length > 0) {
      numberScopes.push(inArray(sql<number>`(${runs.gh}->'pr'->>'number')::int`, pullNumbers));
    }
    if (numberScopes.length === 0) continue;
    repoScopes.push(
      and(
        sql`lower(${runs.gh}->>'owner') = lower(${repo.owner})`,
        sql`lower(${runs.gh}->>'repo') = lower(${repo.name})`,
        or(...numberScopes),
      ) as SQL,
    );
  }
  if (repoScopes.length === 0) return [];
  return db
    .select({ id: runs.id, mode: runs.mode, status: runs.status, engine: runs.engine, gh: runs.gh })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.projectId, projectId), or(...repoScopes)));
}

function integerArray(values: number[]) {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::integer[]`;
}

function visiblePipelineIssue(shippedSince: Date): SQL {
  return or(
    eq(ghIssues.state, "open"),
    gte(ghIssues.closedAt, shippedSince),
    and(isNull(ghIssues.closedAt), gte(ghIssues.ghUpdatedAt, shippedSince)),
  ) as SQL;
}

function uniqueRows<Row extends { id: string }>(rows: Row[]): Row[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

async function loadOpenPlanProposals(
  db: FastifyInstance["facilityDb"],
  orgId: string,
  projectId: string,
) {
  return db
    .select({ id: proposals.id, runId: proposals.runId, payload: proposals.payload })
    .from(proposals)
    .innerJoin(actionTypes, eq(actionTypes.id, proposals.actionTypeId))
    .where(
      and(
        eq(proposals.orgId, orgId),
        eq(proposals.projectId, projectId),
        eq(proposals.state, "open"),
        eq(actionTypes.name, "plan_acceptance"),
      ),
    );
}

function proposalKeysForAssembly(
  assembly: PipelineAssembly,
  openProposals: Array<{ runId: string | null; payload: unknown }>,
  ambiguousLegacyIssueNumbers: ReadonlySet<number> = new Set(),
) {
  const keys = new Set<string>();
  for (const proposal of openProposals) {
    let linkedByRun = false;
    if (proposal.runId) {
      for (const key of assembly.storyKeysByRunId.get(proposal.runId) ?? []) {
        keys.add(key);
        linkedByRun = true;
      }
    }
    if (linkedByRun) continue;
    const payload = objectOrEmpty(proposal.payload);
    const issueNumber = numberOrUndefined(payload.issueNumber);
    const repoId = typeof payload.repoId === "string" ? payload.repoId : null;
    if (!repoId && issueNumber && ambiguousLegacyIssueNumbers.has(issueNumber)) continue;
    const matches = assembly.stories.filter(
      (story) =>
        story.storyType === "issue" &&
        story.number === issueNumber &&
        (!repoId || story.repoId === repoId),
    );
    const match = matches.length === 1 ? matches[0] : null;
    if (match) keys.add(match.key);
  }
  return keys;
}

async function loadIssue(
  db: FastifyInstance["facilityDb"],
  orgId: string,
  projectId: string,
  number: number,
  repoId?: string,
) {
  const matches = await db
    .select()
    .from(ghIssues)
    .where(
      and(
        eq(ghIssues.orgId, orgId),
        eq(ghIssues.projectId, projectId),
        eq(ghIssues.number, number),
        ...(repoId ? [eq(ghIssues.repoId, repoId)] : []),
      ),
    )
    .limit(2);
  if (matches.length === 0) throw notFound("Issue not found");
  if (matches.length > 1) {
    throw new ApiError(
      409,
      "ambiguous_issue_number",
      "Issue number exists in more than one project repository; provide repoId",
    );
  }
  return matches[0] as (typeof matches)[number];
}

async function linkedRunsForIssues(
  db: FastifyInstance["facilityDb"],
  orgId: string,
  projectId: string,
  issues: Array<{ repoId: string; number: number }>,
) {
  const map = new Map<string, ReturnType<typeof linkedRunFromRun>[]>();
  if (issues.length === 0) return map;
  const numbers = [...new Set(issues.map((issue) => issue.number))];
  const repoRows = await db
    .select({ id: repos.id, owner: repos.owner, name: repos.name })
    .from(repos)
    .where(and(eq(repos.orgId, orgId), eq(repos.projectId, projectId)));
  const repoIdByName = new Map(
    repoRows.map((repo) => [`${repo.owner}/${repo.name}`.toLowerCase(), repo.id]),
  );
  const rows = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.orgId, orgId),
        eq(runs.projectId, projectId),
        inArray(sql<number>`(${runs.gh}->>'issueNumber')::int`, numbers),
      ),
    );
  for (const run of rows) {
    const gh = objectOrEmpty(run.gh);
    const issueNumber = numberOrUndefined(gh.issueNumber);
    const owner = typeof gh.owner === "string" ? gh.owner : null;
    const name = typeof gh.repo === "string" ? gh.repo : null;
    const repoId = owner && name ? repoIdByName.get(`${owner}/${name}`.toLowerCase()) : null;
    if (!issueNumber || !repoId) continue;
    const key = repoNumberKey(repoId, issueNumber);
    const list = map.get(key) ?? [];
    list.push(linkedRunFromRun(run));
    map.set(key, list);
  }
  return map;
}

async function fullRunsForIssue(
  db: FastifyInstance["facilityDb"],
  orgId: string,
  projectId: string,
  issue: typeof ghIssues.$inferSelect,
) {
  const repo = (
    await db
      .select()
      .from(repos)
      .where(
        and(eq(repos.orgId, orgId), eq(repos.projectId, projectId), eq(repos.id, issue.repoId)),
      )
      .limit(1)
  )[0];
  if (!repo) return [];
  return db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.orgId, orgId),
        eq(runs.projectId, projectId),
        sql`(${runs.gh}->>'issueNumber')::int = ${issue.number}`,
        sql`lower(${runs.gh}->>'owner') = lower(${repo.owner})`,
        sql`lower(${runs.gh}->>'repo') = lower(${repo.name})`,
      ),
    )
    .orderBy(desc(runs.queuedAt));
}

async function presentStoryRuns(
  db: FastifyInstance["facilityDb"],
  storyRuns: Array<typeof runs.$inferSelect>,
) {
  const creatorIds = [
    ...new Set(
      storyRuns
        .map((run) => {
          const createdBy = objectOrEmpty(run.createdBy);
          return createdBy.type === "user" && typeof createdBy.id === "string"
            ? createdBy.id
            : null;
        })
        .filter((id): id is string => id !== null),
    ),
  ];
  const emailById = new Map(
    (creatorIds.length
      ? await db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(inArray(users.id, creatorIds))
      : []
    ).map((row) => [row.id, row.email]),
  );
  return storyRuns.map((run) => {
    const trigger = objectOrEmpty(run.trigger);
    const createdBy = objectOrEmpty(run.createdBy);
    let triggeredBy: string | null = null;
    if (trigger.source === "plan_acceptance") triggeredBy = "plan approval";
    else if (trigger.type === "schedule") triggeredBy = "schedule";
    else if (createdBy.type === "user" && typeof createdBy.id === "string") {
      triggeredBy = emailById.get(createdBy.id) ?? "a member";
    } else if (typeof createdBy.id === "string" && createdBy.id) triggeredBy = createdBy.id;
    else if (typeof createdBy.login === "string" && createdBy.login) {
      triggeredBy = createdBy.login;
    } else if (typeof createdBy.name === "string" && createdBy.name) triggeredBy = createdBy.name;
    const gh = objectOrEmpty(run.gh);
    return {
      id: run.id,
      mode: run.mode,
      engine: run.engine,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      receipt: run.receipt,
      pr: gh.pr,
      triggeredBy,
    };
  });
}

function issueItem(
  issue: typeof ghIssues.$inferSelect,
  linkedRuns: ReturnType<typeof linkedRunFromRun>[],
) {
  return {
    id: issue.id,
    repoId: issue.repoId,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    labels: issue.labels,
    assignees: issue.assignees,
    author: issue.author,
    htmlUrl: issue.htmlUrl,
    commentsCount: issue.commentsCount,
    ghUpdatedAt: issue.ghUpdatedAt,
    closedAt: issue.closedAt,
    linkedRuns,
  };
}

function linkedRunFromRun(run: typeof runs.$inferSelect) {
  const gh = objectOrEmpty(run.gh);
  return { id: run.id, mode: run.mode, status: run.status, engine: run.engine, pr: gh.pr };
}

async function ackIssueQueued(
  db: FastifyInstance["facilityDb"],
  factory: ReturnType<typeof createGithubClientFactory> | undefined,
  repo: typeof repos.$inferSelect,
  issueNumber: number,
  agent: string,
  runId: string,
) {
  if (!factory) return;
  try {
    const client = await createGithubClientForRepo(db, factory, repo);
    // App-authored comments are dropped by the webhook processor's Bot-sender
    // guard, so this acknowledgement cannot become a trigger input.
    await client.createIssueComment(
      issueNumber,
      `Facility queued ${agent} run ${runId} (triggered from the control plane).`,
    );
  } catch {
    // Best effort only.
  }
}

async function assignIssueBestEffort(
  db: FastifyInstance["facilityDb"],
  factory: GithubClientFactory | undefined,
  repo: typeof repos.$inferSelect,
  issueNumber: number,
  login: string | null,
  runId: string,
  actor: { type: "user" | "key"; id: string },
) {
  let reason: string | null = null;
  try {
    if (!login) reason = "missing_github_login";
    else if (!factory) reason = "github_app_unconfigured";
    else {
      const client = await createGithubClientForRepo(db, factory, repo);
      if (!(await client.assignIssue(issueNumber, login))) reason = "github_rejected";
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  if (!reason) return;
  await insertAuditEvent(db, {
    orgId: repo.orgId,
    projectId: repo.projectId,
    actor,
    action: "github.assignment.skipped",
    target: { type: "issue", id: `${repo.id}:${issueNumber}` },
    payload: { runId, issueNumber, login, reason },
  });
}

function encodeIssueCursor(updatedAt: Date | null, number: number, repoId: string) {
  return Buffer.from(
    JSON.stringify({ updatedAt: updatedAt?.toISOString() ?? null, number, repoId }),
  ).toString("base64url");
}

function decodeIssueCursor(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      updatedAt?: string | null;
      number?: number;
      repoId?: string;
    };
    if (!parsed.updatedAt || typeof parsed.number !== "number" || !parsed.repoId) return null;
    return { updatedAt: new Date(parsed.updatedAt), number: parsed.number, repoId: parsed.repoId };
  } catch {
    return null;
  }
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrUndefined(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function repoNumberKey(repoId: string, number: number) {
  return `${repoId}:${number}`;
}
