import { newId } from "@facility/core";
import {
  type FacilityDb,
  ghIssues,
  githubInstallations,
  repos,
  schedulerWatermarks,
} from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import { FacilityGithubClient, type GithubClientFactory } from "./client.js";

const ISSUE_BODY_LIMIT = 64 * 1024;
const SYNC_OVERLAP_MS = 2 * 60 * 1000;
const ISSUE_WATERMARK_PREFIX = "github.issues";
const MAX_PAGES_PER_JOB = 10;
const INITIAL_WATERMARK = new Date(0);

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
  state_reason?: string | null;
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
      ghUpdatedAt: dateOrNull(payload.issue?.updated_at) ?? sql`${ghIssues.ghUpdatedAt}`,
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
  if (!repo.installationId) return { synced: 0, incomplete: false };
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
  if (!installation || installation.suspendedAt) return { synced: 0, incomplete: false };
  const watermarkName = `${ISSUE_WATERMARK_PREFIX}:${repo.id}`;
  const watermark = (
    await db
      .select()
      .from(schedulerWatermarks)
      .where(eq(schedulerWatermarks.name, watermarkName))
      .limit(1)
  )[0];
  const client = new FacilityGithubClient(await clientFactory(installation.installationId), {
    owner: repo.owner,
    repo: repo.name,
    defaultBranch: repo.defaultBranch,
  });
  const progress = issueScanProgress(watermark?.cursor);
  const completedSince = watermark
    ? new Date(Math.max(0, watermark.lastTick.getTime() - SYNC_OVERLAP_MS)).toISOString()
    : undefined;
  const syncStartedAt = watermark?.scanStartedAt ?? new Date();
  let highWater = progress?.highWater ?? null;
  let page = progress?.page ?? 1;
  let synced = 0;
  for (let pages = 0; pages < MAX_PAGES_PER_JOB; pages += 1) {
    const pageStartHighWater = highWater;
    // Page offsets are safe only while the lower bound is unchanged. Advancing
    // the lower bound after every page prevents updates to already-scanned
    // issues from shifting an unseen issue behind a persisted page offset.
    // One millisecond of overlap keeps every record at GitHub's second-level
    // boundary visible; a same-boundary continuation uses the next page.
    const since = highWater
      ? new Date(Math.max(0, highWater.getTime() - 1)).toISOString()
      : completedSince;
    const issues = await client.listIssues({
      state: "all",
      since,
      page,
      perPage: 100,
    });
    for (const raw of issues) {
      const issue = raw as GithubIssue;
      const updatedAt = dateOrNull(issue.updated_at);
      if (updatedAt && (!highWater || updatedAt > highWater)) highWater = updatedAt;
      if (issue.pull_request) continue;
      await upsertIssue(db, repo, issue);
      synced += 1;
    }
    if (issues.length < 100) {
      await completeIssueScan(
        db,
        watermarkName,
        laterDate(watermark?.lastTick ?? null, highWater) ?? syncStartedAt,
      );
      return { synced, incomplete: false };
    }
    const advanced =
      highWater !== null &&
      (pageStartHighWater === null || highWater.getTime() > pageStartHighWater.getTime());
    const nextPage = advanced ? 1 : page + 1;
    await saveIssueScanProgress(db, {
      name: watermarkName,
      previousCompletedAt: watermark?.lastTick ?? INITIAL_WATERMARK,
      page: nextPage,
      highWater,
      scanStartedAt: syncStartedAt,
    });
    page = nextPage;
  }
  return { synced, incomplete: true };
}

function laterDate(left: Date | null, right: Date | null) {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

async function saveIssueScanProgress(
  db: FacilityDb,
  input: {
    name: string;
    previousCompletedAt: Date;
    page: number;
    highWater: Date | null;
    scanStartedAt: Date;
  },
) {
  const cursor = JSON.stringify({
    page: input.page,
    highWater: input.highWater?.toISOString() ?? null,
  });
  await db
    .insert(schedulerWatermarks)
    .values({
      name: input.name,
      lastTick: input.previousCompletedAt,
      cursor,
      scanStartedAt: input.scanStartedAt,
    })
    .onConflictDoUpdate({
      target: schedulerWatermarks.name,
      set: {
        cursor,
        scanStartedAt: input.scanStartedAt,
        updatedAt: new Date(),
      },
    });
}

async function completeIssueScan(db: FacilityDb, name: string, completedThrough: Date) {
  await db
    .insert(schedulerWatermarks)
    .values({ name, lastTick: completedThrough })
    .onConflictDoUpdate({
      target: schedulerWatermarks.name,
      set: {
        lastTick: completedThrough,
        cursor: null,
        scanStartedAt: null,
        updatedAt: new Date(),
      },
    });
}

function issueScanProgress(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { page?: unknown; highWater?: unknown };
    if (typeof parsed.page !== "number" || !Number.isInteger(parsed.page) || parsed.page < 1) {
      return null;
    }
    const highWater = typeof parsed.highWater === "string" ? new Date(parsed.highWater) : null;
    if (highWater && !Number.isFinite(highWater.getTime())) return null;
    return { page: parsed.page, highWater };
  } catch {
    return null;
  }
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
    stateReason: issueStateReason(issue.state_reason),
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
        stateReason: values.stateReason,
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

/** Only GitHub's documented reasons reach the mirror; the column is checked. */
function issueStateReason(value: string | null | undefined) {
  return value === "completed" ||
    value === "not_planned" ||
    value === "duplicate" ||
    value === "reopened"
    ? value
    : null;
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
