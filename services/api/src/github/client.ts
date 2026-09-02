import { App } from "@octokit/app";
import { Octokit as RestOctokit } from "@octokit/rest";
import type { AppConfig } from "../types.js";

export type Octokit = {
  request?: (
    route: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: Record<string, unknown> }>;
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
        data: { name: string; owner?: { login?: string }; default_branch?: string };
      }>;
      createInOrg?: (args: Record<string, unknown>) => Promise<{
        data: { name: string; owner?: { login?: string }; default_branch?: string };
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

export type GithubClientFactory = (installationId: number) => Promise<Octokit>;
export type GithubMaintainerTokenFactory = (input: { installationId: number }) => Promise<{
  token: string;
  expiresAt: string;
}>;

export function createGithubClientFactory(config: AppConfig): GithubClientFactory {
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    throw new Error("GitHub App credentials are not configured");
  }
  const app = new App({
    appId: config.githubAppId,
    privateKey: config.githubAppPrivateKey,
    Octokit: RestOctokit,
  });
  return async (installationId: number) =>
    (await app.getInstallationOctokit(installationId)) as unknown as Octokit;
}

/**
 * Mints the installation's complete configured capability for every repository
 * selected in that installation. No repository or permission override is sent.
 */
export function createGithubMaintainerTokenFactory(
  config: AppConfig,
): GithubMaintainerTokenFactory {
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    throw new Error("GitHub App credentials are not configured");
  }
  const app = new App({ appId: config.githubAppId, privateKey: config.githubAppPrivateKey });
  return async ({ installationId }) => {
    const response = await app.octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      { installation_id: installationId },
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
    return { token, expiresAt };
  };
}

export type RepoRef = {
  owner: string;
  repo: string;
  defaultBranch: string;
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

  async getDefaultBranchSha(): Promise<string> {
    const response = await this.octokit.rest.repos.getBranch({
      owner: this.repo.owner,
      repo: this.repo.repo,
      branch: this.repo.defaultBranch,
    });
    return response.data.commit.sha;
  }

  async getCommit(sha: string): Promise<{ sha: string; treeSha: string }> {
    const response = await this.octokit.rest.git.getCommit({
      owner: this.repo.owner,
      repo: this.repo.repo,
      commit_sha: sha,
    });
    return { sha: response.data.sha, treeSha: response.data.tree.sha };
  }

  async getContent(path: string, ref?: string): Promise<unknown> {
    const response = await this.octokit.rest.repos.getContent({
      owner: this.repo.owner,
      repo: this.repo.repo,
      path,
      ref,
    });
    return response.data;
  }

  async createBlob(content: string): Promise<string> {
    const response = await this.octokit.rest.git.createBlob({
      owner: this.repo.owner,
      repo: this.repo.repo,
      content,
      encoding: "utf-8",
    });
    return response.data.sha;
  }

  async createTree(baseTree: string, tree: TreeItem[]): Promise<string> {
    const response = await this.octokit.rest.git.createTree({
      owner: this.repo.owner,
      repo: this.repo.repo,
      base_tree: baseTree,
      tree,
    });
    return response.data.sha;
  }

  async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
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
    await this.octokit.rest.git.createRef({
      owner: this.repo.owner,
      repo: this.repo.repo,
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  async updateBranch(branch: string, sha: string, force = false): Promise<void> {
    this.refuseDefaultBranch(branch);
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
  }
}
