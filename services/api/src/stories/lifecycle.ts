import { createHash } from "node:crypto";
import type { FacilityDb } from "@facility/db";
import { stories, workspaces } from "@facility/db";
import { and, desc, eq } from "drizzle-orm";
import { ApiError } from "../errors.js";
import type { PreviewSite } from "../workspaces/preview-sites.js";
import type { BacklogItem, ProjectBacklogService } from "./backlog.js";

export const contentRevision = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Facts only: consumers decide whether/when to register external integrations. */
export function storyLifecycleSnapshot(input: {
  orgId: string;
  projectId: string;
  storyId: string;
  story: {
    status: string;
    completedAt: Date | null;
    archivedAt: Date | null;
    deletedAt: Date | null;
  };
  item: BacklogItem;
  workspace: { id: string; state: string } | null;
  sites: PreviewSite[];
  now: Date;
}) {
  const body = {
    schemaVersion: 1,
    orgId: input.orgId,
    projectId: input.projectId,
    storyId: input.storyId,
    story: input.story,
    phase: input.item.phase,
    reason: input.item.reason,
    activity: input.item.activity.state,
    provider: input.item.story?.provider ?? null,
    repositoryId: input.item.story?.repositoryId ?? null,
    externalId: input.item.story?.externalId ?? null,
    issue: input.item.issue
      ? {
          repositoryId: input.item.issue.repositoryId,
          number: input.item.issue.number,
          state: input.item.issue.state,
          stale: input.item.issue.stale,
        }
      : null,
    pullRequest: input.item.pullRequest
      ? {
          repositoryId: input.item.pullRequest.repositoryId,
          number: input.item.pullRequest.number,
          state: input.item.pullRequest.state,
          stale: input.item.pullRequest.stale,
        }
      : null,
    workspace: input.workspace
      ? {
          ...input.workspace,
          sites: input.sites
            .filter(
              (site) =>
                site.orgId === input.orgId &&
                site.projectId === input.projectId &&
                site.workspaceId === input.workspace?.id,
            )
            .map((site) => ({ id: site.id, service: site.service, origin: site.origin }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        }
      : null,
  };
  // Observation timestamps, integration JSON and credentials never drive events.
  return { ...body, revision: contentRevision(body), observedAt: input.now.toISOString() };
}

export async function readStoryLifecycle(
  db: FacilityDb,
  backlog: ProjectBacklogService,
  sites: PreviewSite[],
  scope: { orgId: string; projectId: string; storyId: string },
  now = new Date(),
) {
  const { orgId, projectId, storyId } = scope;
  const [story] = await db
    .select({
      status: stories.status,
      completedAt: stories.completedAt,
      archivedAt: stories.archivedAt,
      deletedAt: stories.deletedAt,
    })
    .from(stories)
    .where(and(eq(stories.orgId, orgId), eq(stories.projectId, projectId), eq(stories.id, storyId)))
    .limit(1);
  if (!story) throw new ApiError(404, "not_found", "Story not found");
  const item = await backlog.getStory(orgId, projectId, storyId, now);
  if (!item) throw new ApiError(409, "lifecycle_unavailable", "Story lifecycle is unavailable");
  const [workspace] = await db
    .select({ id: workspaces.id, state: workspaces.state })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.orgId, orgId),
        eq(workspaces.projectId, projectId),
        eq(workspaces.storyId, storyId),
      ),
    )
    .orderBy(desc(workspaces.createdAt))
    .limit(1);
  return storyLifecycleSnapshot({
    ...scope,
    story,
    item,
    workspace: workspace ?? null,
    sites,
    now,
  });
}
