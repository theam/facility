import { type FacilityDb, projectRepositories, storyDeliveryPullRequests } from "@facility/db";
import { and, eq } from "drizzle-orm";
import type { BacklogItem } from "./backlog.js";

type Repository = { id: string; name: string };
export type BacklogRepositories = Map<string, Repository[]>;

/** A row counts once per repository, even when source and several PRs share it. */
export function repositoryReferences(
  item: Pick<BacklogItem, "issue" | "pullRequest" | "story">,
  directory: Map<string, Repository>,
  deliveryIds: string[],
): Repository[] {
  const ids = new Set([
    item.issue?.repositoryId,
    item.pullRequest?.repositoryId,
    item.story?.repositoryId,
    ...deliveryIds,
  ]);
  return [...ids].flatMap((id) => {
    const repository = id ? directory.get(id) : undefined;
    return repository ? [repository] : [];
  });
}

/** One scoped vocabulary serves filtering and facets in the backlog's snapshot. */
export async function readBacklogRepositories(
  db: FacilityDb,
  orgId: string,
  projectId: string,
  items: BacklogItem[],
): Promise<BacklogRepositories> {
  if (!items.length) return new Map();
  const [repositories, links] = await Promise.all([
    db
      .select({
        id: projectRepositories.id,
        owner: projectRepositories.owner,
        name: projectRepositories.name,
      })
      .from(projectRepositories)
      .where(
        and(eq(projectRepositories.orgId, orgId), eq(projectRepositories.projectId, projectId)),
      ),
    db
      .select({
        storyId: storyDeliveryPullRequests.storyId,
        repositoryId: storyDeliveryPullRequests.repositoryId,
      })
      .from(storyDeliveryPullRequests)
      .where(
        and(
          eq(storyDeliveryPullRequests.orgId, orgId),
          eq(storyDeliveryPullRequests.projectId, projectId),
        ),
      ),
  ]);
  const directory = new Map(
    repositories.map((repository) => [
      repository.id,
      {
        id: repository.id,
        name: `${repository.owner}/${repository.name}`,
      },
    ]),
  );
  const byStory = new Map<string, string[]>();
  for (const link of links) {
    const ids = byStory.get(link.storyId) ?? [];
    ids.push(link.repositoryId);
    byStory.set(link.storyId, ids);
  }
  return new Map(
    items.map((item) => [
      item.key,
      repositoryReferences(item, directory, item.story ? (byStory.get(item.story.id) ?? []) : []),
    ]),
  );
}
