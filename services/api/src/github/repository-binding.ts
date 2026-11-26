import {
  type FacilityDb,
  githubConnections,
  githubInstallations,
  projectRepositories,
} from "@facility/db";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";

/** Internal receipt provenance, never accepted from an API request body. */
export type GithubRepositoryBinding = {
  repositoryId: string;
  installationId: string;
  githubRepositoryId: number | null;
};
export class GithubRepositoryBindingChanged extends Error {
  constructor() {
    super("GitHub repository connection changed while processing this delivery");
  }
}
/** Call under the project workflow fence or repository row lock before committing payload-derived mutations. */
export async function assertGithubRepositoryBinding(
  db: FacilityDb,
  scope: { orgId: string; projectId: string },
  binding?: GithubRepositoryBinding,
) {
  if (!binding) return;
  const [row] = await db
    .select({ id: projectRepositories.id })
    .from(projectRepositories)
    .innerJoin(
      githubInstallations,
      and(
        eq(githubInstallations.id, projectRepositories.installationId),
        eq(githubInstallations.orgId, projectRepositories.orgId),
      ),
    )
    .leftJoin(
      githubConnections,
      and(
        eq(githubConnections.id, githubInstallations.connectionId),
        eq(githubConnections.orgId, githubInstallations.orgId),
      ),
    )
    .where(
      and(
        eq(projectRepositories.orgId, scope.orgId),
        eq(projectRepositories.projectId, scope.projectId),
        eq(projectRepositories.id, binding.repositoryId),
        eq(projectRepositories.installationId, binding.installationId),
        binding.githubRepositoryId == null
          ? isNull(projectRepositories.githubRepositoryId)
          : eq(projectRepositories.githubRepositoryId, binding.githubRepositoryId),
        isNull(githubInstallations.suspendedAt),
        or(
          isNull(githubInstallations.connectionId),
          and(isNotNull(githubConnections.id), isNull(githubConnections.disabledAt)),
        ),
      ),
    )
    .limit(1);
  if (!row) throw new GithubRepositoryBindingChanged();
}
export function githubPayloadMatchesRepository(
  expected: number | null,
  payload: Record<string, unknown>,
) {
  if (expected == null) return true;
  const repository = payload.repository;
  return (
    !!repository &&
    typeof repository === "object" &&
    "id" in repository &&
    repository.id === expected
  );
}
