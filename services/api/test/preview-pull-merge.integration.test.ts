import { once } from "node:events";
import { createServer } from "node:http";
import type { PreviewGenerationRepository } from "@facility/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readPreviewPullMerge } from "../src/github/preview-pull-merge.js";
import type { GithubWorkspaceCredentials } from "../src/github/workspace-credentials.js";

describe("preview integration evidence over HTTP", () => {
  const head = "a".repeat(40);
  const merge = "b".repeat(40);
  const target: PreviewGenerationRepository = {
    repositoryId: "repo_app",
    repository: "acme/app",
    pullNumber: 7,
    headRef: "feature/preview",
    headSha: head,
    primary: true,
  };
  let origin: string;
  let foreignOrigin: string;
  let redirect = false;
  let leakedRequests = 0;
  const requests: Array<{ url: string; authorization?: string }> = [];
  const foreign = createServer((_request, reply) => {
    leakedRequests++;
    reply.end("untrusted");
  });
  const server = createServer((request, reply) => {
    requests.push({ url: request.url ?? "", authorization: request.headers.authorization });
    if (redirect) {
      reply.writeHead(302, { location: `${foreignOrigin}/leak` });
      reply.end();
      return;
    }
    reply.setHeader("content-type", "application/json");
    reply.end(
      JSON.stringify({
        number: 7,
        merged: true,
        head: { sha: head },
        base: { repo: { full_name: "acme/app" } },
        merge_commit_sha: merge,
      }),
    );
  });
  const transport: typeof fetch = (input, options) =>
    fetch(`${origin}${new URL(input as string).pathname}`, options);
  function credentials(): GithubWorkspaceCredentials {
    return {
      repositories: [{ owner: "acme", name: "app", defaultBranch: "main", role: "primary" }],
      environment: {
        FACILITY_GITHUB_CREDENTIALS: JSON.stringify({ "acme/app": "loopback-test-token" }),
      },
      expiresAt: new Date(Date.now() + 60_000),
      gitIdentity: { name: "Fixture", email: "fixture@example.test" },
    };
  }
  beforeAll(async () => {
    server.listen(0, "127.0.0.1");
    foreign.listen(0, "127.0.0.1");
    await Promise.all([once(server, "listening"), once(foreign, "listening")]);
    const address = server.address();
    const other = foreign.address();
    if (!address || typeof address === "string" || !other || typeof other === "string")
      throw new Error("missing loopback port");
    origin = `http://127.0.0.1:${address.port}`;
    foreignOrigin = `http://127.0.0.1:${other.port}`;
  });
  beforeEach(() => {
    requests.length = 0;
    redirect = false;
    leakedRequests = 0;
  });
  afterAll(async () => {
    server.closeAllConnections();
    foreign.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => foreign.close(() => resolve())),
    ]);
  });

  it("reads integration evidence with the scoped installation token", async () => {
    expect(await readPreviewPullMerge(target, credentials(), undefined, transport)).toBe(merge);
    expect(requests).toEqual([
      { url: "/repos/acme/app/pulls/7", authorization: "Bearer loopback-test-token" },
    ]);
    expect(leakedRequests).toBe(0);
  });

  it("refuses redirects without forwarding credentials to a different destination", async () => {
    redirect = true;
    await expect(
      readPreviewPullMerge(target, credentials(), undefined, transport),
    ).rejects.toMatchObject({ code: "preview_pull_request_unavailable" });
    expect(requests).toHaveLength(1);
    expect(leakedRequests).toBe(0);
  });
});
