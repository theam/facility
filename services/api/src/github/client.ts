import { App } from "@octokit/app";
import type { AppConfig } from "../types.js";

export type Octokit = {
  request?: (
    route: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: Record<string, unknown> }>;
  rest: {
    apps?: {
      createInstallationAccessToken: (args: Record<string, unknown>) => Promise<{
        data: { token: string; expires_at?: string; permissions?: Record<string, string> };
      }>;
    };
    git: {
      getRef: (args: Record<string, unknown>) => Promise<{ data: { object: { sha: string } } }>;
      getCommit: (
        args: Record<string, unknown>,
      ) => Promise<{ data: { tree: { sha: string }; sha: string } }>;
      createBlob: (args: Record<string, unknown>) => Promise<{ data: { sha: string } }>;
      createTree: (args: Record<string, unknown>) => Promise<{ data: { sha: string } }>;
      createCommit: (args: Record<string, unknown>) => Promise<{ data: { sha: string } }>;
      createRef: (args: Record<string, unknown>) => Promise<{ data: unknown }>;
      updateRef: (args: Record<string, unknown>) => Promise<{ data: unknown }>;
      getTree: (args: Record<string, unknown>) => Promise<{
        data: { tree: { path?: string; type?: string; sha?: string; mode?: string }[] };
      }>;
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
      getCollaboratorPermissionLevel: (
        args: Record<string, unknown>,
      ) => Promise<{ data: { permission: string } }>;
      listPullRequestsAssociatedWithCommit?: (
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown[] }>;
    };
    pulls: {
      create: (
        args: Record<string, unknown>,
      ) => Promise<{ data: { number: number; html_url: string } }>;
      update: (args: Record<string, unknown>) => Promise<{ data: unknown }>;
      listReviews?: (args: Record<string, unknown>) => Promise<{ data: unknown[] }>;
      listCommits?: (args: Record<string, unknown>) => Promise<{ data: unknown[] }>;
    };
    issues: {
      create: (
        args: Record<string, unknown>,
      ) => Promise<{ data: { number: number; html_url: string } }>;
      createComment: (
        args: Record<string, unknown>,
      ) => Promise<{ data: { id: number; html_url?: string } }>;
      listForRepo: (args: Record<string, unknown>) => Promise<{ data: unknown[] }>;
    };
    gitignore?: unknown;
  };
};

export type GithubClientFactory = (installationId: number) => Promise<Octokit>;
export type GithubInstallationTokenFactory = (input: {
  installationId: number;
  owner: string;
  repo: string;
  permissions?: Record<string, string>;
}) => Promise<string>;

export function createGithubClientFactory(config: AppConfig): GithubClientFactory {
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    throw new Error("GitHub App credentials are not configured");
  }
  const app = new App({
    appId: config.githubAppId,
    privateKey: config.githubAppPrivateKey,
  });
  return async (installationId: number) =>
    (await app.getInstallationOctokit(installationId)) as unknown as Octokit;
}

export function createGithubInstallationTokenFactory(
  config: AppConfig,
): GithubInstallationTokenFactory {
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    throw new Error("GitHub App credentials are not configured");
  }
  const app = new App({
    appId: config.githubAppId,
    privateKey: config.githubAppPrivateKey,
  });
  return async ({
    installationId,
    repo,
    permissions,
  }: {
    installationId: number;
    owner: string;
    repo: string;
    permissions?: Record<string, string>;
  }) => {
    const response = await app.octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: installationId,
        repositories: [repo],
        ...(permissions ? { permissions } : {}),
      },
    );
    return response.data.token;
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

  async getRef(branch: string): Promise<string> {
    const response = await this.octokit.rest.git.getRef({
      owner: this.repo.owner,
      repo: this.repo.repo,
      ref: `heads/${branch}`,
    });
    return response.data.object.sha;
  }

  async getCommit(sha: string): Promise<{ sha: string; treeSha: string }> {
    const response = await this.octokit.rest.git.getCommit({
      owner: this.repo.owner,
      repo: this.repo.repo,
      commit_sha: sha,
    });
    return { sha: response.data.sha, treeSha: response.data.tree.sha };
  }

  async getTree(treeSha: string): Promise<{ path: string; sha: string; mode?: string }[]> {
    const response = await this.octokit.rest.git.getTree({
      owner: this.repo.owner,
      repo: this.repo.repo,
      tree_sha: treeSha,
      recursive: "1",
    });
    return response.data.tree
      .filter((item) => item.type === "blob" && item.path && item.sha)
      .map((item) => ({ path: item.path ?? "", sha: item.sha ?? "", mode: item.mode }));
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
  }): Promise<{ number: number; url: string }> {
    this.refuseDefaultBranch(args.head);
    const response = await this.octokit.rest.pulls.create({
      owner: this.repo.owner,
      repo: this.repo.repo,
      title: args.title,
      body: args.body,
      head: args.head,
      base: args.base ?? this.repo.defaultBranch,
    });
    return { number: response.data.number, url: response.data.html_url };
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<{ number: number; url: string }> {
    const response = await this.octokit.rest.issues.create({
      owner: this.repo.owner,
      repo: this.repo.repo,
      title: input.title,
      body: input.body,
      labels: input.labels,
    });
    return { number: response.data.number, url: response.data.html_url };
  }

  async closePullRequest(number: number): Promise<void> {
    await this.octokit.rest.pulls.update({
      owner: this.repo.owner,
      repo: this.repo.repo,
      pull_number: number,
      state: "closed",
    });
  }

  async createIssueComment(
    issueNumber: number,
    body: string,
  ): Promise<{ id: number; url?: string }> {
    const response = await this.octokit.rest.issues.createComment({
      owner: this.repo.owner,
      repo: this.repo.repo,
      issue_number: issueNumber,
      body,
    });
    return { id: response.data.id, url: response.data.html_url };
  }

  async listIssues(params: {
    state: "all" | "open" | "closed";
    since?: string;
    page?: number;
    perPage?: number;
  }): Promise<unknown[]> {
    const response = await this.octokit.rest.issues.listForRepo({
      owner: this.repo.owner,
      repo: this.repo.repo,
      state: params.state,
      since: params.since,
      page: params.page,
      per_page: params.perPage,
    });
    return response.data;
  }

  async userCanWrite(username: string): Promise<boolean> {
    const response = await this.octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: this.repo.owner,
      repo: this.repo.repo,
      username,
    });
    return ["admin", "maintain", "write"].includes(response.data.permission);
  }

  private refuseDefaultBranch(ref: string) {
    const normalized = ref.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
    if (normalized === this.repo.defaultBranch) {
      throw new Error(`Refusing to write to default branch ${this.repo.defaultBranch}`);
    }
  }
}
