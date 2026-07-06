import { newId } from "@facility/core";
import { type FacilityDb, ghIssues, githubInstallations, repos } from "@facility/db";
import { and, eq, max, sql } from "drizzle-orm";
import { FacilityGithubClient, type GithubClientFactory } from "./client.js";

const ISSUE_BODY_LIMIT = 64 * 1024;

export type GithubIssuePayload = {
  action?: string;
  issue?: GithubIssue;
  repository?: {
    name?: string;
    full_name?: string;
    owner?: { login?: string };
    default_branch?: string;
  };
};

type GithubIssue = {
  number?: number;
  title?: string;
  state?: string;
  user?: { login?: string };
  labels?: Array<string | { name?: string | null }>;
  assignees?: Array<{ login?: string | null }>;
  html_url?: string;
  body?: string | null;
  comments?: number;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  pull_request?: unknown;
};

const ISSUE_ACTIONS = new Set([
  "opened",
  "edited",
  "closed",
  "reopened",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
]);

export async function upsertGhIssueFromWebhook(
  db: FacilityDb,
  orgId: string,
  payload: GithubIssuePayload,
) {
  if (!payload.action || !ISSUE_ACTIONS.has(payload.action)) return null;
  const owner = payload.repository?.owner?.login;
  const name = payload.repository?.name;
  const issue = payload.issue;
  if (!owner || !name || !issue?.number || issue.pull_request) return null;
  const repo = await resolveRepo(db, orgId, owner, name);
  if (!repo) return null;
  return upsertIssue(db, repo, issue);
}

export async function bumpGhIssueCommentCount(
  db: FacilityDb,
  orgId: string,
  payload: GithubIssuePayload,
) {
  const owner = payload.repository?.owner?.login;
  const name = payload.repository?.name;
  const issueNumber = payload.issue?.number;
  if (!owner || !name || !issueNumber || payload.issue?.pull_request) return null;
  const repo = await resolveRepo(db, orgId, owner, name);
  if (!repo) return null;
  const [row] = await db
    .update(ghIssues)
    .set({
      commentsCount: sql`${ghIssues.commentsCount} + 1`,
      ghUpdatedAt: new Date(),
      syncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(ghIssues.orgId, orgId),
        eq(ghIssues.projectId, repo.projectId),
        eq(ghIssues.repoId, repo.id),
        eq(ghIssues.number, issueNumber),
      ),
    )
    .returning();
  return row ?? null;
}

export async function syncRepoIssues(
  db: FacilityDb,
  clientFactory: GithubClientFactory,
  repo: typeof repos.$inferSelect,
) {
  if (!repo.installationId) return { synced: 0 };
  const installation = (
    await db
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.orgId, repo.orgId),
          eq(githubInstallations.id, repo.installationId),
        ),
      )
      .limit(1)
  )[0];
  if (!installation || installation.suspendedAt) return { synced: 0 };
  const cursor = (
    await db
      .select({ value: max(ghIssues.syncedAt) })
      .from(ghIssues)
      .where(and(eq(ghIssues.orgId, repo.orgId), eq(ghIssues.repoId, repo.id)))
  )[0]?.value;
  const client = new FacilityGithubClient(await clientFactory(installation.installationId), {
    owner: repo.owner,
    repo: repo.name,
    defaultBranch: repo.defaultBranch,
  });
  let synced = 0;
  for (let page = 1; page <= 10; page++) {
    const issues = await client.listIssues({
      state: "all",
      since: cursor ? cursor.toISOString() : undefined,
      page,
      perPage: 100,
    });
    if (issues.length === 0) break;
    for (const raw of issues) {
      const issue = raw as GithubIssue;
      if (issue.pull_request) continue;
      await upsertIssue(db, repo, issue);
      synced += 1;
    }
  }
  return { synced };
}

async function resolveRepo(db: FacilityDb, orgId: string, owner: string, name: string) {
  return (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.owner, owner), eq(repos.name, name)))
      .limit(1)
  )[0];
}

async function upsertIssue(db: FacilityDb, repo: typeof repos.$inferSelect, issue: GithubIssue) {
  if (!issue.number || !issue.title || !issue.html_url) return null;
  const now = new Date();
  const values = {
    id: newId("ghi"),
    orgId: repo.orgId,
    projectId: repo.projectId,
    repoId: repo.id,
    number: issue.number,
    title: issue.title,
    state: issue.state === "closed" ? "closed" : "open",
    author: issue.user?.login ?? null,
    labels: issueLabels(issue),
    assignees: issueAssignees(issue),
    htmlUrl: issue.html_url,
    bodyMd: capBody(issue.body),
    commentsCount: Number(issue.comments ?? 0),
    ghCreatedAt: dateOrNull(issue.created_at),
    ghUpdatedAt: dateOrNull(issue.updated_at),
    closedAt: dateOrNull(issue.closed_at),
    syncedAt: now,
    updatedAt: now,
  };
  const [row] = await db
    .insert(ghIssues)
    .values(values)
    .onConflictDoUpdate({
      target: [ghIssues.repoId, ghIssues.number],
      set: {
        title: values.title,
        state: values.state,
        author: values.author,
        labels: values.labels,
        assignees: values.assignees,
        htmlUrl: values.htmlUrl,
        bodyMd: values.bodyMd,
        commentsCount: values.commentsCount,
        ghCreatedAt: values.ghCreatedAt,
        ghUpdatedAt: values.ghUpdatedAt,
        closedAt: values.closedAt,
        syncedAt: now,
        updatedAt: now,
      },
    })
    .returning();
  return row ?? null;
}

function issueLabels(issue: GithubIssue): string[] {
  return (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
    .filter(Boolean);
}

function issueAssignees(issue: GithubIssue): string[] {
  return (issue.assignees ?? []).map((assignee) => assignee.login ?? "").filter(Boolean);
}

function capBody(body: string | null | undefined) {
  if (!body) return null;
  return body.length > ISSUE_BODY_LIMIT ? body.slice(0, ISSUE_BODY_LIMIT) : body;
}

function dateOrNull(value: string | null | undefined) {
  return value ? new Date(value) : null;
}
