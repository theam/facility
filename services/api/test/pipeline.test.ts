import { describe, expect, it } from "vitest";
import {
  assemblePipelineStories,
  classifyPipeline,
  PIPELINE_STAGES,
  type PipelineIssueRecord,
  type PipelinePullRequestRecord,
  type PipelineRunRecord,
} from "../src/pipeline.js";

const NOW = new Date("2026-08-05T12:00:00Z");

describe("server-owned story pipeline", () => {
  it("fans mirrored PRs into every same-repository issue without cross-repo number collisions", () => {
    const issues = [issue("repo_a", 7), issue("repo_b", 7), issue("repo_a", 8)];
    const pullRequests = [
      pull("repo_a", 20, { closingIssues: [7, 8] }),
      pull("repo_b", 21, { closingIssues: [7] }),
      pull("repo_a", 22, { closingIssues: [999] }),
    ];
    const runs: PipelineRunRecord[] = [
      run("run_01", "alice", "alpha", 7),
      run("run_02", "alice", "beta", 7),
    ];
    const assembly = assemblePipelineStories({
      issues,
      pullRequests,
      repos: [
        { id: "repo_a", owner: "alice", name: "alpha" },
        { id: "repo_b", owner: "alice", name: "beta" },
      ],
      runs,
    });

    const a7 = assembly.stories.find((story) => story.key === "repo_a:issue:7");
    const b7 = assembly.stories.find((story) => story.key === "repo_b:issue:7");
    const a8 = assembly.stories.find((story) => story.key === "repo_a:issue:8");
    const orphan = assembly.stories.find((story) => story.key === "repo_a:pull_request:22");

    expect(a7?.prs.map((candidate) => candidate.number)).toEqual([20]);
    expect(a8?.prs.map((candidate) => candidate.number)).toEqual([20]);
    expect(b7?.prs.map((candidate) => candidate.number)).toEqual([21]);
    expect(a7?.linkedRuns.map((candidate) => candidate.id)).toEqual(["run_01"]);
    expect(b7?.linkedRuns.map((candidate) => candidate.id)).toEqual(["run_02"]);
    expect(orphan).toMatchObject({ storyType: "pull_request", number: 22 });
  });

  it("uses run provenance before orphaning a mirrored PR without closing references", () => {
    const producingRun = run("run_01", "alice", "alpha", 7);
    producingRun.gh = {
      owner: "alice",
      repo: "alpha",
      issueNumber: 7,
      pr: { number: 20, url: "https://github.test/alice/alpha/pull/20" },
    };
    const assembly = assemblePipelineStories({
      issues: [issue("repo_a", 7)],
      pullRequests: [
        pull("repo_a", 20, {
          closingIssues: [],
          ciState: "failure",
          ciHeadSha: "head-20",
        }),
      ],
      repos: [{ id: "repo_a", owner: "alice", name: "alpha" }],
      runs: [producingRun],
    });

    expect(assembly.stories.map((story) => story.key)).toEqual(["repo_a:issue:7"]);
    expect(assembly.stories[0]?.prs.map((candidate) => candidate.number)).toEqual([20]);
    expect(assembly.stories[0]?.linkedRuns.map((candidate) => candidate.id)).toEqual(["run_01"]);
    expect(
      classifyPipeline(assembly.stories, new Set(), NOW.getTime()).get("review")?.[0],
    ).toMatchObject({ key: "repo_a:issue:7", ciState: "failure" });
  });

  it("applies current-run precedence, current-head CI, and the Validating machine stage", () => {
    const pending = storyWith({ ciState: "pending", ciHeadSha: "head-10" });
    const failed = storyWith({ ciState: "failure", ciHeadSha: "head-10" });
    const stalePending = storyWith({ ciState: "pending", ciHeadSha: "old-head" });
    const live = {
      ...storyWith({ ciState: "pending", ciHeadSha: "head-10" }),
      key: "repo_a:issue:2",
      number: 2,
      linkedRuns: [run("run_20", "alice", "alpha", 2, "builder", "running")],
    };
    const currentFailed = {
      ...storyWith({ ciState: "pending", ciHeadSha: "head-10" }),
      key: "repo_a:issue:3",
      number: 3,
      linkedRuns: [run("run_30", "alice", "alpha", 3, "architect", "failed")],
    };

    const staged = classifyPipeline(
      [
        { ...pending, key: "repo_a:issue:10", number: 10 },
        { ...failed, key: "repo_a:issue:11", number: 11 },
        { ...stalePending, key: "repo_a:issue:12", number: 12 },
        live,
        currentFailed,
      ],
      new Set(),
      NOW.getTime(),
    );

    expect(staged.get("validating")?.map((story) => story.number)).toEqual([10]);
    expect(staged.get("review")?.map((story) => [story.number, story.ciState])).toEqual([
      [12, null],
      [11, "failure"],
    ]);
    expect(staged.get("building")?.map((story) => [story.number, story.runState])).toEqual([
      [2, "live"],
    ]);
    expect(staged.get("planning")?.map((story) => [story.number, story.runState])).toEqual([
      [3, "failed"],
    ]);
    expect(PIPELINE_STAGES.map((stage) => [stage.key, stage.kind])).toContainEqual([
      "validating",
      "machine",
    ]);
  });

  it("carries successful CI and failed check names through the story rollup", () => {
    const successful = storyWith({ ciState: "success", ciHeadSha: "head-10" });
    const failed = storyWith({
      ciState: "failure",
      ciHeadSha: "head-10",
      ciFailureNames: ["guards", "typecheck"],
    });
    const staged = classifyPipeline(
      [successful, { ...failed, key: "repo_a:issue:2", number: 2 }],
      new Set(),
      NOW.getTime(),
    );

    expect(staged.get("review")?.find((story) => story.number === 1)).toMatchObject({
      ciState: "success",
      ciUrl: "https://github.test/alice/alpha/pull/10/checks",
      ciFailureNames: [],
    });
    expect(staged.get("review")?.find((story) => story.number === 2)).toMatchObject({
      ciState: "failure",
      ciFailureNames: ["guards", "typecheck"],
    });
  });

  it("keeps draft pull requests in Building until they are reviewable", () => {
    const draft = storyWith({ ciState: "failure", ciHeadSha: "head-10", draft: true });
    const staged = classifyPipeline([draft], new Set(), NOW.getTime());

    expect(staged.get("building")?.map((story) => [story.key, story.ciState, story.ciUrl])).toEqual(
      [[draft.key, null, null]],
    );
    expect(staged.get("validating")).toEqual([]);
    expect(staged.get("review")).toEqual([]);
  });

  it("does not classify a successful builder as delivered until its PR is durable", () => {
    const pendingRun = run("run_pending", "alice", "alpha", 40, "builder", "succeeded");
    const deliveredRun = run("run_delivered", "alice", "alpha", 41, "builder", "succeeded");
    deliveredRun.gh = {
      owner: "alice",
      repo: "alpha",
      issueNumber: 41,
      pr: { number: 141, url: "https://github.test/alice/alpha/pull/141" },
    };
    const pending = {
      ...storyWith({}),
      key: "repo_a:issue:40",
      number: 40,
      prs: [],
      linkedRuns: [pendingRun],
    };
    const delivered = {
      ...storyWith({}),
      key: "repo_a:issue:41",
      number: 41,
      prs: [],
      linkedRuns: [deliveredRun],
    };

    const staged = classifyPipeline([pending, delivered], new Set(), NOW.getTime());
    expect(staged.get("backlog")?.map((story) => story.number)).toContain(40);
    expect(staged.get("review")?.map((story) => story.number)).toContain(41);
  });

  it("ships recent closed issues and merged orphan PRs, but not abandoned PRs", () => {
    const recent = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const issueStory = { ...storyWith({}), state: "closed" as const, closedAt: recent, prs: [] };
    const merged = {
      ...storyWith({}),
      key: "repo_a:pull_request:30",
      id: "ghp_30",
      storyType: "pull_request" as const,
      number: 30,
      state: "merged" as const,
      closedAt: recent,
    };
    const abandoned = {
      ...merged,
      key: "repo_a:pull_request:31",
      number: 31,
      state: "closed" as const,
    };
    const old = {
      ...issueStory,
      key: "repo_a:issue:32",
      number: 32,
      closedAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000),
    };

    const shipped = classifyPipeline(
      [issueStory, merged, abandoned, old],
      new Set(),
      NOW.getTime(),
    ).get("shipped");
    expect(shipped?.map((story) => story.key)).toEqual([
      "repo_a:pull_request:30",
      "repo_a:issue:1",
    ]);
  });
});

function issue(repoId: string, number: number): PipelineIssueRecord {
  return {
    id: `ghi_${repoId}_${number}`,
    repoId,
    number,
    title: `Issue ${number}`,
    state: "open",
    labels: [],
    assignees: [],
    author: "octocat",
    htmlUrl: `https://github.test/${repoId}/issues/${number}`,
    commentsCount: 0,
    ghCreatedAt: NOW,
    ghUpdatedAt: NOW,
    closedAt: null,
  };
}

function pull(
  repoId: string,
  number: number,
  overrides: Partial<PipelinePullRequestRecord> = {},
): PipelinePullRequestRecord {
  return {
    id: `ghp_${repoId}_${number}`,
    repoId,
    number,
    title: `PR ${number}`,
    state: "open",
    draft: false,
    author: "octocat",
    htmlUrl: `https://github.test/${repoId}/pull/${number}`,
    headSha: `head-${number}`,
    ciState: null,
    ciHeadSha: null,
    ciFailureNames: [],
    closingIssues: [],
    ghCreatedAt: NOW,
    ghUpdatedAt: NOW,
    closedAt: null,
    mergedAt: null,
    ...overrides,
  };
}

function run(
  id: string,
  owner: string,
  repo: string,
  issueNumber: number,
  mode = "builder",
  status = "succeeded",
): PipelineRunRecord {
  return {
    id,
    mode,
    status,
    engine: "codex",
    gh: { owner, repo, issueNumber },
  };
}

function storyWith(ci: {
  ciState?: "pending" | "success" | "failure" | null;
  ciHeadSha?: string | null;
  ciFailureNames?: string[];
  draft?: boolean;
}) {
  return {
    key: "repo_a:issue:1",
    id: "ghi_1",
    storyType: "issue" as const,
    repoId: "repo_a",
    repoOwner: "alice",
    repoName: "alpha",
    number: 1,
    title: "Story",
    state: "open" as const,
    labels: [],
    assignees: [],
    author: "octocat",
    htmlUrl: "https://github.test/alice/alpha/issues/1",
    commentsCount: 0,
    ghCreatedAt: NOW,
    ghUpdatedAt: NOW,
    closedAt: null,
    linkedRuns: [] as PipelineRunRecord[],
    prs: [
      {
        number: 10,
        title: "PR 10",
        url: "https://github.test/alice/alpha/pull/10",
        state: "open" as const,
        draft: ci.draft ?? false,
        headSha: "head-10",
        ciState: ci.ciState ?? null,
        ciHeadSha: ci.ciHeadSha ?? null,
        ciFailureNames: ci.ciFailureNames ?? [],
        createdAt: NOW,
        closedAt: null,
        mergedAt: null,
      },
    ],
  };
}
