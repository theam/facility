import { App } from "@octokit/app";
import { Octokit as RestOctokit } from "@octokit/rest";
import type { AppConfig } from "../types.js";
import type {
  AddressReviewPullRequest,
  AddressReviewSubmittedReview,
} from "./address-review-policy.js";
import type { CiDoctorCheck, CiDoctorPullRequest } from "./ci-doctor-policy.js";

const GITHUB_EVIDENCE_PAGE_SIZE = 100;
const GITHUB_EVIDENCE_MAX_ITEMS = 1_000;

export type Octokit = {
  graphql?: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
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
      list?: (args: Record<string, unknown>) => Promise<{
        data: Array<{
          number: number;
          html_url: string;
          head?: { ref?: string; sha?: string };
          base?: { ref?: string };
        }>;
      }>;
      update: (args: Record<string, unknown>) => Promise<{ data: unknown }>;
      listReviews?: (args: Record<string, unknown>) => Promise<{ data: unknown[] }>;
      listReviewComments?: (args: Record<string, unknown>) => Promise<{ data: unknown[] }>;
      getReview?: (args: Record<string, unknown>) => Promise<{ data: unknown }>;
      listCommentsForReview?: (args: Record<string, unknown>) => Promise<{ data: unknown[] }>;
      listCommits?: (args: Record<string, unknown>) => Promise<{ data: unknown[] }>;
      listFiles?: (args: Record<string, unknown>) => Promise<{
        data: Array<{ filename?: string }>;
      }>;
      get?: (args: Record<string, unknown>) => Promise<{
        data: {
          number: number;
          title: string;
          body?: string | null;
          state: string;
          draft?: boolean;
          created_at?: string | null;
          closed_at?: string | null;
          merged_at?: string | null;
          html_url: string;
          node_id?: string;
          head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
          base?: { ref?: string; repo?: { full_name?: string } | null };
          user?: { login?: string; type?: string } | null;
        };
      }>;
    };
    actions?: {
      listWorkflowRunsForRepo?: (args: Record<string, unknown>) => Promise<{
        data: {
          workflow_runs?: Array<{ id?: number; name?: string | null }>;
        };
      }>;
    };
    checks?: {
      listForRef?: (args: Record<string, unknown>) => Promise<{
        data: {
          check_runs?: Array<{
            id?: number;
            name?: string | null;
            status?: string | null;
            conclusion?: string | null;
            details_url?: string | null;
            output?: { title?: string | null; summary?: string | null } | null;
            app?: { slug?: string | null } | null;
          }>;
        };
      }>;
    };
    issues: {
      create: (
        args: Record<string, unknown>,
      ) => Promise<{ data: { number: number; html_url: string } }>;
      update?: (
        args: Record<string, unknown>,
      ) => Promise<{ data: { number: number; html_url: string } }>;
      createLabel?: (args: Record<string, unknown>) => Promise<{ data: unknown }>;
      createComment: (
        args: Record<string, unknown>,
      ) => Promise<{ data: { id: number; html_url?: string } }>;
      updateComment: (
        args: Record<string, unknown>,
      ) => Promise<{ data: { id: number; html_url?: string } }>;
      get?: (args: Record<string, unknown>) => Promise<{
        data: {
          number: number;
          title: string;
          body?: string | null;
          state?: string;
          html_url: string;
          user?: { login?: string } | null;
          labels?: Array<string | { name?: string }>;
        };
      }>;
      addAssignees?: (args: Record<string, unknown>) => Promise<{
        data: { assignees?: Array<{ login?: string | null }> };
      }>;
      listForRepo: (args: Record<string, unknown>) => Promise<{ data: unknown[] }>;
      listComments?: (args: Record<string, unknown>) => Promise<{
        data: Array<{
          id: number;
          user?: { login?: string; type?: string } | null;
          body?: string | null;
          created_at: string;
          html_url: string;
        }>;
      }>;
    };
    gitignore?: unknown;
  };
};

export type GithubClientFactory = (installationId: number) => Promise<Octokit>;
export type GithubAppMetadata = {
  permissions?: Record<string, string>;
  events?: string[];
};
export type GithubAppMetadataReader = () => Promise<GithubAppMetadata>;
export type GithubInstallationTokenFactory = (input: {
  installationId: number;
  owner: string;
  repo: string;
  permissions?: Record<string, string>;
}) => Promise<string>;

export class GithubIssueContextTooLargeError extends Error {
  constructor() {
    super("GitHub issue comments exceed the governed context limit");
    this.name = "GithubIssueContextTooLargeError";
  }
}

export function createGithubClientFactory(config: AppConfig): GithubClientFactory {
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    throw new Error("GitHub App credentials are not configured");
  }
  const app = new App({
    appId: config.githubAppId,
    privateKey: config.githubAppPrivateKey,
    // @octokit/app intentionally ships the lightweight core client. Facility's
    // GitHub adapter uses the typed REST endpoint helpers, so install that client
    // explicitly instead of relying on a type cast that is false at runtime.
    Octokit: RestOctokit,
  });
  return async (installationId: number) =>
    (await app.getInstallationOctokit(installationId)) as unknown as Octokit;
}

export function createGithubAppMetadataReader(config: AppConfig): GithubAppMetadataReader {
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    throw new Error("GitHub App credentials are not configured");
  }
  const app = new App({
    appId: config.githubAppId,
    privateKey: config.githubAppPrivateKey,
  });
  return async () => {
    const response = await app.octokit.request("GET /app");
    const data = response.data as {
      permissions?: Record<string, unknown>;
      events?: unknown[];
    };
    const permissions = data.permissions
      ? Object.fromEntries(
          Object.entries(data.permissions).flatMap(([key, value]) =>
            typeof value === "string" ? [[key, value]] : [],
          ),
        )
      : undefined;
    const events = Array.isArray(data.events)
      ? data.events.filter((event): event is string => typeof event === "string")
      : undefined;
    return { permissions, events };
  };
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

export type GithubPullRequestSnapshot = {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  url: string;
  body: string | null;
  closingIssues: number[];
  ciState: "pending" | "success" | "failure" | null;
  ciHeadSha: string | null;
  /** Present on focused refreshes; omitted by bulk reconciliation snapshots. */
  ciFailureNames?: string[];
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
};

export type GithubCiDoctorEvidence = {
  pullRequest: CiDoctorPullRequest;
  checks: CiDoctorCheck[];
  doctorRunIds: number[];
};

export type GithubPullRequestPage = {
  pullRequests: GithubPullRequestSnapshot[];
  endCursor: string | null;
  hasNextPage: boolean;
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

  supportsPullRequestSnapshots() {
    return Boolean(this.octokit.graphql || this.octokit.request);
  }

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

  async updatePullRequestBody(number: number, body: string): Promise<void> {
    await this.octokit.rest.pulls.update({
      owner: this.repo.owner,
      repo: this.repo.repo,
      pull_number: number,
      body,
    });
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

  async getPullRequestDeliveryRef(number: number): Promise<{
    number: number;
    url: string;
    headRef: string;
    headSha: string;
    baseRef: string;
  }> {
    if (!this.octokit.rest.pulls.get) {
      throw new Error("GitHub pull-request lookup is unavailable");
    }
    const response = await this.octokit.rest.pulls.get({
      owner: this.repo.owner,
      repo: this.repo.repo,
      pull_number: number,
    });
    const { head, base } = response.data;
    if (!head?.ref || !head.sha || !base?.ref) {
      throw new Error("GitHub pull-request delivery ref is unavailable");
    }
    return {
      number: response.data.number,
      url: response.data.html_url,
      headRef: head.ref,
      headSha: head.sha,
      baseRef: base.ref,
    };
  }

  async markPullRequestReadyForReview(number: number, expectedHeadSha: string): Promise<boolean> {
    if (!this.octokit.rest.pulls.get || !this.octokit.graphql) {
      throw new Error("GitHub draft pull-request transitions are unavailable");
    }
    const response = await this.octokit.rest.pulls.get({
      owner: this.repo.owner,
      repo: this.repo.repo,
      pull_number: number,
    });
    if (response.data.draft !== true || response.data.head?.sha !== expectedHeadSha) return false;
    const pullRequestId = response.data.node_id;
    if (!pullRequestId) throw new Error("GitHub pull request node id is unavailable");
    await this.octokit.graphql(
      `mutation FacilityMarkPullRequestReady($pullRequestId: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
          pullRequest { number isDraft }
        }
      }`,
      { pullRequestId },
    );
    return true;
  }

  async getCiDoctorEvidence(pullNumber: number, headSha: string): Promise<GithubCiDoctorEvidence> {
    const { pulls, checks, actions } = this.octokit.rest;
    const getPull = pulls.get;
    const listFiles = pulls.listFiles;
    const listChecks = checks?.listForRef;
    const listWorkflowRuns = actions?.listWorkflowRunsForRepo;
    if (!getPull || !listFiles || !listChecks || !listWorkflowRuns) {
      throw new Error("GitHub CI-doctor evidence endpoints are unavailable");
    }
    const [pull, changedFiles, checkRuns, workflowRuns] = await Promise.all([
      getPull({
        owner: this.repo.owner,
        repo: this.repo.repo,
        pull_number: pullNumber,
      }),
      boundedGithubPages("pull-request files", (page) =>
        listFiles({
          owner: this.repo.owner,
          repo: this.repo.repo,
          pull_number: pullNumber,
          per_page: GITHUB_EVIDENCE_PAGE_SIZE,
          page,
        }).then((response) => response.data),
      ),
      boundedGithubPages("check runs", (page) =>
        listChecks({
          owner: this.repo.owner,
          repo: this.repo.repo,
          ref: headSha,
          filter: "latest",
          per_page: GITHUB_EVIDENCE_PAGE_SIZE,
          page,
        }).then((response) => response.data.check_runs ?? []),
      ),
      boundedGithubPages("workflow runs", (page) =>
        listWorkflowRuns({
          owner: this.repo.owner,
          repo: this.repo.repo,
          head_sha: headSha,
          per_page: GITHUB_EVIDENCE_PAGE_SIZE,
          page,
        }).then((response) => response.data.workflow_runs ?? []),
      ),
    ]);
    const head = pull.data.head;
    const base = pull.data.base;
    const headRepo = head?.repo?.full_name;
    const baseRepo = base?.repo?.full_name;
    if (!head?.ref || !head.sha || !headRepo || !base?.ref || !baseRepo || !pull.data.html_url) {
      throw new Error("GitHub pull-request CI-doctor evidence is incomplete");
    }
    return {
      pullRequest: {
        number: pull.data.number,
        state: pull.data.state,
        draft: pull.data.draft === true,
        url: pull.data.html_url,
        head: { ref: head.ref, sha: head.sha, repo: { fullName: headRepo } },
        base: { ref: base.ref, repo: { fullName: baseRepo } },
        changedFiles: changedFiles.flatMap((file) =>
          typeof file.filename === "string" ? [file.filename] : [],
        ),
      },
      checks: checkRuns.map((check) => ({
        id: check.id,
        name: check.name ?? null,
        status: check.status ?? null,
        conclusion: check.conclusion ?? null,
        detailsUrl: check.details_url ?? null,
        output: check.output
          ? { title: check.output.title ?? null, summary: check.output.summary ?? null }
          : null,
        app: check.app ? { slug: check.app.slug ?? null } : null,
      })),
      doctorRunIds: workflowRuns.flatMap((run) => {
        const name = String(run.name ?? "").toLowerCase();
        return typeof run.id === "number" &&
          (name.includes("facility-doctor") || name.includes("ci-doctor"))
          ? [run.id]
          : [];
      }),
    };
  }

  async listPullRequestSnapshots(params: {
    cursor?: string;
    perPage?: number;
    states?: Array<"OPEN" | "CLOSED" | "MERGED">;
  }): Promise<GithubPullRequestPage> {
    const data = await this.graphql<GithubPullRequestListQuery>(PULL_REQUEST_LIST_QUERY, {
      owner: this.repo.owner,
      repo: this.repo.repo,
      cursor: params.cursor ?? null,
      first: params.perPage ?? 100,
      states: params.states ?? null,
    });
    const connection = data.repository?.pullRequests;
    const snapshots = await Promise.all(
      (connection?.nodes ?? []).map(async (node) =>
        pullRequestSnapshot(await this.completeClosingIssuePages(node), this.repo),
      ),
    );
    return {
      pullRequests: snapshots.filter((value): value is GithubPullRequestSnapshot => value !== null),
      endCursor: connection?.pageInfo.endCursor ?? null,
      hasNextPage: connection?.pageInfo.hasNextPage ?? false,
    };
  }

  async getPullRequestSnapshot(number: number): Promise<GithubPullRequestSnapshot | null> {
    const data = await this.graphql<GithubPullRequestQuery>(PULL_REQUEST_QUERY, {
      owner: this.repo.owner,
      repo: this.repo.repo,
      number,
    });
    const snapshot = pullRequestSnapshot(
      await this.completeClosingIssuePages(data.repository?.pullRequest ?? null),
      this.repo,
    );
    if (!snapshot) return null;
    // Failure names are only persisted and displayed for a failing aggregate.
    // Avoid a second paginated GitHub request for the common pending/success
    // states, where upsertPullRequestSnapshot deliberately stores an empty list.
    if (snapshot.ciState !== "failure") return { ...snapshot, ciFailureNames: [] };
    const ciFailureNames = await this.getCurrentCiFailureNames(snapshot.headSha);
    return ciFailureNames ? { ...snapshot, ciFailureNames } : snapshot;
  }

  private async getCurrentCiFailureNames(headSha: string): Promise<string[] | undefined> {
    const listForRef = this.octokit.rest.checks?.listForRef;
    if (!listForRef) return undefined;
    try {
      const pages = await boundedGithubPages("check runs", (page) =>
        listForRef({
          owner: this.repo.owner,
          repo: this.repo.repo,
          ref: headSha,
          filter: "latest",
          per_page: GITHUB_EVIDENCE_PAGE_SIZE,
          page,
        }).then((response) => response.data.check_runs ?? []),
      );
      return currentCiFailureNames(pages.flat());
    } catch {
      // Names are display detail. The aggregate rollup remains authoritative
      // and must still refresh when the Checks REST endpoint is unavailable.
      return undefined;
    }
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

  async updateIssue(
    number: number,
    input: {
      title: string;
      body: string;
      labels?: string[];
      state?: "open" | "closed";
    },
  ): Promise<{ number: number; url: string }> {
    if (!this.octokit.rest.issues.update) throw new Error("GitHub issue updates are unavailable");
    const response = await this.octokit.rest.issues.update({
      owner: this.repo.owner,
      repo: this.repo.repo,
      issue_number: number,
      title: input.title,
      body: input.body,
      labels: input.labels,
      state: input.state,
    });
    return { number: response.data.number, url: response.data.html_url };
  }

  async ensureLabel(input: { name: string; color: string; description: string }): Promise<void> {
    if (!this.octokit.rest.issues.createLabel) return;
    try {
      await this.octokit.rest.issues.createLabel({
        owner: this.repo.owner,
        repo: this.repo.repo,
        name: input.name,
        color: input.color,
        description: input.description,
      });
    } catch (error) {
      // GitHub returns 422 when the label already exists. That is the desired
      // state, while permission/network failures must stay loud.
      if (statusCode(error) !== 422) throw error;
    }
  }

  async closePullRequest(number: number): Promise<void> {
    await this.octokit.rest.pulls.update({
      owner: this.repo.owner,
      repo: this.repo.repo,
      pull_number: number,
      state: "closed",
    });
  }

  async listReviewThreads(number: number) {
    const reviews = this.octokit.rest.pulls.listReviews
      ? (
          await this.octokit.rest.pulls.listReviews({
            owner: this.repo.owner,
            repo: this.repo.repo,
            pull_number: number,
            per_page: 100,
          })
        ).data
      : [];
    const comments = this.octokit.rest.pulls.listReviewComments
      ? (
          await this.octokit.rest.pulls.listReviewComments({
            owner: this.repo.owner,
            repo: this.repo.repo,
            pull_number: number,
            per_page: 100,
          })
        ).data
      : [];
    return {
      pr: number,
      reviews: reviews.map((value) => {
        const review = objectRecord(value);
        return {
          id: review.id,
          state: review.state,
          submitted_at: review.submitted_at,
          body: boundedText(review.body),
        };
      }),
      threads: comments.map((value) => {
        const comment = objectRecord(value);
        return {
          id: comment.id,
          in_reply_to_id: comment.in_reply_to_id,
          path: comment.path,
          line: comment.line ?? comment.original_line,
          created_at: comment.created_at,
          body: boundedText(comment.body),
        };
      }),
    };
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

  async updateIssueComment(commentId: number, body: string): Promise<void> {
    await this.octokit.rest.issues.updateComment({
      owner: this.repo.owner,
      repo: this.repo.repo,
      comment_id: commentId,
      body,
    });
  }

  /** GitHub can return 201 while silently dropping an ineligible assignee. */
  async assignIssue(number: number, login: string): Promise<boolean> {
    if (!this.octokit.rest.issues.addAssignees) {
      throw new Error("GitHub issue assignment is unavailable");
    }
    const response = await this.octokit.rest.issues.addAssignees({
      owner: this.repo.owner,
      repo: this.repo.repo,
      issue_number: number,
      assignees: [login],
    });
    return (response.data.assignees ?? []).some(
      (assignee) => assignee.login?.toLowerCase() === login.toLowerCase(),
    );
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
      sort: "updated",
      direction: "asc",
      page: params.page,
      per_page: params.perPage,
    });
    return response.data;
  }

  async listIssueComments(
    number: number,
    maxChars?: number,
  ): Promise<
    Array<{
      id: number;
      author: string;
      authorType: string;
      body: string;
      createdAt: string;
      url: string;
    }>
  > {
    if (!this.octokit.rest.issues.listComments) return [];
    const comments: Array<{
      id: number;
      author: string;
      authorType: string;
      body: string;
      createdAt: string;
      url: string;
    }> = [];
    let serializedChars = 2;
    for (let page = 1; ; page += 1) {
      const response = await this.octokit.rest.issues.listComments({
        owner: this.repo.owner,
        repo: this.repo.repo,
        issue_number: number,
        page,
        per_page: 100,
      });
      const mapped = response.data.map((comment) => ({
        id: comment.id,
        author: comment.user?.login ?? "unknown",
        authorType: comment.user?.type ?? "User",
        body: comment.body ?? "",
        createdAt: comment.created_at,
        url: comment.html_url,
      }));
      for (const comment of mapped) {
        serializedChars += JSON.stringify(comment).length + 1;
        if (maxChars !== undefined && serializedChars > maxChars) {
          throw new GithubIssueContextTooLargeError();
        }
        comments.push(comment);
      }
      if (response.data.length < 100) return comments;
    }
  }

  async getIssue(number: number) {
    if (!this.octokit.rest.issues.get) {
      throw new Error("GitHub issue retrieval is unavailable");
    }
    const response = await this.octokit.rest.issues.get({
      owner: this.repo.owner,
      repo: this.repo.repo,
      issue_number: number,
    });
    return response.data;
  }

  async getPullRequest(number: number): Promise<{
    number: number;
    title: string;
    body: string;
    author: string;
    url: string;
    state: "open" | "closed" | "merged";
    draft: boolean;
    createdAt: string | null;
    closedAt: string | null;
    mergedAt: string | null;
  }> {
    if (!this.octokit.rest.pulls.get) throw new Error("GitHub PR reads are unavailable");
    const response = await this.octokit.rest.pulls.get({
      owner: this.repo.owner,
      repo: this.repo.repo,
      pull_number: number,
    });
    return {
      number: response.data.number,
      title: response.data.title,
      body: response.data.body ?? "",
      author: response.data.user?.login ?? "unknown",
      url: response.data.html_url,
      state: response.data.merged_at
        ? "merged"
        : response.data.state === "closed"
          ? "closed"
          : "open",
      draft: response.data.draft ?? false,
      createdAt: response.data.created_at ?? null,
      closedAt: response.data.closed_at ?? null,
      mergedAt: response.data.merged_at ?? null,
    };
  }

  async getAddressReviewPullRequest(number: number): Promise<AddressReviewPullRequest> {
    if (!this.octokit.rest.pulls.get) throw new Error("GitHub PR reads are unavailable");
    const response = await this.octokit.rest.pulls.get({
      owner: this.repo.owner,
      repo: this.repo.repo,
      pull_number: number,
    });
    const pullRequest = response.data;
    const author = pullRequest.user;
    const head = pullRequest.head;
    const base = pullRequest.base;
    if (
      !author?.login ||
      !author.type ||
      !head?.ref ||
      !head.sha ||
      !head.repo?.full_name ||
      !base?.ref ||
      !base.repo?.full_name ||
      !pullRequest.html_url
    ) {
      throw new Error("GitHub address-review pull-request evidence is incomplete");
    }
    return {
      number: pullRequest.number,
      state: pullRequest.state === "open" ? "open" : "closed",
      draft: pullRequest.draft === true,
      url: pullRequest.html_url,
      author: { login: author.login, type: author.type },
      head: {
        ref: head.ref,
        sha: head.sha,
        repo: head.repo.full_name,
      },
      base: { ref: base.ref, repo: base.repo.full_name },
    };
  }

  async getAddressReviewSubmittedReview(
    pullNumber: number,
    reviewId: number,
  ): Promise<AddressReviewSubmittedReview> {
    const getReview = this.octokit.rest.pulls.getReview;
    const listComments = this.octokit.rest.pulls.listCommentsForReview;
    if (!getReview || !listComments) {
      throw new Error("GitHub submitted-review evidence endpoints are unavailable");
    }
    const [reviewResponse, comments] = await Promise.all([
      getReview({
        owner: this.repo.owner,
        repo: this.repo.repo,
        pull_number: pullNumber,
        review_id: reviewId,
      }),
      boundedGithubPages("submitted-review comments", (page) =>
        listComments({
          owner: this.repo.owner,
          repo: this.repo.repo,
          pull_number: pullNumber,
          review_id: reviewId,
          per_page: GITHUB_EVIDENCE_PAGE_SIZE,
          page,
        }).then((response) => response.data),
      ),
    ]);
    const review = objectRecord(reviewResponse.data);
    const author = objectRecord(review.user);
    const id = Number(review.id);
    const state = typeof review.state === "string" ? review.state.toLowerCase() : "";
    const commitSha = typeof review.commit_id === "string" ? review.commit_id : "";
    const authorLogin = typeof author.login === "string" ? author.login : "";
    if (!Number.isInteger(id) || id !== reviewId || !state || !commitSha || !authorLogin) {
      throw new Error("GitHub submitted-review evidence is incomplete");
    }
    return {
      id,
      state,
      commitSha,
      author: authorLogin,
      body: boundedText(review.body),
      submittedAt: typeof review.submitted_at === "string" ? review.submitted_at : null,
      comments: comments.map((value) => {
        const comment = objectRecord(value);
        return {
          id: numberOrNull(comment.id),
          path: stringOrNull(comment.path),
          line: numberOrNull(comment.line ?? comment.original_line),
          body: boundedText(comment.body),
          diffHunk: boundedText(comment.diff_hunk),
          url: stringOrNull(comment.html_url),
        };
      }),
    };
  }

  async userCanWrite(username: string): Promise<boolean> {
    try {
      const response = await this.octokit.rest.repos.getCollaboratorPermissionLevel({
        owner: this.repo.owner,
        repo: this.repo.repo,
        username,
      });
      return ["admin", "maintain", "write"].includes(response.data.permission);
    } catch (error) {
      // GitHub returns 404 for users who are not collaborators. Treat that as
      // a deterministic denial while preserving rate-limit and service errors
      // so the durable webhook job can retry them.
      if (statusCode(error) === 404) return false;
      throw error;
    }
  }

  private refuseDefaultBranch(ref: string) {
    const normalized = ref.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
    if (normalized === this.repo.defaultBranch) {
      throw new Error(`Refusing to write to default branch ${this.repo.defaultBranch}`);
    }
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (this.octokit.graphql) return this.octokit.graphql<T>(query, variables);
    if (this.octokit.request) {
      const response = await this.octokit.request("POST /graphql", { query, variables });
      const envelope = response.data;
      const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
      if (errors.length > 0) {
        const messages = errors
          .map((error) =>
            error && typeof error === "object" && "message" in error
              ? String(error.message)
              : "unknown GraphQL error",
          )
          .join("; ");
        throw new Error(`GitHub GraphQL request failed: ${messages}`);
      }
      const data = envelope.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("GitHub GraphQL response did not contain a data object");
      }
      return data as T;
    }
    throw new Error("GitHub GraphQL is unavailable");
  }

  private async completeClosingIssuePages(node: PullRequestNode | null) {
    const first = node?.closingIssuesReferences;
    if (!node || !first?.pageInfo?.hasNextPage) return node;
    const nodes = [...(first.nodes ?? [])];
    let cursor = first.pageInfo.endCursor;
    if (!cursor) throw new Error("GitHub closing-issue pagination returned no end cursor");
    while (cursor) {
      const data: GithubPullRequestClosingIssuesQuery =
        await this.graphql<GithubPullRequestClosingIssuesQuery>(PULL_REQUEST_CLOSING_ISSUES_QUERY, {
          owner: this.repo.owner,
          repo: this.repo.repo,
          number: node.number,
          cursor,
        });
      const page: ClosingIssuesConnection | null | undefined =
        data.repository?.pullRequest?.closingIssuesReferences;
      nodes.push(...(page?.nodes ?? []));
      if (!page?.pageInfo.hasNextPage) break;
      if (!page.pageInfo.endCursor) {
        throw new Error("GitHub closing-issue pagination returned no end cursor");
      }
      cursor = page.pageInfo.endCursor;
    }
    return { ...node, closingIssuesReferences: { nodes } };
  }
}

async function boundedGithubPages<T>(label: string, load: (page: number) => Promise<T[]>) {
  const values: T[] = [];
  for (let page = 1; ; page += 1) {
    const rows = await load(page);
    if (values.length >= GITHUB_EVIDENCE_MAX_ITEMS && rows.length > 0) {
      throw new Error(`GitHub ${label} exceed the governed evidence limit`);
    }
    values.push(...rows);
    if (rows.length < GITHUB_EVIDENCE_PAGE_SIZE) return values;
  }
}

type ClosingIssueNode = {
  number?: number;
  repository?: { nameWithOwner?: string | null } | null;
} | null;

type ClosingIssuesConnection = {
  nodes?: ClosingIssueNode[];
  pageInfo: { endCursor?: string | null; hasNextPage?: boolean };
};

type PullRequestNode = {
  number?: number;
  title?: string;
  state?: string;
  isDraft?: boolean;
  author?: { login?: string | null } | null;
  headRefName?: string | null;
  headRefOid?: string | null;
  baseRefName?: string | null;
  url?: string;
  body?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  closedAt?: string | null;
  mergedAt?: string | null;
  closingIssuesReferences?: {
    nodes?: ClosingIssueNode[];
    pageInfo?: { endCursor?: string | null; hasNextPage?: boolean };
  } | null;
  commits?: {
    nodes?: Array<{
      commit?: {
        oid?: string | null;
        statusCheckRollup?: { state?: string | null } | null;
      } | null;
    } | null>;
  } | null;
};

type GithubPullRequestListQuery = {
  repository?: {
    pullRequests?: {
      nodes?: Array<PullRequestNode | null>;
      pageInfo: { endCursor?: string | null; hasNextPage?: boolean };
    } | null;
  } | null;
};

type GithubPullRequestQuery = {
  repository?: { pullRequest?: PullRequestNode | null } | null;
};

type GithubPullRequestClosingIssuesQuery = {
  repository?: {
    pullRequest?: {
      closingIssuesReferences?: {
        nodes?: ClosingIssueNode[];
        pageInfo: { endCursor?: string | null; hasNextPage?: boolean };
      } | null;
    } | null;
  } | null;
};

const PULL_REQUEST_FIELDS = `
  number
  title
  state
  isDraft
  author { login }
  headRefName
  headRefOid
  baseRefName
  url
  body
  createdAt
  updatedAt
  closedAt
  mergedAt
  closingIssuesReferences(first: 100) {
    nodes { number repository { nameWithOwner } }
    pageInfo { endCursor hasNextPage }
  }
  commits(last: 1) {
    nodes { commit { oid statusCheckRollup { state } } }
  }
`;

const PULL_REQUEST_LIST_QUERY = `
  query FacilityPullRequests(
    $owner: String!
    $repo: String!
    $cursor: String
    $first: Int!
    $states: [PullRequestState!]
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequests(
        first: $first
        after: $cursor
        states: $states
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        nodes { ${PULL_REQUEST_FIELDS} }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
`;

const PULL_REQUEST_QUERY = `
  query FacilityPullRequest($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) { ${PULL_REQUEST_FIELDS} }
    }
  }
`;

const PULL_REQUEST_CLOSING_ISSUES_QUERY = `
  query FacilityPullRequestClosingIssues(
    $owner: String!
    $repo: String!
    $number: Int!
    $cursor: String!
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        closingIssuesReferences(first: 100, after: $cursor) {
          nodes { number repository { nameWithOwner } }
          pageInfo { endCursor hasNextPage }
        }
      }
    }
  }
`;

function pullRequestSnapshot(
  node: PullRequestNode | null,
  repo: RepoRef,
): GithubPullRequestSnapshot | null {
  if (
    !node?.number ||
    !node.title ||
    !node.headRefName ||
    !node.headRefOid ||
    !node.baseRefName ||
    !node.url
  ) {
    return null;
  }
  const latestCommit = node.commits?.nodes?.at(-1)?.commit;
  const sameRepo = `${repo.owner}/${repo.repo}`.toLowerCase();
  const closingIssues = [
    ...new Set(
      (node.closingIssuesReferences?.nodes ?? [])
        .filter((issue) => issue?.repository?.nameWithOwner?.toLowerCase() === sameRepo)
        .map((issue) => issue?.number)
        .filter((number): number is number => typeof number === "number"),
    ),
  ].sort((a, b) => a - b);
  return {
    number: node.number,
    title: node.title,
    state: githubPullRequestState(node.state),
    draft: node.isDraft ?? false,
    author: node.author?.login ?? null,
    headRef: node.headRefName,
    headSha: node.headRefOid,
    baseRef: node.baseRefName,
    url: node.url,
    body: node.body ?? null,
    closingIssues,
    ciState: githubCiState(latestCommit?.statusCheckRollup?.state),
    ciHeadSha: latestCommit?.oid ?? node.headRefOid,
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? null,
    closedAt: node.closedAt ?? null,
    mergedAt: node.mergedAt ?? null,
  };
}

function githubPullRequestState(value: string | undefined): "open" | "closed" | "merged" {
  if (value?.toUpperCase() === "MERGED") return "merged";
  if (value?.toUpperCase() === "CLOSED") return "closed";
  return "open";
}

function githubCiState(value: string | null | undefined): "pending" | "success" | "failure" | null {
  const state = value?.toUpperCase();
  if (state === "SUCCESS") return "success";
  if (state === "FAILURE" || state === "ERROR") return "failure";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  return null;
}

const FAILURE_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "startup_failure",
  "timed_out",
]);

function currentCiFailureNames(
  checks: Array<{ name?: string | null; conclusion?: string | null }>,
): string[] {
  return [
    ...new Set(
      checks.flatMap((check) => {
        if (!FAILURE_CONCLUSIONS.has(check.conclusion?.toLowerCase() ?? "")) return [];
        const name = check.name
          ?.replace(/[\r\n\t]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return name ? [name.slice(0, 160)] : [];
      }),
    ),
  ]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 20);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedText(value: unknown) {
  if (typeof value !== "string") return null;
  return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusCode(error: unknown) {
  return error && typeof error === "object" && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}
