import { newId } from "@facility/core";
import {
  ghIssues,
  githubInstallations,
  insertAuditEvent,
  repos,
  runEvents,
  runs,
} from "@facility/db";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound } from "../../errors.js";
import { createGithubClientFactory } from "../../github/client.js";
import { createGithubClientForRepo } from "../../github/kickstart.js";
import { findAgentDef } from "../../github/router.js";
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

const LinkedRunSchema = z.object({
  id: z.string(),
  mode: z.string(),
  status: z.string(),
  engine: z.string(),
  pr: JsonValue.optional(),
});

const GhIssueItemSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  labels: JsonValue,
  assignees: JsonValue,
  author: z.string().nullable(),
  htmlUrl: z.string(),
  commentsCount: z.number(),
  ghUpdatedAt: DateValue.nullable(),
  linkedRuns: z.array(LinkedRunSchema),
});

const GhIssueDetailSchema = GhIssueItemSchema.extend({
  bodyMd: z.string().nullable(),
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
        );
        if (cursorClause) clauses.push(cursorClause);
      }
      const rows = await db
        .select()
        .from(ghIssues)
        .where(and(...clauses))
        .orderBy(desc(ghIssues.ghUpdatedAt), desc(ghIssues.number))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const linkedRuns = await linkedRunsForIssues(
        db,
        p.orgId,
        projectId,
        page.map((row) => row.number),
      );
      return {
        items: page.map((issue) => issueItem(issue, linkedRuns.get(issue.number) ?? [])),
        nextCursor:
          rows.length > query.limit && page.at(-1)
            ? encodeIssueCursor(page.at(-1)?.ghUpdatedAt ?? null, page.at(-1)?.number ?? 0)
            : null,
      };
    },
  );

  app.get(
    "/v1/projects/:projectId/issues/:number",
    {
      config: { permission: "runs:read" },
      schema: {
        params: z.object({ projectId: z.string(), number: z.coerce.number().int() }),
        response: { 200: GhIssueDetailSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId, number } = request.params as { projectId: string; number: number };
      assertProjectScope(p, projectId);
      const issue = await loadIssue(db, p.orgId, projectId, number);
      const issueRuns = await fullRunsForIssue(db, p.orgId, projectId, number);
      return {
        ...issueItem(issue, issueRuns.map(linkedRunFromRun)),
        bodyMd: issue.bodyMd,
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
          };
        }),
      };
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
        params: z.object({ projectId: z.string(), number: z.coerce.number().int() }),
        body: z.object({ agent: z.string().min(1) }),
        response: { 200: RunSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId, number } = request.params as { projectId: string; number: number };
      assertProjectScope(p, projectId);
      const body = request.body as { agent: string };
      const issue = await loadIssue(db, p.orgId, projectId, number);
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
      // No GitHub userCanWrite check: platform RBAC `runs:trigger` is the authority
      // for control-plane-originated dispatch.
      // No execution_lane gate: an explicit control-plane trigger is platform-lane intent.
      const agent = await findAgentDef(db, p.orgId, projectId, body.agent);
      if (!agent) throw new ApiError(400, "agent_not_found", "Agent definition not found");
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
              repo: { id: repo.id, owner: repo.owner, name: repo.name },
              issue: { number },
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
      await ackIssueQueued(
        db,
        app.githubClientFactory ??
          (config.githubAppId && config.githubAppPrivateKey
            ? createGithubClientFactory(config)
            : undefined),
        repo,
        number,
        body.agent,
        run.id,
      );
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

type InstallationRepo = {
  name?: string;
  full_name?: string;
  private?: boolean;
  default_branch?: string;
  html_url?: string;
  owner?: { login?: string };
};

async function loadIssue(
  db: FastifyInstance["facilityDb"],
  orgId: string,
  projectId: string,
  number: number,
) {
  const issue = (
    await db
      .select()
      .from(ghIssues)
      .where(
        and(
          eq(ghIssues.orgId, orgId),
          eq(ghIssues.projectId, projectId),
          eq(ghIssues.number, number),
        ),
      )
      .limit(1)
  )[0];
  if (!issue) throw notFound("Issue not found");
  return issue;
}

async function linkedRunsForIssues(
  db: FastifyInstance["facilityDb"],
  orgId: string,
  projectId: string,
  numbers: number[],
) {
  const map = new Map<number, ReturnType<typeof linkedRunFromRun>[]>();
  if (numbers.length === 0) return map;
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
    const issueNumber = numberOrUndefined(objectOrEmpty(run.gh).issueNumber);
    if (!issueNumber) continue;
    const list = map.get(issueNumber) ?? [];
    list.push(linkedRunFromRun(run));
    map.set(issueNumber, list);
  }
  return map;
}

async function fullRunsForIssue(
  db: FastifyInstance["facilityDb"],
  orgId: string,
  projectId: string,
  number: number,
) {
  return db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.orgId, orgId),
        eq(runs.projectId, projectId),
        sql`(${runs.gh}->>'issueNumber')::int = ${number}`,
      ),
    )
    .orderBy(desc(runs.queuedAt));
}

function issueItem(
  issue: typeof ghIssues.$inferSelect,
  linkedRuns: ReturnType<typeof linkedRunFromRun>[],
) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    labels: issue.labels,
    assignees: issue.assignees,
    author: issue.author,
    htmlUrl: issue.htmlUrl,
    commentsCount: issue.commentsCount,
    ghUpdatedAt: issue.ghUpdatedAt,
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

function encodeIssueCursor(updatedAt: Date | null, number: number) {
  return Buffer.from(
    JSON.stringify({ updatedAt: updatedAt?.toISOString() ?? null, number }),
  ).toString("base64url");
}

function decodeIssueCursor(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      updatedAt?: string | null;
      number?: number;
    };
    if (!parsed.updatedAt || typeof parsed.number !== "number") return null;
    return { updatedAt: new Date(parsed.updatedAt), number: parsed.number };
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
