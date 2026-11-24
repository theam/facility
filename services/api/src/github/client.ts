import type { FacilityDb } from "@facility/db";
import { App } from "@octokit/app";
import { Octokit as RestOctokit } from "@octokit/rest";
import type { AppConfig } from "../types.js";
import { installationConfig } from "./connections.js";
import { createGithubGitIdentityLoader, type GithubGitIdentity } from "./git-identity.js";

export type Octokit = {
  readonly boundRepositoryId?: number;
  request?: (route: string, args?: Record<string, unknown>) => Promise<{ data: unknown }>;
  /** App-authenticated lookup: public repository visibility is not installation membership. */
  repositoryInstallationId?: (owner: string, repo: string) => Promise<number>;
  rest: {
    git: {
      getCommit: (
        args: Record<string, unknown>,
      ) => Promise<{ data: { tree: { sha: string }; sha: string } }>;
      createBlob: (args: Record<string, unknown>) => Promise<{ data: { sha: string } }>;
      createTree: (args: Record<string, unknown>) => Promise<{ data: { sha: string } }>;
      createCommit: (args: Record<string, unknown>) => Promise<{ data: { sha: string } }>;
      createRef: (args: Record<string, unknown>) => Promise<{ data: unknown }>;
      updateRef: (args: Record<string, unknown>) => Promise<{ data: unknown }>;
    };
    repos: {
      get?: (args: Record<string, unknown>) => Promise<{
        data: { id?: number; name: string; owner?: { login?: string }; default_branch?: string };
      }>;
      createInOrg?: (args: Record<string, unknown>) => Promise<{
        data: { id?: number; name: string; owner?: { login?: string }; default_branch?: string };
      }>;
      getContent: (args: Record<string, unknown>) => Promise<{ data: unknown }>;
      getBranch: (args: Record<string, unknown>) => Promise<{ data: { commit: { sha: string } } }>;
    };
    pulls: {
      create: (
        args: Record<string, unknown>,
      ) => Promise<{ data: { number: number; html_url: string } }>;
      list?: (args: Record<string, unknown>) => Promise<{
        data: Array<{
          number: number;
          html_url: string;
          head?: { ref?: string; sha?: string };
          base?: { ref?: string };
        }>;
      }>;
    };
  };
};

/** GitHub may allow public reads outside a token's scope. Bind every repository request as well. */
export function bindGithubRepositoryClient(client: Octokit, repositoryId: number): Octokit {
  const request = client.request;
  const get = client.rest.repos.get;
  if (!get) throw new Error("GitHub repository identity lookup unavailable");
  const metadata = async (args: Record<string, unknown>) => {
    if (typeof args.owner !== "string" || typeof args.repo !== "string")
      throw new Error("A bound GitHub client requires a repository");
    const result = await get({
      owner: args.owner,
      repo: args.repo,
      ...(args.request ? { request: args.request } : {}),
    });
    if (result.data.id !== repositoryId) throw new Error("GitHub repository identity changed");
    return result;
  };
  const guarded =
    <T>(operation: (args: Record<string, unknown>) => Promise<T>) =>
    async (args: Record<string, unknown>) => {
      await metadata(args);
      return operation(args);
    };
  return {
    boundRepositoryId: repositoryId,
    request: request
      ? async (route, args = {}) => {
          await metadata(args);
          return request(route, args);
        }
      : undefined,
    repositoryInstallationId: client.repositoryInstallationId,
    rest: {
      git: {
        getCommit: guarded(client.rest.git.getCommit),
        createBlob: guarded(client.rest.git.createBlob),
        createTree: guarded(client.rest.git.createTree),
        createCommit: guarded(client.rest.git.createCommit),
        createRef: guarded(client.rest.git.createRef),
        updateRef: guarded(client.rest.git.updateRef),
      },
      repos: {
        get: metadata,
        getBranch: guarded(client.rest.repos.getBranch),
        getContent: guarded(client.rest.repos.getContent),
        createInOrg: async () => {
          throw new Error("A bound GitHub client cannot create repositories");
        },
      },
      pulls: {
        create: guarded(client.rest.pulls.create),
        list: client.rest.pulls.list ? guarded(client.rest.pulls.list) : undefined,
      },
    },
  };
}

export type GithubClientFactory = (
  installationId: number,
  repositoryId?: number | null,
) => Promise<Octokit>;
/** Installation permissions a read-only turn receives: it can read code, pull requests,
 * issues and CI, and cannot push, merge, comment, review or change settings. */
export const GITHUB_READ_ONLY_PERMISSIONS = {
  contents: "read",
  pull_requests: "read",
  issues: "read",
  checks: "read",
  statuses: "read",
  actions: "read",
  metadata: "read",
} as const;

/** The requested read permissions the installation actually holds. GitHub refuses a token
 * that asks for a permission the App was not granted, so the rest are left out. */
export function grantedReadPermissions(
  requested: Record<string, "read" | "write">,
  granted: Record<string, string | undefined>,
) {
  return Object.fromEntries(
    Object.entries(requested).filter(
      ([name, level]) =>
        granted[name] === "write" ||
        granted[name] === "admin" ||
        (level === "read" && granted[name] === "read"),
    ),
  ) as Record<string, "read" | "write">;
}

export type GithubMaintainerTokenFactory = (input: {
  installationId: number;
  repositories?: string[];
  repositoryIds?: number[];
  /** Narrows the token below the installation's permissions; omitted, it keeps them all. */
  permissions?: Record<string, "read" | "write">;
}) => Promise<{
  token: string;
  expiresAt: string;
  gitIdentity: GithubGitIdentity;
}>;

export function createGithubClientFactory(config: AppConfig, db?: FacilityDb): GithubClientFactory {
  if (db)
    return async (installationId, repositoryId) =>
      createGithubClientFactory(await installationConfig(db, config, installationId))(
        installationId,
        repositoryId,
      );
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    throw new Error("GitHub App credentials are not configured");
  }
  const app = new App({
    appId: config.githubAppId,
    privateKey: config.githubAppPrivateKey,
    Octokit: RestOctokit,
  });
  return async (installationId: number, repositoryId?: number | null) => {
    // A repository-scoped token also rejects slug reuse between metadata validation and a write.
    const client = (repositoryId == null
      ? await app.getInstallationOctokit(installationId)
      : new RestOctokit({
          auth: (
            await app.octokit.request("POST /app/installations/{installation_id}/access_tokens", {
              installation_id: installationId,
              repository_ids: [repositoryId],
            })
          ).data.token,
        })) as unknown as Octokit;
    client.repositoryInstallationId = async (owner, repo) => {
      const result = await app.octokit.request("GET /repos/{owner}/{repo}/installation", {
        owner,
        repo,
      });
      return result.data.id;
    };
    return repositoryId == null ? client : bindGithubRepositoryClient(client, repositoryId);
  };
}

/**
 * Mints the installation's complete configured capability, narrowed only to
 * the repositories connected to this Facility project. Permissions remain
 * uniform and maintainer-grade for every agent.
 */
export function createGithubMaintainerTokenFactory(
  config: AppConfig,
  db?: FacilityDb,
): GithubMaintainerTokenFactory {
  if (db)
    return async (input) =>
      createGithubMaintainerTokenFactory(
        await installationConfig(db, config, input.installationId),
      )(input);
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    throw new Error("GitHub App credentials are not configured");
  }
  const app = new App({ appId: config.githubAppId, privateKey: config.githubAppPrivateKey });
  const identityClient = new RestOctokit();
  const identity = createGithubGitIdentityLoader({
    app: async () => (await app.octokit.request("GET /app")).data ?? {},
    user: async (username, token) =>
      (
        await identityClient.request("GET /users/{username}", {
          username,
          headers: { authorization: `Bearer ${token}` },
        })
      ).data,
  });
  return async ({ installationId, repositories, repositoryIds, permissions }) => {
    if ((!repositories?.length && !repositoryIds?.length) || (repositories && repositoryIds))
      throw new Error("Exactly one non-empty repository scope is required");
    const narrowed = permissions
      ? grantedReadPermissions(
          permissions,
          ((
            await app.octokit.request("GET /app/installations/{installation_id}", {
              installation_id: installationId,
            })
          ).data.permissions ?? {}) as Record<string, string | undefined>,
        )
      : undefined;
    if (narrowed && Object.keys(narrowed).length === 0)
      throw new Error("The GitHub installation grants none of the requested permissions");
    const response = await app.octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: installationId,
        ...(repositoryIds ? { repository_ids: repositoryIds } : { repositories }),
        ...(narrowed ? { permissions: narrowed } : {}),
      },
    );
    const token = response.data.token;
    const expiresAt = response.data.expires_at;
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      typeof expiresAt !== "string" ||
      !Number.isFinite(new Date(expiresAt).getTime())
    ) {
      throw new Error("GitHub installation token response omitted an exact expiry");
    }
    return { token, expiresAt, gitIdentity: await identity(token) };
  };
}

export type RepoRef = {
  githubRepositoryId?: number | null;
  owner: string;
  repo: string;
  defaultBranch: string;
  developmentBranch?: string;
};

export type TreeItem = {
  path: string;
  mode: "100644" | "100755" | "120000";
  type: "blob";
  sha?: string;
  content?: string;
};

export class FacilityGithubClient {
  constructor(
    private readonly octokit: Octokit,
    private readonly repo: RepoRef,
  ) {}

  /** Re-check before each operation: an old slug can be reused after a transfer. */
  private async assertRepositoryIdentity() {
    if (
      this.repo.githubRepositoryId == null ||
      this.octokit.boundRepositoryId === this.repo.githubRepositoryId
    )
      return; // Existing unpinned installations stay compatible.
    if (!this.octokit.rest.repos.get)
      throw new Error("GitHub repository identity lookup unavailable");
    const response = await this.octokit.rest.repos.get({
      owner: this.repo.owner,
      repo: this.repo.repo,
    });
    if (response.data.id !== this.repo.githubRepositoryId)
      throw new Error(
        "GitHub repository identity changed; update the project repository connection",
      );
  }

  async request(route: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.assertRepositoryIdentity();
    if (!this.octokit.request) throw new Error("GitHub REST requests are unavailable");
    const response = await this.octokit.request(route, {
      owner: this.repo.owner,
      repo: this.repo.repo,
      ...args,
    });
    return response.data;
  }

  async getDefaultBranchSha(): Promise<string> {
    return this.getBranchSha(this.repo.defaultBranch);
  }

  async getBranchSha(branch: string): Promise<string> {
    await this.assertRepositoryIdentity();
    const response = await this.octokit.rest.repos.getBranch({
      owner: this.repo.owner,
      repo: this.repo.repo,
      branch,
    });
    return response.data.commit.sha;
  }

  async getCommit(sha: string): Promise<{ sha: string; treeSha: string }> {
    await this.assertRepositoryIdentity();
    const response = await this.octokit.rest.git.getCommit({
      owner: this.repo.owner,
      repo: this.repo.repo,
      commit_sha: sha,
    });
    return { sha: response.data.sha, treeSha: response.data.tree.sha };
  }

  async getContent(path: string, ref?: string): Promise<unknown> {
    await this.assertRepositoryIdentity();
    const response = await this.octokit.rest.repos.getContent({
      owner: this.repo.owner,
      repo: this.repo.repo,
      path,
      ref,
    });
    return response.data;
  }

  async createBlob(content: string): Promise<string> {
    await this.assertRepositoryIdentity();
    const response = await this.octokit.rest.git.createBlob({
      owner: this.repo.owner,
      repo: this.repo.repo,
      content,
      encoding: "utf-8",
    });
    return response.data.sha;
  }

  async createTree(baseTree: string, tree: TreeItem[]): Promise<string> {
    await this.assertRepositoryIdentity();
    const response = await this.octokit.rest.git.createTree({
      owner: this.repo.owner,
      repo: this.repo.repo,
      base_tree: baseTree,
      tree,
    });
    return response.data.sha;
  }

  async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
    await this.assertRepositoryIdentity();
    const response = await this.octokit.rest.git.createCommit({
      owner: this.repo.owner,
      repo: this.repo.repo,
      message,
      tree,
      parents,
    });
    return response.data.sha;
  }

  async createBranch(branch: string, sha: string): Promise<void> {
    this.refuseDefaultBranch(branch);
    await this.assertRepositoryIdentity();
    await this.octokit.rest.git.createRef({
      owner: this.repo.owner,
      repo: this.repo.repo,
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  async updateBranch(branch: string, sha: string, force = false): Promise<void> {
    this.refuseDefaultBranch(branch);
    await this.assertRepositoryIdentity();
    await this.octokit.rest.git.updateRef({
      owner: this.repo.owner,
      repo: this.repo.repo,
      ref: `heads/${branch}`,
      sha,
      force,
    });
  }

  async createPullRequest(args: {
    title: string;
    body: string;
    head: string;
    base?: string;
    draft?: boolean;
  }): Promise<{ number: number; url: string }> {
    this.refuseDefaultBranch(args.head);
    await this.assertRepositoryIdentity();
    const response = await this.octokit.rest.pulls.create({
      owner: this.repo.owner,
      repo: this.repo.repo,
      title: args.title,
      body: args.body,
      head: args.head,
      base: args.base ?? this.repo.defaultBranch,
      draft: args.draft ?? false,
    });
    return { number: response.data.number, url: response.data.html_url };
  }

  async listOpenPullRequestsForHead(
    head: string,
    base: string,
  ): Promise<
    Array<{ number: number; url: string; headRef: string; headSha: string; baseRef: string }>
  > {
    if (!this.octokit.rest.pulls.list) {
      throw new Error("GitHub pull-request lookup is unavailable");
    }
    await this.assertRepositoryIdentity();
    const response = await this.octokit.rest.pulls.list({
      owner: this.repo.owner,
      repo: this.repo.repo,
      state: "open",
      head: `${this.repo.owner}:${head}`,
      base,
      per_page: 100,
    });
    return response.data.flatMap((pull) => {
      if (!pull.head?.ref || !pull.head.sha || !pull.base?.ref) return [];
      return [
        {
          number: pull.number,
          url: pull.html_url,
          headRef: pull.head.ref,
          headSha: pull.head.sha,
          baseRef: pull.base.ref,
        },
      ];
    });
  }

  private refuseDefaultBranch(ref: string) {
    const normalized = ref.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
    if (normalized === this.repo.defaultBranch) {
      throw new Error(`Refusing to write to default branch ${this.repo.defaultBranch}`);
    }
    if (normalized === this.repo.developmentBranch) {
      throw new Error(`Refusing to write to development branch ${this.repo.developmentBranch}`);
    }
  }
}
