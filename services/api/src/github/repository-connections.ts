import {
  type FacilityDb,
  githubBranches,
  githubChecks,
  githubCiEvents,
  githubIssues,
  githubPullRequestReviews,
  githubPullRequests,
  githubWebhookEvents,
  projectRepositories,
  projects,
  stories,
  workspaces,
} from "@facility/db";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { ApiError, notFound } from "../errors.js";

export function repositoryRemovalBlocker(hasStories: boolean, hasRetainedWorkspaces: boolean) {
  if (hasStories) {
    return "This repository has retained Facility stories. Disconnecting it requires an explicit history migration; no stories or synchronized data were removed.";
  }
  if (hasRetainedWorkspaces) {
    return "This project has retained workspaces that may contain this repository. Resolve their lifecycle explicitly before disconnecting; no workspaces or synchronized data were removed.";
  }
  return null;
}

/** Unlink configuration and disposable mirrors, never durable work or GitHub itself. */
export async function removeRepositoryConnection(
  db: FacilityDb,
  orgId: string,
  projectId: string,
  repoId: string,
) {
  try {
    await db.transaction(async (transaction) => {
      const tx = transaction as unknown as FacilityDb;
      // The connect route takes this same lock. Primary replacement must be one topology change.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${orgId}:${projectId}`}))`);
      const project = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
        .for("update");
      if (!project.length) throw notFound("Project not found");
      const scope = and(
        eq(projectRepositories.orgId, orgId),
        eq(projectRepositories.projectId, projectId),
        eq(projectRepositories.id, repoId),
      );
      const repository = (
        await tx.select().from(projectRepositories).where(scope).for("update")
      )[0];
      if (!repository) return;

      // Row locks also fence new FK references while existing dependencies are checked.
      const retainedStories = await tx
        .select({ id: stories.id })
        .from(stories)
        .where(
          and(
            eq(stories.orgId, orgId),
            eq(stories.projectId, projectId),
            eq(stories.repositoryId, repoId),
          ),
        )
        .limit(1);
      const retainedWorkspaces = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.orgId, orgId),
            eq(workspaces.projectId, projectId),
            ne(workspaces.state, "destroyed"),
          ),
        )
        .limit(1);
      const blocker = repositoryRemovalBlocker(
        retainedStories.length > 0,
        retainedWorkspaces.length > 0,
      );
      if (blocker) throw new ApiError(409, "repository_in_use", blocker);

      // These are derived GitHub read models, not Facility stories, turns or workspace evidence.
      for (const table of [
        githubIssues,
        githubPullRequests,
        githubBranches,
        githubChecks,
        githubPullRequestReviews,
        githubCiEvents,
      ]) {
        await tx
          .delete(table)
          .where(
            and(
              eq(table.orgId, orgId),
              eq(table.projectId, projectId),
              eq(table.repositoryId, repoId),
            ),
          );
      }
      // Keep the signed-delivery audit payload and project attribution after unlinking.
      await tx
        .update(githubWebhookEvents)
        .set({
          repositoryId: null,
          processedAt: sql`coalesce(${githubWebhookEvents.processedAt}, now())`,
          error: sql`case when ${githubWebhookEvents.processedAt} is null then 'repository_disconnected' else ${githubWebhookEvents.error} end`,
        })
        .where(
          and(
            eq(githubWebhookEvents.orgId, orgId),
            eq(githubWebhookEvents.projectId, projectId),
            eq(githubWebhookEvents.repositoryId, repoId),
          ),
        );
      await tx.delete(projectRepositories).where(scope);
      if (repository.role === "primary") {
        const replacement = (
          await tx
            .select({ id: projectRepositories.id })
            .from(projectRepositories)
            .where(
              and(
                eq(projectRepositories.orgId, orgId),
                eq(projectRepositories.projectId, projectId),
              ),
            )
            .orderBy(asc(projectRepositories.createdAt), asc(projectRepositories.id))
            .limit(1)
        )[0];
        if (replacement) {
          await tx
            .update(projectRepositories)
            .set({ role: "primary", updatedAt: new Date() })
            .where(
              and(
                eq(projectRepositories.orgId, orgId),
                eq(projectRepositories.projectId, projectId),
                eq(projectRepositories.id, replacement.id),
              ),
            );
        }
      }
    });
  } catch (error) {
    const failure = error as { code?: string; cause?: { code?: string } };
    if ((failure.code ?? failure.cause?.code) === "23503") {
      // Future/extension-owned dependencies must roll back the entire cleanup, not be cascaded.
      throw new ApiError(
        409,
        "repository_in_use",
        "This repository still has retained references. No data was removed; an explicit history migration is required before disconnecting.",
      );
    }
    throw error;
  }
}
