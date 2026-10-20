import { type FacilityDb, githubInstallations, projectRepositories } from "@facility/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { GITHUB_READ_ONLY_PERMISSIONS, type GithubMaintainerTokenFactory } from "./client.js";
import { repositoryDevelopmentBranch } from "./development-branch.js";
import type { GithubGitIdentity } from "./git-identity.js";

export type WorkspaceRepository = {
  githubRepositoryId?: number | null;
  installationNumber?: number;
  owner: string;
  name: string;
  defaultBranch: string;
  developmentBranch?: string;
  role: "primary" | "related";
  gitIdentity?: GithubGitIdentity;
};

export type GithubWorkspaceCredentials = {
  repositories: WorkspaceRepository[];
  environment: Record<string, string>;
  expiresAt: Date;
  gitIdentity: GithubGitIdentity;
};

export class GithubWorkspaceCredentialError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GithubWorkspaceCredentialError";
  }
}

export class GithubWorkspaceCredentialBroker {
  constructor(
    private readonly db: FacilityDb,
    private readonly tokenFactory: GithubMaintainerTokenFactory,
  ) {}

  /** `readOnly` narrows every token to GITHUB_READ_ONLY_PERMISSIONS (the automatic Reviewer). */
  async issue(
    orgId: string,
    projectId: string,
    options: { readOnly?: boolean } = {},
    db = this.db,
  ): Promise<GithubWorkspaceCredentials> {
    const repositories = await db
      .select()
      .from(projectRepositories)
      .where(
        and(eq(projectRepositories.orgId, orgId), eq(projectRepositories.projectId, projectId)),
      )
      .orderBy(
        asc(projectRepositories.role),
        asc(projectRepositories.owner),
        asc(projectRepositories.name),
      );
    if (
      repositories.length === 0 ||
      !repositories.some((repository) => repository.role === "primary")
    ) {
      throw new GithubWorkspaceCredentialError(
        "project_repositories_missing",
        "project must have one primary repository",
      );
    }
    const installationIds = [
      ...new Set(repositories.map((repository) => repository.installationId)),
    ];
    if (installationIds.some((id) => !id)) {
      throw new GithubWorkspaceCredentialError(
        "github_installation_missing",
        "every project repository must have a GitHub installation",
      );
    }
    const installations = await db
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.orgId, orgId),
          inArray(githubInstallations.id, installationIds as string[]),
        ),
      );
    if (
      installations.length !== installationIds.length ||
      installations.some((installation) => installation.suspendedAt)
    ) {
      throw new GithubWorkspaceCredentialError(
        "github_installation_unavailable",
        "a project GitHub installation is missing or suspended",
      );
    }

    // Do not combine IDs and names in one token: legacy rows lack historical identity,
    // and a name-scoped token must never grant access to a pinned repository's replacement.
    const scopeKey = (repository: (typeof repositories)[number]) =>
      `${repository.installationId}:${repository.githubRepositoryId == null ? "legacy" : "pinned"}`;
    const tokens = new Map(
      await Promise.all(
        installations.flatMap((installation) => {
          const linked = repositories.filter(
            (repository) => repository.installationId === installation.id,
          );
          return [false, true].flatMap((pinned) => {
            const group = linked.filter(
              (repository) => (repository.githubRepositoryId != null) === pinned,
            );
            const first = group[0];
            if (!first) return [];
            return [
              (async () =>
                [
                  scopeKey(first),
                  await this.tokenFactory({
                    installationId: installation.installationId,
                    ...(pinned
                      ? {
                          repositoryIds: group.flatMap((repository) =>
                            repository.githubRepositoryId == null
                              ? []
                              : [repository.githubRepositoryId],
                          ),
                        }
                      : { repositories: group.map((repository) => repository.name) }),
                    ...(options.readOnly
                      ? { permissions: { ...GITHUB_READ_ONLY_PERMISSIONS } }
                      : {}),
                  }),
                ] as const)(),
            ];
          });
        }),
      ),
    );
    const credentialMap = Object.fromEntries(
      repositories.map((repository) => {
        const token = repository.installationId
          ? tokens.get(scopeKey(repository))?.token
          : undefined;
        if (!token) {
          throw new GithubWorkspaceCredentialError(
            "github_token_invalid",
            "GitHub did not return a token for every configured repository",
          );
        }
        return [`${repository.owner}/${repository.name}`.toLowerCase(), token];
      }),
    );
    const primary = repositories.find((repository) => repository.role === "primary");
    if (!primary) {
      throw new GithubWorkspaceCredentialError(
        "project_repositories_missing",
        "project must have one primary repository",
      );
    }
    const primaryToken = credentialMap[`${primary.owner}/${primary.name}`.toLowerCase()];
    const primaryCredential = primary.installationId ? tokens.get(scopeKey(primary)) : undefined;
    const expiresAt = new Date(
      Math.min(
        ...[...tokens.values()].map((credential) => new Date(credential.expiresAt).getTime()),
      ),
    );
    if (!primaryToken || !primaryCredential || !Number.isFinite(expiresAt.getTime())) {
      throw new GithubWorkspaceCredentialError(
        "github_token_invalid",
        "GitHub returned an invalid workspace credential",
      );
    }
    return {
      gitIdentity: primaryCredential.gitIdentity,
      repositories: await Promise.all(
        repositories.map(async (repository) => ({
          githubRepositoryId: repository.githubRepositoryId,
          installationNumber: installations.find(
            (installation) => installation.id === repository.installationId,
          )?.installationId,
          owner: repository.owner,
          name: repository.name,
          defaultBranch: repository.defaultBranch,
          developmentBranch: await repositoryDevelopmentBranch(db, repository),
          role: repository.role as "primary" | "related",
          gitIdentity: tokens.get(scopeKey(repository))?.gitIdentity,
        })),
      ),
      environment: {
        GH_TOKEN: primaryToken,
        GITHUB_TOKEN: primaryToken,
        FACILITY_GITHUB_CREDENTIALS: JSON.stringify(credentialMap),
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "!facility-git-credential",
        GIT_CONFIG_KEY_1: "credential.useHttpPath",
        GIT_CONFIG_VALUE_1: "true",
      },
      expiresAt,
    };
  }
}
