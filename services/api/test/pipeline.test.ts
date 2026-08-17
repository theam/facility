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
      classifyPipeline(assembly.stories, new Set(), NOW.getTime()).get("validating")?.[0],
    ).toMatchObject({
      key: "repo_a:issue:7",
      stageState: "checks_failed",
      ciState: "failure",
    });
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

    expect(staged.get("validating")?.map((story) => [story.number, story.stageState])).toEqual([
      [11, "checks_failed"],
      [10, "checks_running"],
    ]);
    expect(staged.get("review")?.map((story) => [story.number, story.stageState])).toEqual([
      [12, "awaiting_review"],
    ]);
    expect(
      staged.get("building")?.map((story) => [story.number, story.runState, story.stageState]),
    ).toEqual([[2, "live", "in_progress"]]);
    expect(
      staged.get("planning")?.map((story) => [story.number, story.runState, story.stageState]),
    ).toEqual([[3, "failed", "failed"]]);
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
    expect(staged.get("validating")?.find((story) => story.number === 2)).toMatchObject({
      stageState: "checks_failed",
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
    expect(staged.get("building")?.[0]?.stageState).toBe("draft_pr");
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
    expect(staged.get("backlog")?.find((story) => story.number === 40)?.stageState).toBe(
      "needs_attention",
    );
    expect(staged.get("review")?.find((story) => story.number === 41)?.stageState).toBe(
      "awaiting_review",
    );
  });

  it("keeps planning work together while exposing its actionable state", () => {
    const live = {
      ...storyWith({}),
      key: "repo_a:issue:50",
      number: 50,
      prs: [],
      linkedRuns: [run("run_50", "alice", "alpha", 50, "architect", "running")],
    };
    const awaitingReview = {
      ...storyWith({}),
      key: "repo_a:issue:51",
      number: 51,
      prs: [],
      linkedRuns: [run("run_51", "alice", "alpha", 51, "architect", "succeeded")],
    };
    const readyToBuild = {
      ...storyWith({}),
      key: "repo_a:issue:52",
      number: 52,
      prs: [],
      linkedRuns: [run("run_52", "alice", "alpha", 52, "architect", "succeeded")],
    };
    const failed = {
      ...storyWith({}),
      key: "repo_a:issue:53",
      number: 53,
      prs: [],
      linkedRuns: [run("run_53", "alice", "alpha", 53, "architect", "failed")],
    };

    const staged = classifyPipeline(
      [live, awaitingReview, readyToBuild, failed],
      new Set([awaitingReview.key]),
      NOW.getTime(),
    );

    expect(staged.get("planning")?.map((story) => [story.number, story.stageState])).toEqual([
      [53, "failed"],
      [52, "ready_to_build"],
      [51, "needs_review"],
      [50, "in_progress"],
    ]);
    expect(PIPELINE_STAGES.map((stage) => stage.key)).toEqual([
      "backlog",
      "planning",
      "building",
      "validating",
      "review",
      "shipped",
    ]);
  });

  it("orders active stages by the mirrored WSJF judgement, immune to activity bumps", () => {
    const hour = 60 * 60 * 1000;
    const scoredHigh = issue("repo_a", 1, {
      bodyMd: valueBody({ value: 8, time: 5, risk: 3, effort: 2 }), // score 8
      ghUpdatedAt: new Date(NOW.getTime() - 72 * hour), // stale activity must not demote it
    });
    const scoredLow = issue("repo_a", 2, {
      bodyMd: valueBody({ value: 2, time: 1, risk: 1, effort: 2 }), // score 2
      ghUpdatedAt: NOW, // touched just now — a comment must not promote it
    });
    const unscoredNew = issue("repo_a", 3, {
      ghCreatedAt: new Date(NOW.getTime() - 2 * hour),
      ghUpdatedAt: new Date(NOW.getTime() - 2 * hour),
    });
    const unscoredOldButTouched = issue("repo_a", 4, {
      ghCreatedAt: new Date(NOW.getTime() - 48 * hour),
      ghUpdatedAt: NOW, // freshly commented, but arrival order still governs unscored
    });
    const malformed = issue("repo_a", 5, {
      bodyMd: "## Value\n\n```json\nnot json\n```",
      ghCreatedAt: new Date(NOW.getTime() - 96 * hour),
      ghUpdatedAt: new Date(NOW.getTime() - 96 * hour),
    });

    const assembly = assemblePipelineStories({
      issues: [scoredLow, unscoredOldButTouched, malformed, scoredHigh, unscoredNew],
      pullRequests: [],
      repos: [{ id: "repo_a", owner: "alice", name: "alpha" }],
      runs: [],
    });
    const backlog = classifyPipeline(assembly.stories, new Set(), NOW.getTime()).get("backlog");

    expect(backlog?.map((story) => story.number)).toEqual([1, 2, 3, 4, 5]);
    expect(backlog?.[0]?.wsjf).toEqual({ value: 8, time: 5, risk: 3, effort: 2, score: 8 });
    expect(backlog?.slice(2).every((story) => story.wsjf === null)).toBe(true);
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
    expect(shipped?.every((story) => story.stageState === "shipped_recently")).toBe(true);
  });
});

function issue(
  repoId: string,
  number: number,
  overrides: Partial<PipelineIssueRecord> = {},
): PipelineIssueRecord {
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
    bodyMd: null,
    commentsCount: 0,
    ghCreatedAt: NOW,
    ghUpdatedAt: NOW,
    closedAt: null,
    ...overrides,
  };
}

function valueBody(wsjf: { value: number; time: number; risk: number; effort: number }) {
  return `Task body.

## Value

\`\`\`json
${JSON.stringify(wsjf, null, 2)}
\`\`\`

## KB trace

- task: pot_1
`;
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
    wsjf: null,
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
        closingIssues: [],
      },
    ],
  };
}
