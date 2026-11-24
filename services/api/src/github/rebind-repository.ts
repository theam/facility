import { type FacilityDb, githubInstallations, projectRepositories, turns } from "@facility/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ApiError, notFound } from "../errors.js";
import type { GithubClientFactory } from "./client.js";

export function assertSameRepository(
  previous: number | null | undefined,
  next: number | undefined,
) {
  if (
    !Number.isSafeInteger(previous) ||
    !Number.isSafeInteger(next) ||
    (next ?? 0) <= 0 ||
    previous !== next
  ) {
    throw new ApiError(
      409,
      "repository_identity_mismatch",
      "GitHub could not prove this is the same repository. Its history and connection were not changed.",
    );
  }
}

/** Rebind a transferred repository in place, preserving story and workspace foreign keys. */
export async function rebindRepository(
  db: FacilityDb,
  factory: GithubClientFactory,
  scope: { orgId: string; projectId: string; repoId: string },
  input: { installationId: number; owner: string; name: string },
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${scope.orgId}:${scope.projectId}`}))`,
    );
    const where = and(
      eq(projectRepositories.orgId, scope.orgId),
      eq(projectRepositories.projectId, scope.projectId),
      eq(projectRepositories.id, scope.repoId),
    );
    const repository = (await tx.select().from(projectRepositories).where(where).for("update"))[0];
    if (!repository) throw notFound("Repository not found");
    const active = await tx
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(
          eq(turns.orgId, scope.orgId),
          eq(turns.projectId, scope.projectId),
          inArray(turns.state, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (active.length)
      throw new ApiError(
        409,
        "project_busy",
        "Wait for queued and running turns before changing the repository connection",
      );
    const installation = (
      await tx
        .select()
        .from(githubInstallations)
        .where(
          and(
            eq(githubInstallations.orgId, scope.orgId),
            eq(githubInstallations.installationId, input.installationId),
          ),
        )
        .limit(1)
    )[0];
    if (!installation || installation.suspendedAt) throw notFound("Active installation not found");
    const client = await factory(installation.installationId);
    if (!client.rest.repos.get)
      throw new ApiError(
        502,
        "github_lookup_unavailable",
        "GitHub repository lookup is unavailable",
      );
    let target: Awaited<ReturnType<NonNullable<typeof client.rest.repos.get>>>["data"];
    let previous = repository.githubRepositoryId;
    try {
      target = (await client.rest.repos.get({ owner: input.owner, repo: input.name })).data;
      // GitHub follows repository-transfer redirects. Legacy rows have no immutable ID yet.
      if (!previous)
        previous =
          (await client.rest.repos.get({ owner: repository.owner, repo: repository.name })).data
            .id ?? null;
    } catch {
      throw new ApiError(
        409,
        "repository_identity_unavailable",
        "GitHub could not verify the repository transfer with this installation",
      );
    }
    assertSameRepository(previous, target.id);
    if (
      !target.owner?.login ||
      !target.name ||
      target.owner.login.toLowerCase() !== installation.accountLogin.toLowerCase()
    )
      throw new ApiError(
        409,
        "repository_owner_mismatch",
        "Repository is outside this installation",
      );
    const updated = (
      await tx
        .update(projectRepositories)
        .set({
          installationId: installation.id,
          githubRepositoryId: target.id,
          owner: target.owner.login,
          name: target.name,
          defaultBranch: target.default_branch ?? repository.defaultBranch,
          updatedAt: new Date(),
        })
        .where(where)
        .returning()
    )[0];
    if (!updated) throw notFound("Repository not found");
    return updated;
  });
}
