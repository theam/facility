import type { PreviewGenerationRepository } from "@facility/core";
import { describe, expect, it, vi } from "vitest";
import { readPreviewPullMerge } from "../src/github/preview-pull-merge.js";
import type { GithubWorkspaceCredentials } from "../src/github/workspace-credentials.js";

const head = "a".repeat(40);
const integrated = "b".repeat(40);
const target: PreviewGenerationRepository = {
  repositoryId: "repo_app",
  repository: "acme/app",
  pullNumber: 7,
  headRef: "feature/preview",
  headSha: head,
  primary: true,
};
function credentials(): GithubWorkspaceCredentials {
  return {
    repositories: [
      { owner: "acme", name: "app", defaultBranch: "main", role: "primary" },
      { owner: "other", name: "library", defaultBranch: "main", role: "related" },
    ],
    environment: {
      GH_TOKEN: "primary-fallback-must-not-be-used",
      FACILITY_GITHUB_CREDENTIALS: JSON.stringify({
        "acme/app": "primary-test-token",
        "other/library": "related-test-token",
      }),
    },
    expiresAt: new Date(Date.now() + 60_000),
    gitIdentity: { name: "Fixture", email: "fixture@example.test" },
  };
}
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    merged: true,
    head: { sha: head },
    base: { repo: { full_name: "acme/app" } },
    merge_commit_sha: integrated,
    ...overrides,
  };
}
const response = (body: unknown) => new Response(JSON.stringify(body));

describe("GitHub proof of a preview PR integration", () => {
  it("confirms the exact head and uses the related repository's own credential", async () => {
    const request = vi.fn(async () =>
      response(snapshot({ base: { repo: { full_name: "OTHER/LIBRARY" } } })),
    );
    expect(
      await readPreviewPullMerge(
        { ...target, repository: "other/library", primary: false },
        credentials(),
        undefined,
        request,
      ),
    ).toBe(integrated);
    const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/other/library/pulls/7");
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer related-test-token");
    expect(options.redirect).toBe("error");
  });

  it("does not use an open PR's synthetic merge commit", async () => {
    expect(
      await readPreviewPullMerge(target, credentials(), undefined, async () =>
        response(snapshot({ merged: false })),
      ),
    ).toBeNull();
  });

  it.each([
    { head: { sha: "c".repeat(40) } },
    { number: 8 },
    { base: { repo: { full_name: "foreign/app" } } },
  ])("rejects a response that no longer identifies the required PR: %j", async (changes) => {
    await expect(
      readPreviewPullMerge(target, credentials(), undefined, async () =>
        response(snapshot(changes)),
      ),
    ).rejects.toMatchObject({ code: "preview_pull_request_changed" });
  });

  it.each([
    { merge_commit_sha: null },
    { merge_commit_sha: "HEAD" },
    { merged: "true" },
  ])("rejects missing or malformed integration evidence: %j", async (changes) => {
    await expect(
      readPreviewPullMerge(target, credentials(), undefined, async () =>
        response(snapshot(changes)),
      ),
    ).rejects.toMatchObject({ code: "preview_pull_request_unavailable" });
  });

  it.each([
    401, 403, 404, 429, 503,
  ])("fails closed on HTTP %s without publishing provider bodies", async (status) => {
    const request = async () =>
      new Response("private provider body primary-test-token", { status });
    const result = readPreviewPullMerge(target, credentials(), undefined, request);
    await expect(result).rejects.toMatchObject({ code: "preview_pull_request_unavailable" });
    await expect(result).rejects.not.toThrow(/private provider body|primary-test-token/);
  });

  it("does not forward transport errors or malformed response bodies", async () => {
    for (const request of [
      async () => {
        throw new Error("transport exposed primary-test-token");
      },
      async () => new Response("primary-test-token"),
    ]) {
      await expect(
        readPreviewPullMerge(target, credentials(), undefined, request),
      ).rejects.not.toThrow(/primary-test-token/);
    }
  });

  it("rejects an unconnected repository before making any request", async () => {
    const request = vi.fn();
    await expect(
      readPreviewPullMerge(
        { ...target, repository: "foreign/app" },
        credentials(),
        undefined,
        request,
      ),
    ).rejects.toMatchObject({ code: "preview_repository_mismatch" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    "{}",
    "null",
    "[]",
    "invalid",
    '{"acme/app":"bad\\ntoken"}',
  ])("does not fall back to a different repository's token for credential map %s", async (map) => {
    const supplied = credentials();
    supplied.environment.FACILITY_GITHUB_CREDENTIALS = map;
    const request = vi.fn();
    await expect(readPreviewPullMerge(target, supplied, undefined, request)).rejects.toMatchObject({
      code: "github_token_invalid",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects expired credentials before making any request", async () => {
    const supplied = credentials();
    supplied.expiresAt = new Date(0);
    const request = vi.fn();
    await expect(readPreviewPullMerge(target, supplied, undefined, request)).rejects.toMatchObject({
      code: "github_token_expired",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("honors an already revoked lease without making a request", async () => {
    const controller = new AbortController();
    const reason = new Error("writer lease released");
    controller.abort(reason);
    const request = vi.fn();
    await expect(
      readPreviewPullMerge(target, credentials(), controller.signal, request),
    ).rejects.toBe(reason);
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels an in-flight request when the writer lease is revoked", async () => {
    const controller = new AbortController();
    const reason = new Error("writer lease lost");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const request: typeof fetch = async (_input, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
        entered();
      });
    const pending = readPreviewPullMerge(target, credentials(), controller.signal, request);
    await started;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
