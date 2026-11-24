import {
  type FacilityDb,
  githubConnections,
  githubInstallations,
  projectRepositories,
  turns,
} from "@facility/db";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
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

/** Validate external evidence without holding a pool connection, then commit under the project fence. */
export async function rebindRepository(
  db: FacilityDb,
  factory: GithubClientFactory,
  scope: { orgId: string; projectId: string; repoId: string },
  input: { installationId: number; owner: string; name: string },
) {
  const where = and(
    eq(projectRepositories.orgId, scope.orgId),
    eq(projectRepositories.projectId, scope.projectId),
    eq(projectRepositories.id, scope.repoId),
  );
  const [previous] = await db.select().from(projectRepositories).where(where).limit(1);
  if (!previous) throw notFound("Repository not found");
  if (!previous.githubRepositoryId)
    throw new ApiError(
      409,
      "repository_identity_required",
      "This legacy connection has no recorded GitHub repository ID. An operator must verify its historical identity before changing its connection.",
    );
  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.orgId, scope.orgId),
        eq(githubInstallations.installationId, input.installationId),
        isNull(githubInstallations.suspendedAt),
      ),
    )
    .limit(1);
  if (!installation) throw notFound("Active installation not found");
  const client = await factory(installation.installationId);
  if (!client.rest.repos.get || !client.repositoryInstallationId)
    throw new ApiError(
      502,
      "github_lookup_unavailable",
      "GitHub repository installation lookup is unavailable",
    );
  let target: Awaited<ReturnType<NonNullable<typeof client.rest.repos.get>>>["data"];
  let targetInstallation: number;
  try {
    target = (await client.rest.repos.get({ owner: input.owner, repo: input.name })).data;
    targetInstallation = await client.repositoryInstallationId(
      target.owner?.login ?? input.owner,
      target.name,
    );
  } catch {
    throw new ApiError(
      409,
      "repository_identity_unavailable",
      "GitHub could not verify this repository in the selected installation",
    );
  }
  assertSameRepository(previous.githubRepositoryId, target.id);
  if (
    targetInstallation !== installation.installationId ||
    !target.owner?.login ||
    !target.name ||
    target.owner.login.toLowerCase() !== installation.accountLogin.toLowerCase()
  )
    throw new ApiError(409, "repository_owner_mismatch", "Repository is outside this installation");

  const targetOwner = target.owner.login;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${scope.orgId}:${scope.projectId}`}))`,
    );
    const [current] = await tx.select().from(projectRepositories).where(where).for("update");
    if (!current) throw notFound("Repository not found");
    if (
      current.installationId !== previous.installationId ||
      current.githubRepositoryId !== previous.githubRepositoryId ||
      current.owner !== previous.owner ||
      current.name !== previous.name
    )
      throw new ApiError(
        409,
        "repository_connection_changed",
        "Repository connection changed. Reload and retry.",
      );
    const [activeInstallation] = await tx
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .leftJoin(
        githubConnections,
        and(
          eq(githubConnections.id, githubInstallations.connectionId),
          eq(githubConnections.orgId, githubInstallations.orgId),
        ),
      )
      .where(
        and(
          eq(githubInstallations.id, installation.id),
          eq(githubInstallations.orgId, scope.orgId),
          isNull(githubInstallations.suspendedAt),
          or(
            isNull(githubInstallations.connectionId),
            and(isNotNull(githubConnections.id), isNull(githubConnections.disabledAt)),
          ),
        ),
      )
      .limit(1);
    if (!activeInstallation) throw notFound("Active installation not found");
    const [active] = await tx
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
    if (active)
      throw new ApiError(
        409,
        "project_busy",
        "Wait for queued and running turns before changing the repository connection",
      );
    const [updated] = await tx
      .update(projectRepositories)
      .set({
        installationId: installation.id,
        owner: targetOwner,
        name: target.name,
        defaultBranch: target.default_branch ?? current.defaultBranch,
        updatedAt: new Date(),
      })
      .where(where)
      .returning();
    if (!updated) throw notFound("Repository not found");
    return updated;
  });
}
