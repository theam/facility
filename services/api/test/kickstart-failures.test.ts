import type { FacilityDb } from "@facility/db";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import type { Octokit } from "../src/github/client.js";
import {
  type GithubRepositoryRow,
  kickstartPreview,
  kickstartRepo,
} from "../src/github/kickstart.js";
import type { AppConfig, Principal } from "../src/types.js";

const repository: GithubRepositoryRow = {
  id: "repo_test",
  orgId: "org_test",
  projectId: "proj_test",
  installationId: "ghi_test",
  owner: "panteraimperial-hub",
  name: "facility-test",
  defaultBranch: "main",
};

const installation = {
  id: "ghi_test",
  orgId: "org_test",
  installationId: 4242,
  suspendedAt: null,
};

function fakeDb(row: unknown = installation) {
  return {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }),
    }),
  } as unknown as FacilityDb;
}

/** An Octokit failure carries `status`, the way `@octokit/request-error` reports it. */
function githubError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

/**
 * GitHub answers 403 both when an installation may not do something and when it
 * has spent its hourly budget. The two are told apart by the rate-limit headers,
 * which is the shape `githubRateLimitRetryAt` reads.
 */
function throttledError(status: number, resetAt: number) {
  return Object.assign(new Error("API rate limit exceeded"), {
    status,
    response: {
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(resetAt / 1_000)),
      },
    },
  });
}

/**
 * `getContent` is the only call kickstart makes before it needs a base commit,
 * and `readRepoFiles` swallows its failures, so a repository is only observed to
 * be unusable when the base ref is resolved.
 */
function fakeOctokit(options: {
  getBranch?: () => Promise<{ data: { commit: { sha: string } } }>;
  createRef?: () => Promise<{ data: unknown }>;
  updateRef?: () => Promise<{ data: unknown }>;
  contents?: Map<string, unknown>;
}): Octokit {
  const contents = options.contents ?? new Map();
  return {
    rest: {
      git: {
        getCommit: async () => ({ data: { sha: "a".repeat(40), tree: { sha: "b".repeat(40) } } }),
        createBlob: async () => ({ data: { sha: "c".repeat(40) } }),
        createTree: async () => ({ data: { sha: "d".repeat(40) } }),
        createCommit: async () => ({ data: { sha: "e".repeat(40) } }),
        createRef: options.createRef ?? (async () => ({ data: {} })),
        updateRef: options.updateRef ?? (async () => ({ data: {} })),
      },
      repos: {
        getContent: async (args: Record<string, unknown>) => {
          const path = String(args.path);
          if (!contents.has(path)) throw githubError(404, "Not Found");
          return { data: contents.get(path) };
        },
        getBranch:
          options.getBranch ?? (async () => ({ data: { commit: { sha: "a".repeat(40) } } })),
      },
      pulls: {
        create: async () => ({ data: { number: 1, html_url: "https://github.test/pr/1" } }),
        list: async () => ({ data: [] }),
      },
    },
  } as unknown as Octokit;
}

/** Every file the 0.12 kickstart would create, so nothing is left to render. */
function alreadyKickstarted() {
  const file = (path: string) => ({
    type: "file",
    path,
    encoding: "base64",
    content: Buffer.from(`# ${path}\n`).toString("base64"),
  });
  const agents = [
    "architect",
    "builder",
    "pr-reviewer",
    "address-review",
    "ci-doctor",
    "security-audit",
  ].map((name) => `.agents/${name}.md`);
  const contents = new Map<string, unknown>([
    [".facility.yml", file(".facility.yml")],
    [".agents", agents.map((path) => ({ path }))],
    ...agents.map((path) => [path, file(path)] as const),
  ]);
  return contents;
}

function applyArgs(db: FacilityDb, octokit: Octokit) {
  return {
    db,
    factory: async () => octokit,
    config: {} as AppConfig,
    principal: { type: "user", id: "user_test", orgId: "org_test" } as Principal,
    projectId: "proj_test",
    repo: repository,
    answers: {},
  };
}

describe("kickstart failures name the condition", () => {
  it("reports a repository whose base ref cannot be read, instead of a 500", async () => {
    const octokit = fakeOctokit({
      getBranch: async () => {
        throw githubError(404, "Branch not found");
      },
    });

    await expect(kickstartRepo(applyArgs(fakeDb(), octokit))).rejects.toMatchObject({
      statusCode: 404,
      code: "kickstart_repository_unreachable",
      message: expect.stringContaining("panteraimperial-hub/facility-test"),
    });
  });

  it("names an empty repository when GitHub reports the conflict", async () => {
    const octokit = fakeOctokit({
      getBranch: async () => {
        throw githubError(409, "Git Repository is empty.");
      },
    });

    await expect(kickstartRepo(applyArgs(fakeDb(), octokit))).rejects.toMatchObject({
      statusCode: 409,
      code: "kickstart_repository_empty",
      message: expect.stringContaining("main"),
    });
  });

  it("separates a refused installation from a rate-limited one", async () => {
    const forbidden = fakeOctokit({
      getBranch: async () => {
        throw githubError(403, "Resource not accessible by integration");
      },
    });
    await expect(kickstartRepo(applyArgs(fakeDb(), forbidden))).rejects.toMatchObject({
      statusCode: 403,
      code: "kickstart_repository_forbidden",
    });

    const throttled = fakeOctokit({
      getBranch: async () => {
        throw githubError(429, "Too Many Requests");
      },
    });
    await expect(kickstartRepo(applyArgs(fakeDb(), throttled))).rejects.toMatchObject({
      statusCode: 429,
      code: "kickstart_github_rate_limited",
    });
  });

  it("reads a 403 as throttling when the rate-limit headers say so, not as a permission fault", async () => {
    // Telling an operator to check installation permissions while GitHub is
    // only asking them to wait sends them to the wrong place entirely, and the
    // repository's own helper already knows the difference.
    // `x-ratelimit-reset` is whole seconds, so floor the fixture to one rather
    // than asserting against a millisecond the header cannot carry.
    const resetAt = Math.floor((Date.now() + 15 * 60 * 1_000) / 1_000) * 1_000;
    const octokit = fakeOctokit({
      getBranch: async () => {
        throw throttledError(403, resetAt);
      },
    });

    const failure = await kickstartRepo(applyArgs(fakeDb(), octokit)).catch((error) => error);
    expect(failure).toMatchObject({ statusCode: 429, code: "kickstart_github_rate_limited" });
    // The reset GitHub supplied is carried through, so the advice is a time.
    expect(failure.message).toContain(new Date(resetAt + 1_000).toISOString());
  });

  it("calls a ref conflict a moving branch, not a repository without commits", async () => {
    // GitHub answers 409 for an empty repository and for a ref that stopped
    // being a fast-forward. Only the first is fixed by pushing a commit, so the
    // two must not share a message. This one fails after the base resolved.
    const octokit = fakeOctokit({
      createRef: async () => {
        throw githubError(422, "Reference already exists");
      },
      updateRef: async () => {
        throw githubError(409, "Update is not a fast forward");
      },
    });

    await expect(kickstartRepo(applyArgs(fakeDb(), octokit))).rejects.toMatchObject({
      statusCode: 409,
      code: "kickstart_branch_conflict",
      message: expect.stringContaining("main"),
    });
  });

  it("treats an already-kickstarted repository as a conflict, not a server fault", async () => {
    const octokit = fakeOctokit({ contents: alreadyKickstarted() });

    await expect(kickstartRepo(applyArgs(fakeDb(), octokit))).rejects.toMatchObject({
      statusCode: 409,
      code: "kickstart_already_applied",
    });
  });

  it("reports a missing or suspended installation before calling GitHub", async () => {
    const octokit = fakeOctokit({});

    await expect(kickstartRepo(applyArgs(fakeDb(null), octokit))).rejects.toMatchObject({
      statusCode: 409,
      code: "github_installation_unavailable",
    });

    await expect(
      kickstartPreview(fakeDb(), async () => octokit, { ...repository, installationId: null }, {}),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "github_installation_missing",
    });
  });

  it("leaves a failure it has no advice for masked as a server error", async () => {
    const octokit = fakeOctokit({
      getBranch: async () => {
        throw githubError(502, "Bad gateway");
      },
    });

    const failure = await kickstartRepo(applyArgs(fakeDb(), octokit)).catch((error) => error);

    // Not an ApiError, so the handler keeps logging it and answering a masked 500.
    expect(failure).not.toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 502 });
  });
});
