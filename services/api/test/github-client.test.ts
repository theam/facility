import { describe, expect, it, vi } from "vitest";
import { FacilityGithubClient, type Octokit } from "../src/github/client.js";

function fixture() {
  const createRef = vi.fn(async () => ({ data: {} }));
  const updateRef = vi.fn(async () => ({ data: {} }));
  const createPullRequest = vi.fn(async () => ({
    data: { number: 17, html_url: "https://github.com/acme/app/pull/17" },
  }));
  const listPullRequests = vi.fn(async () => ({
    data: [
      {
        number: 17,
        html_url: "https://github.com/acme/app/pull/17",
        head: { ref: "feature/story", sha: "a".repeat(40) },
        base: { ref: "main" },
      },
    ],
  }));
  const octokit = {
    rest: {
      git: {
        getCommit: async () => ({ data: { sha: "a".repeat(40), tree: { sha: "b".repeat(40) } } }),
        createBlob: async () => ({ data: { sha: "c".repeat(40) } }),
        createTree: async () => ({ data: { sha: "d".repeat(40) } }),
        createCommit: async () => ({ data: { sha: "e".repeat(40) } }),
        createRef,
        updateRef,
      },
      repos: {
        getContent: async () => ({ data: {} }),
        getBranch: async () => ({ data: { commit: { sha: "a".repeat(40) } } }),
      },
      pulls: { create: createPullRequest, list: listPullRequests },
    },
  } as unknown as Octokit;
  return {
    client: new FacilityGithubClient(octokit, {
      owner: "acme",
      repo: "app",
      defaultBranch: "main",
    }),
    createRef,
    updateRef,
    createPullRequest,
    listPullRequests,
  };
}

describe("FacilityGithubClient", () => {
  it("uses ordinary branch and pull-request operations", async () => {
    const { client, createRef, updateRef, createPullRequest, listPullRequests } = fixture();
    const sha = "a".repeat(40);

    await client.createBranch("feature/story", sha);
    await client.updateBranch("feature/story", sha);
    await expect(
      client.createPullRequest({ title: "Story", body: "Implements it.", head: "feature/story" }),
    ).resolves.toEqual({ number: 17, url: "https://github.com/acme/app/pull/17" });
    await expect(client.listOpenPullRequestsForHead("feature/story", "main")).resolves.toEqual([
      {
        number: 17,
        url: "https://github.com/acme/app/pull/17",
        headRef: "feature/story",
        headSha: sha,
        baseRef: "main",
      },
    ]);

    expect(createRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "refs/heads/feature/story" }),
    );
    expect(updateRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "heads/feature/story" }));
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ head: "feature/story", base: "main" }),
    );
    expect(listPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({ head: "acme:feature/story", base: "main", state: "open" }),
    );
  });

  it("refuses writes to the default branch", async () => {
    const { client, createRef, updateRef, createPullRequest } = fixture();

    await expect(client.createBranch("main", "a".repeat(40))).rejects.toThrow(
      /Refusing to write to default branch/,
    );
    await expect(client.updateBranch("refs/heads/main", "a".repeat(40))).rejects.toThrow(
      /Refusing to write to default branch/,
    );
    await expect(
      client.createPullRequest({ title: "Unsafe", body: "", head: "heads/main" }),
    ).rejects.toThrow(/Refusing to write to default branch/);
    expect(createRef).not.toHaveBeenCalled();
    expect(updateRef).not.toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
  });
});
