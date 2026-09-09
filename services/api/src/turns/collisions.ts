import { type FacilityDb, githubPullRequests, stories, turnGitEvidence } from "@facility/db";
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";

/** Paths listed per colliding story in the prompt and the evidence event. */
export const MAX_COLLISION_PATHS = 20;
/** Colliding stories reported per turn; the rest are counted. */
export const MAX_COLLISION_STORIES = 10;

const ACTIVE_STORY_STATUSES = ["ready", "working", "attention", "review"] as const;

export type StoryCollision = {
  storyId: string;
  title: string;
  provider: string;
  externalId: string;
  branch: string;
  status: string;
  overlappingPaths: string[];
  overlapCount: number;
};

/**
 * Detects other active stories in the same project whose recorded Git evidence changed files this
 * story also changed. It is advisory only: it reads evidence that already exists and never blocks
 * dispatch. A story with no completed evidence yet cannot collide, because its files are unknown.
 */
export class StoryCollisionService {
  constructor(private readonly db: FacilityDb) {}

  async detect(input: {
    orgId: string;
    projectId: string;
    storyId: string;
  }): Promise<StoryCollision[]> {
    const mine = (await this.changedPaths(input.orgId, input.projectId, [input.storyId])).get(
      input.storyId,
    );
    if (!mine || mine.size === 0) return [];

    const candidates = await this.db
      .select({
        id: stories.id,
        title: stories.title,
        provider: stories.provider,
        externalId: stories.externalId,
        branch: stories.branch,
        status: stories.status,
      })
      .from(stories)
      .where(
        and(
          eq(stories.orgId, input.orgId),
          eq(stories.projectId, input.projectId),
          ne(stories.id, input.storyId),
          inArray(stories.status, [...ACTIVE_STORY_STATUSES]),
          isNull(stories.deletedAt),
          isNull(stories.archivedAt),
          isNotNull(stories.branch),
        ),
      );
    const open = candidates.filter(
      (candidate): candidate is typeof candidate & { branch: string } => candidate.branch !== null,
    );
    if (open.length === 0) return [];

    const merged = new Set(
      (
        await this.db
          .select({ headRef: githubPullRequests.headRef })
          .from(githubPullRequests)
          .where(
            and(
              eq(githubPullRequests.orgId, input.orgId),
              eq(githubPullRequests.projectId, input.projectId),
              eq(githubPullRequests.state, "merged"),
              inArray(
                githubPullRequests.headRef,
                open.map((candidate) => candidate.branch),
              ),
            ),
          )
      ).map((row) => row.headRef),
    );
    const live = open.filter((candidate) => !merged.has(candidate.branch));
    if (live.length === 0) return [];

    const theirs = await this.changedPaths(
      input.orgId,
      input.projectId,
      live.map((candidate) => candidate.id),
    );
    const collisions: StoryCollision[] = [];
    for (const candidate of live) {
      const paths = theirs.get(candidate.id);
      if (!paths) continue;
      const overlap = overlappingPaths(mine, paths);
      if (overlap.length === 0) continue;
      collisions.push({
        storyId: candidate.id,
        title: candidate.title,
        provider: candidate.provider,
        externalId: candidate.externalId,
        branch: candidate.branch,
        status: candidate.status,
        overlappingPaths: overlap.slice(0, MAX_COLLISION_PATHS),
        overlapCount: overlap.length,
      });
    }
    return collisions.sort(
      (left, right) =>
        right.overlapCount - left.overlapCount || left.storyId.localeCompare(right.storyId),
    );
  }

  /**
   * Unions the changed paths of every completed, successfully captured turn per story. Only the
   * path column is pulled out of the JSON so the control plane never loads full evidence rows.
   */
  private async changedPaths(orgId: string, projectId: string, storyIds: string[]) {
    const rows = await this.db
      .select({
        storyId: turnGitEvidence.storyId,
        paths: sql<unknown>`jsonb_path_query_array(${turnGitEvidence.changedFiles}, '$[*].path')`,
      })
      .from(turnGitEvidence)
      .where(
        and(
          eq(turnGitEvidence.orgId, orgId),
          eq(turnGitEvidence.projectId, projectId),
          inArray(turnGitEvidence.storyId, storyIds),
          isNotNull(turnGitEvidence.completedAt),
          isNull(turnGitEvidence.captureError),
        ),
      );
    const byStory = new Map<string, Set<string>>();
    for (const row of rows) {
      const paths = byStory.get(row.storyId) ?? new Set<string>();
      if (Array.isArray(row.paths)) {
        for (const path of row.paths) if (typeof path === "string" && path) paths.add(path);
      }
      byStory.set(row.storyId, paths);
    }
    return byStory;
  }
}

/** Sorted intersection of two path sets. */
export function overlappingPaths(mine: Iterable<string>, theirs: Iterable<string>): string[] {
  const other = theirs instanceof Set ? theirs : new Set(theirs);
  const overlap = new Set<string>();
  for (const path of mine) if (other.has(path)) overlap.add(path);
  return [...overlap].sort((left, right) => left.localeCompare(right));
}

/** Prompt section that tells the agent which files other open branches are also changing. */
export function collisionPromptBlock(collisions: StoryCollision[]): string {
  if (collisions.length === 0) return "";
  const listed = collisions.slice(0, MAX_COLLISION_STORIES);
  const lines = listed.map((collision) => {
    const shown = collision.overlappingPaths.slice(0, MAX_COLLISION_PATHS);
    const remainder = collision.overlapCount - shown.length;
    const suffix = remainder > 0 ? ` (+${remainder} more)` : "";
    return `- "${collision.title}" (${collision.provider}:${collision.externalId}, branch ${collision.branch}): ${shown.join(", ")}${suffix}`;
  });
  const omitted = collisions.length - listed.length;
  if (omitted > 0) lines.push(`- ${omitted} more stories overlap with this one.`);
  return [
    "# Other active stories touch files you changed",
    "The following stories in this project have open branches that changed files this story also changed. Their pull requests will conflict with yours if both keep editing the same regions. Keep your edits to these paths minimal and focused, do not reformat or reorganize them, and mention the overlap in your commit or pull request description when it matters. Do not modify the other branches.",
    ...lines,
  ].join("\n");
}
