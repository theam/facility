import {
  type FacilityDb,
  projectRepositories,
  stories,
  turnGitEvidence,
  turns,
  workspaces,
} from "@facility/db";
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { isSafeGitBranch } from "../workspaces/git-branch.js";
import { appendStoryEvidence } from "./evidence.js";

type Story = typeof stories.$inferSelect;
type Evidence = typeof turnGitEvidence.$inferSelect;

export function observedStoryBranch(
  story: Pick<Story, "branch" | "pullRequestNumber" | "status">,
  evidence: Pick<Evidence, "initialBranch" | "finalBranch" | "captureError" | "completedAt">,
  defaultBranch: string | undefined,
): string | null {
  const branch = evidence.finalBranch;
  if (
    story.pullRequestNumber !== null ||
    ["done", "archived"].includes(story.status) ||
    story.branch === null ||
    evidence.initialBranch !== story.branch ||
    evidence.captureError !== null ||
    evidence.completedAt === null ||
    !branch ||
    branch === story.branch ||
    branch === defaultBranch ||
    !isSafeGitBranch(branch)
  )
    return null;
  return branch;
}

/** Called inside the story transaction; only completed native Git evidence can move its branch. */
export async function reconcileTurnBranch(
  db: FacilityDb,
  story: Story,
  turn: typeof turns.$inferSelect,
) {
  if (turn.state !== "succeeded" || story.branch === null) return;
  const latest = (
    await db
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(
          eq(turns.orgId, story.orgId),
          eq(turns.projectId, story.projectId),
          eq(turns.storyId, story.id),
        ),
      )
      .orderBy(desc(turns.createdAt), desc(turns.id))
      .limit(1)
  )[0];
  if (latest?.id !== turn.id) return;
  const observed = (
    await db
      .select({ evidence: turnGitEvidence })
      .from(turnGitEvidence)
      .innerJoin(
        workspaces,
        and(
          eq(workspaces.id, turnGitEvidence.workspaceId),
          eq(workspaces.orgId, story.orgId),
          eq(workspaces.projectId, story.projectId),
          eq(workspaces.storyId, story.id),
          inArray(workspaces.state, ["running", "sleeping", "error"]),
        ),
      )
      .where(
        and(
          eq(turnGitEvidence.orgId, story.orgId),
          eq(turnGitEvidence.projectId, story.projectId),
          eq(turnGitEvidence.storyId, story.id),
          eq(turnGitEvidence.turnId, turn.id),
          isNotNull(turnGitEvidence.completedAt),
          isNull(turnGitEvidence.captureError),
        ),
      )
      .limit(1)
  )[0]?.evidence;
  if (!observed) return;
  const repository = (
    await db
      .select({
        id: projectRepositories.id,
        role: projectRepositories.role,
        defaultBranch: projectRepositories.defaultBranch,
      })
      .from(projectRepositories)
      .where(
        and(
          eq(projectRepositories.orgId, story.orgId),
          eq(projectRepositories.projectId, story.projectId),
          story.repositoryId
            ? eq(projectRepositories.id, story.repositoryId)
            : eq(projectRepositories.role, "primary"),
        ),
      )
      .limit(1)
  )[0];
  if (!repository) return;
  const branch = observedStoryBranch(story, observed, repository.defaultBranch);
  if (!branch) return;
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`facility:story-branch:${story.orgId}:${story.projectId}:${repository.id}:${branch}`}))`,
  );
  const conflict = (
    await db
      .select({ id: stories.id })
      .from(stories)
      .where(
        and(
          eq(stories.orgId, story.orgId),
          eq(stories.projectId, story.projectId),
          repository.role === "primary"
            ? or(eq(stories.repositoryId, repository.id), isNull(stories.repositoryId))
            : eq(stories.repositoryId, repository.id),
          eq(stories.branch, branch),
          ne(stories.id, story.id),
        ),
      )
      .limit(1)
  )[0];
  if (conflict) return;
  const changed = await db
    .update(stories)
    .set({ branch, updatedAt: new Date() })
    .where(
      and(
        eq(stories.orgId, story.orgId),
        eq(stories.projectId, story.projectId),
        eq(stories.id, story.id),
        eq(stories.branch, story.branch),
        isNull(stories.pullRequestNumber),
      ),
    )
    .returning({ id: stories.id });
  if (!changed.length) return;
  await appendStoryEvidence(db, {
    orgId: story.orgId,
    projectId: story.projectId,
    storyId: story.id,
    turnId: turn.id,
    source: "workspace",
    type: "story.branch_updated",
    externalKey: `turn:${turn.id}:branch`,
    data: {
      workspaceId: observed.workspaceId,
      initialBranch: observed.initialBranch,
      branch,
      finalSha: observed.finalSha,
    },
  });
}
