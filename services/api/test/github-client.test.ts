import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGithubClientFactory, FacilityGithubClient } from "../src/github/client.js";
import { readRepoFiles } from "../src/github/repo-files.js";

describe("GitHub client factory", () => {
  it("creates installation clients with the REST helpers used by production flows", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const factory = createGithubClientFactory({
      githubAppId: "1",
      githubAppPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    } as Parameters<typeof createGithubClientFactory>[0]);

    const client = await factory(123);

    expect(client.request).toBeTypeOf("function");
    expect(client.rest.repos.get).toBeTypeOf("function");
    expect(client.rest.repos.createInOrg).toBeTypeOf("function");
    expect(client.rest.git.createCommit).toBeTypeOf("function");
    expect(client.rest.pulls.create).toBeTypeOf("function");
    expect(client.rest.issues.createComment).toBeTypeOf("function");
  });
});

describe("GitHub pull-request snapshots", () => {
  it("maps pagination, authoritative same-repo links, merged state, and aggregate CI", async () => {
    let variables: Record<string, unknown> | undefined;
    const client = new FacilityGithubClient(
      {
        graphql: async (_query: string, input?: Record<string, unknown>) => {
          variables = input;
          return {
            repository: {
              pullRequests: {
                pageInfo: { endCursor: "cursor-2", hasNextPage: true },
                nodes: [
                  {
                    number: 42,
                    title: "Ship it",
                    state: "MERGED",
                    isDraft: false,
                    author: { login: "ada" },
                    headRefName: "feature/42",
                    headRefOid: "head-42",
                    baseRefName: "main",
                    url: "https://github.test/Octo/Repo/pull/42",
                    body: "Closes #7 and octo/other#9",
                    createdAt: "2026-08-01T00:00:00Z",
                    updatedAt: "2026-08-02T00:00:00Z",
                    closedAt: "2026-08-03T00:00:00Z",
                    mergedAt: "2026-08-03T00:00:00Z",
                    closingIssuesReferences: {
                      nodes: [
                        { number: 8, repository: { nameWithOwner: "octo/repo" } },
                        { number: 7, repository: { nameWithOwner: "Octo/Repo" } },
                        { number: 7, repository: { nameWithOwner: "octo/repo" } },
                        { number: 9, repository: { nameWithOwner: "octo/other" } },
                      ],
                    },
                    commits: {
                      nodes: [
                        { commit: { oid: "head-42", statusCheckRollup: { state: "FAILURE" } } },
                      ],
                    },
                  },
                ],
              },
            },
          } as never;
        },
        rest: {},
      } as never,
      { owner: "Octo", repo: "Repo", defaultBranch: "main" },
    );

    await expect(
      client.listPullRequestSnapshots({ cursor: "cursor-1", perPage: 50, states: ["MERGED"] }),
    ).resolves.toEqual({
      endCursor: "cursor-2",
      hasNextPage: true,
      pullRequests: [
        expect.objectContaining({
          number: 42,
          state: "merged",
          closingIssues: [7, 8],
          ciState: "failure",
          ciHeadSha: "head-42",
        }),
      ],
    });
    expect(variables).toMatchObject({
      owner: "Octo",
      repo: "Repo",
      cursor: "cursor-1",
      first: 50,
      states: ["MERGED"],
    });
  });

  it("unwraps the raw GraphQL envelope and fails closed on GraphQL errors", async () => {
    const routes: string[] = [];
    const client = new FacilityGithubClient(
      {
        request: async (route: string) => {
          routes.push(route);
          return {
            data: {
              data: {
                repository: {
                  pullRequests: {
                    nodes: [],
                    pageInfo: { endCursor: null, hasNextPage: false },
                  },
                },
              },
            },
          };
        },
        rest: {},
      } as never,
      { owner: "octo", repo: "repo", defaultBranch: "main" },
    );
    await expect(
      client.listPullRequestSnapshots({ cursor: undefined, perPage: 100, states: ["OPEN"] }),
    ).resolves.toEqual({ pullRequests: [], endCursor: null, hasNextPage: false });
    expect(routes).toEqual(["POST /graphql"]);

    const rejected = new FacilityGithubClient(
      {
        request: async () => ({
          data: { data: null, errors: [{ message: "installation suspended" }] },
        }),
        rest: {},
      } as never,
      { owner: "octo", repo: "repo", defaultBranch: "main" },
    );
    await expect(
      rejected.listPullRequestSnapshots({ cursor: undefined, perPage: 100, states: ["OPEN"] }),
    ).rejects.toThrow("GitHub GraphQL request failed: installation suspended");
  });

  it.each([
    ["SUCCESS", "success"],
    ["ERROR", "failure"],
    ["PENDING", "pending"],
    ["EXPECTED", "pending"],
    [null, null],
  ])("normalizes the %s rollup", async (upstream, expected) => {
    const client = new FacilityGithubClient(
      {
        graphql: async () => ({
          repository: {
            pullRequest: {
              number: 3,
              title: "PR",
              state: "OPEN",
              headRefName: "feature",
              headRefOid: "sha",
              baseRefName: "main",
              url: "https://github.test/octo/repo/pull/3",
              commits: {
                nodes: [{ commit: { oid: "sha", statusCheckRollup: { state: upstream } } }],
              },
            },
          },
        }),
        rest: {},
      } as never,
      { owner: "octo", repo: "repo", defaultBranch: "main" },
    );
    await expect(client.getPullRequestSnapshot(3)).resolves.toMatchObject({ ciState: expected });
  });

  it("adds bounded failed check names to focused snapshots without replacing the rollup", async () => {
    const client = new FacilityGithubClient(
      {
        graphql: async () => ({
          repository: {
            pullRequest: {
              number: 3,
              title: "PR",
              state: "OPEN",
              headRefName: "feature",
              headRefOid: "sha",
              baseRefName: "main",
              url: "https://github.test/octo/repo/pull/3",
              commits: {
                nodes: [{ commit: { oid: "sha", statusCheckRollup: { state: "FAILURE" } } }],
              },
            },
          },
        }),
        rest: {
          checks: {
            listForRef: async () => ({
              data: {
                check_runs: [
                  { name: "typecheck", conclusion: "failure" },
                  { name: "guards", conclusion: "timed_out" },
                  { name: "lint", conclusion: "success" },
                ],
              },
            }),
          },
        },
      } as never,
      { owner: "octo", repo: "repo", defaultBranch: "main" },
    );

    await expect(client.getPullRequestSnapshot(3)).resolves.toMatchObject({
      ciState: "failure",
      ciFailureNames: ["guards", "typecheck"],
    });
  });

  it("paginates closing references instead of truncating a large linked set", async () => {
    const variables: Record<string, unknown>[] = [];
    const client = new FacilityGithubClient(
      {
        graphql: async (query: string, input?: Record<string, unknown>) => {
          variables.push(input ?? {});
          if (query.includes("FacilityPullRequestClosingIssues")) {
            return {
              repository: {
                pullRequest: {
                  closingIssuesReferences: {
                    nodes: [
                      { number: 2, repository: { nameWithOwner: "octo/repo" } },
                      { number: 9, repository: { nameWithOwner: "octo/other" } },
                    ],
                    pageInfo: { endCursor: null, hasNextPage: false },
                  },
                },
              },
            } as never;
          }
          return {
            repository: {
              pullRequest: {
                number: 4,
                title: "Many links",
                state: "OPEN",
                headRefName: "feature",
                headRefOid: "sha",
                baseRefName: "main",
                url: "https://github.test/octo/repo/pull/4",
                closingIssuesReferences: {
                  nodes: [{ number: 1, repository: { nameWithOwner: "octo/repo" } }],
                  pageInfo: { endCursor: "closing-2", hasNextPage: true },
                },
                commits: { nodes: [] },
              },
            },
          } as never;
        },
        rest: {},
      } as never,
      { owner: "octo", repo: "repo", defaultBranch: "main" },
    );

    await expect(client.getPullRequestSnapshot(4)).resolves.toMatchObject({
      closingIssues: [1, 2],
    });
    expect(variables[1]).toMatchObject({ number: 4, cursor: "closing-2" });
  });

  it("detects GitHub's silent assignee rejection from the response body", async () => {
    const dropped = new FacilityGithubClient(
      {
        rest: { issues: { addAssignees: async () => ({ data: { assignees: [] } }) } },
      } as never,
      { owner: "octo", repo: "repo", defaultBranch: "main" },
    );
    const accepted = new FacilityGithubClient(
      {
        rest: {
          issues: { addAssignees: async () => ({ data: { assignees: [{ login: "Ada" }] } }) },
        },
      } as never,
      { owner: "octo", repo: "repo", defaultBranch: "main" },
    );
    await expect(dropped.assignIssue(3, "ada")).resolves.toBe(false);
    await expect(accepted.assignIssue(3, "ada")).resolves.toBe(true);
  });
});

describe("GitHub repository file reader", () => {
  it("includes symlink targets in managed-file fingerprints", async () => {
    const client = {
      getContent: async () => ({
        type: "symlink",
        path: ".agents/skills",
        target: "../.claude/skills",
      }),
    } as unknown as FacilityGithubClient;

    await expect(readRepoFiles(client, "main", [".agents/skills"])).resolves.toEqual(
      new Map([[".agents/skills", "../.claude/skills"]]),
    );
  });
});
