import { createHash } from "node:crypto";
import type { FacilityDb } from "@facility/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "../src/github/client.js";
import { GithubConsultationSources } from "../src/stories/consultation-sources.js";

const scope = { orgId: "org_test", projectId: "proj_test", storyId: "story_test" };
const commit = "a".repeat(40),
  root = "b".repeat(40),
  subtree = "c".repeat(40);
function fixture() {
  const state = {
    content: Buffer.from("export const answer = 42;\n"),
    mode: "100644",
    truncated: false,
    badHash: false,
    encoding: "base64",
    size: undefined as number | undefined,
  };
  const blobSha = () =>
    createHash("sha1").update(`blob ${state.content.length}\0`).update(state.content).digest("hex");
  const mutation = vi.fn(async (): Promise<never> => {
    throw new Error("write forbidden");
  });
  const getContent = vi.fn(async (): Promise<never> => {
    throw new Error("getContent must not read source files");
  });
  const request = vi.fn(async (route: string, args: Record<string, unknown> = {}) => {
    if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}")
      return {
        data: {
          sha: args.tree_sha,
          truncated: state.truncated,
          tree:
            args.tree_sha === root
              ? [{ path: "src", type: "tree", mode: "040000", sha: subtree }]
              : [
                  {
                    path: "app.ts",
                    type: state.mode === "160000" ? "commit" : "blob",
                    mode: state.mode,
                    sha: blobSha(),
                  },
                ],
        },
      };
    if (route === "GET /repos/{owner}/{repo}/git/blobs/{file_sha}")
      return {
        data: {
          sha: state.badHash ? "d".repeat(40) : blobSha(),
          content: state.content.toString("base64"),
          encoding: state.encoding,
          size: state.size ?? state.content.length,
        },
      };
    throw new Error("unexpected GitHub operation");
  });
  const client = {
    request,
    rest: {
      git: {
        getCommit: vi.fn(async () => ({ data: { sha: commit, tree: { sha: root } } })),
        createBlob: mutation,
        createTree: mutation,
        createCommit: mutation,
        createRef: mutation,
        updateRef: mutation,
      },
      repos: {
        getContent,
        getBranch: vi.fn(async () => ({ data: { commit: { sha: commit } } })),
        createInOrg: mutation,
      },
      pulls: { create: mutation },
    },
  } satisfies Octokit;
  const sources = new GithubConsultationSources({} as FacilityDb, async () => client);
  vi.spyOn(sources, "identity").mockResolvedValue({
    id: "repo_test",
    ...scope,
    owner: "example",
    name: "app",
    defaultBranch: "main",
    role: "primary",
    installationId: "ghi_test",
    installationNumber: 1,
    installationAccountId: 1,
  });
  return { state, sources, request, mutation, getContent, client };
}
const selected = { repository_id: "repo_test", commit_sha: commit, path: "src/app.ts" };
afterEach(() => vi.restoreAllMocks());

describe("immutable bounded consultation source reads", () => {
  it("reads an exact regular Git blob, verifies its identity and never follows getContent or writes", async () => {
    const f = fixture();
    const file = await f.sources.read(scope, selected);
    expect(file).toMatchObject({
      repositoryId: "repo_test",
      commitSha: commit,
      path: "src/app.ts",
      text: f.state.content.toString(),
      bytes: f.state.content.length,
      hash: createHash("sha256").update(f.state.content).digest("base64url"),
    });
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(
      f.request.mock.calls.every(
        ([route, args]) =>
          route.startsWith("GET ") && args?.owner === "example" && args?.repo === "app",
      ),
    ).toBe(true);
    expect(f.getContent).not.toHaveBeenCalled();
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it.each([
    "120000",
    "160000",
    "040000",
  ])("rejects non-regular Git mode %s before reading its target", async (mode) => {
    const f = fixture();
    f.state.mode = mode;
    await expect(f.sources.read(scope, selected)).rejects.toMatchObject({
      code: "consultation_source_invalid",
    });
    expect(f.request.mock.calls.filter(([route]) => route.includes("blobs"))).toHaveLength(0);
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it("rejects truncated trees and mismatched blob identities", async () => {
    const f = fixture();
    f.state.truncated = true;
    await expect(f.sources.read(scope, selected)).rejects.toMatchObject({
      code: "consultation_source_invalid",
    });
    f.state.truncated = false;
    f.state.badHash = true;
    await expect(f.sources.read(scope, selected)).rejects.toMatchObject({
      code: "consultation_source_invalid",
    });
  });
  it.each([
    Buffer.from([0, 1, 2]),
    Buffer.from([0xff]),
    Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:synthetic"),
    Buffer.alloc(8193, 65),
  ])("rejects binary, invalid UTF-8, external LFS or oversized source data", async (content) => {
    const f = fixture();
    f.state.content = content;
    await expect(f.sources.read(scope, selected)).rejects.toMatchObject({
      code: "consultation_source_invalid",
    });
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it("denies a source revoked from this project before contacting GitHub", async () => {
    const f = fixture();
    vi.mocked(f.sources.identity).mockRejectedValue(new Error("connection revoked"));
    await expect(f.sources.read(scope, selected)).rejects.toThrow("connection revoked");
    expect(f.client.rest.git.getCommit).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });
});
