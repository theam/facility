import { type FacilityDb, githubInstallations, projectRepositories } from "@facility/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { GithubMaintainerTokenFactory } from "./client.js";

export type WorkspaceRepository = {
  owner: string;
  name: string;
  defaultBranch: string;
  role: "primary" | "related";
};

export type GithubWorkspaceCredentials = {
  repositories: WorkspaceRepository[];
  environment: Record<string, string>;
  expiresAt: Date;
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

  async issue(orgId: string, projectId: string): Promise<GithubWorkspaceCredentials> {
    const repositories = await this.db
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
    const installations = await this.db
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

    const tokens = new Map(
      await Promise.all(
        installations.map(async (installation) => {
          const names = repositories
            .filter((repository) => repository.installationId === installation.id)
            .map((repository) => repository.name);
          return [
            installation.id,
            await this.tokenFactory({
              installationId: installation.installationId,
              repositories: names,
            }),
          ] as const;
        }),
      ),
    );
    const credentialMap = Object.fromEntries(
      repositories.map((repository) => {
        const token = repository.installationId
          ? tokens.get(repository.installationId)?.token
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
    const expiresAt = new Date(
      Math.min(
        ...[...tokens.values()].map((credential) => new Date(credential.expiresAt).getTime()),
      ),
    );
    if (!primaryToken || !Number.isFinite(expiresAt.getTime())) {
      throw new GithubWorkspaceCredentialError(
        "github_token_invalid",
        "GitHub returned an invalid workspace credential",
      );
    }
    return {
      repositories: repositories.map((repository) => ({
        owner: repository.owner,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        role: repository.role as "primary" | "related",
      })),
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
