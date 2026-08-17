import { describe, expect, it } from "vitest";
import { ciStatusLabel } from "@/components/ci-status";
import type { PipelineStageKey, PipelineStory, Proposal, StoryDetail } from "@/lib/api";
import {
  avatarInitial,
  avatarUrlFor,
  boardHref,
  mineFilterOn,
  ownedBy,
  reviewablePullRequests,
  storyHref,
  storyOwner,
} from "@/lib/pipeline";
import { deriveStoryTimeline, proposalsForStory } from "@/lib/story";

describe("story presentation contract", () => {
  it("uses the established CI grammar for green and named failures", () => {
    expect(ciStatusLabel("success")).toBe("checks · passed");
    expect(ciStatusLabel("failure", ["guards", "typecheck"])).toBe(
      "checks · failed · guards, typecheck",
    );
  });

  it("keeps repository and story kind in every detail link", () => {
    expect(
      storyHref("project-1", {
        number: 17,
        repoId: "repo-2",
        storyType: "pull_request",
      } as PipelineStory),
    ).toBe("/projects/project-1/stories/17?repoId=repo-2&storyType=pull_request");
  });

  it("renders human-created mirrored PRs without requiring a Facility run or outcome", () => {
    const detail = storyDetail();
    detail.prs = [
      {
        number: 22,
        title: "Human-created PR",
        url: "https://github.test/octo/repo/pull/22",
        state: "merged",
        draft: false,
        headSha: "head-22",
        ciState: "pending",
        ciHeadSha: "head-22",
        ciFailureNames: [],
        closingIssues: [17],
        createdAt: "2026-08-02T00:00:00Z",
        closedAt: "2026-08-03T00:00:00Z",
        mergedAt: "2026-08-03T00:00:00Z",
      },
    ];
    const timeline = deriveStoryTimeline({
      detail,
      proposals: [],
      outcomes: [],
      comments: [],
      prs: [
        {
          number: 22,
          title: "Human-created PR",
          bodyMd: "Closes #17",
          author: "ada",
          url: "https://github.test/octo/repo/pull/22",
          state: "merged",
          draft: false,
          createdAt: "2026-08-02T00:00:00Z",
          closedAt: "2026-08-03T00:00:00Z",
          mergedAt: "2026-08-03T00:00:00Z",
          ciState: "pending",
          ciFailureNames: [],
        },
      ],
      allowLegacyProposalNumber: true,
      stageLabels: new Map<PipelineStageKey, string>([
        ["validating", "Validating"],
        ["shipped", "Shipped"],
      ]),
    });

    expect(timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "pr_opened", outcome: null }),
        expect.objectContaining({ kind: "pr_closed", outcome: null }),
        expect.objectContaining({ kind: "stage", stage: "validating", label: "Validating" }),
        expect.objectContaining({ kind: "stage", stage: "shipped", label: "Shipped" }),
      ]),
    );
  });

  it("does not replay stale-head CI as a timeline stage", () => {
    const detail = storyDetail();
    detail.prs = [
      {
        number: 23,
        title: "Updated PR",
        url: "https://github.test/octo/repo/pull/23",
        state: "open",
        draft: false,
        headSha: "new-head",
        ciState: "pending",
        ciHeadSha: "old-head",
        ciFailureNames: [],
        closingIssues: [],
        createdAt: "2026-08-02T00:00:00Z",
        closedAt: null,
        mergedAt: null,
      },
    ];
    const timeline = deriveStoryTimeline({
      detail,
      proposals: [],
      outcomes: [],
      comments: [],
      prs: [
        {
          number: 23,
          title: "Updated PR",
          bodyMd: "Body",
          author: "ada",
          url: "https://github.test/octo/repo/pull/23",
          state: "open",
          draft: false,
          createdAt: "2026-08-02T00:00:00Z",
          closedAt: null,
          mergedAt: null,
          ciState: "pending",
          ciFailureNames: [],
        },
      ],
      allowLegacyProposalNumber: true,
      stageLabels: new Map([["validating", "Validating"]]),
    });

    expect(timeline).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "stage", stage: "validating" })]),
    );
  });

  it("falls back to detail PRs and replays draft work as building", () => {
    const detail = storyDetail();
    detail.prs = [pipelinePull(24, { draft: true })];
    const timeline = deriveStoryTimeline({
      detail,
      proposals: [],
      outcomes: [],
      comments: [],
      prs: undefined,
      allowLegacyProposalNumber: true,
      stageLabels: new Map([["building", "Building"]]),
    });

    expect(timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "pr_opened", outcome: null }),
        expect.objectContaining({ kind: "stage", stage: "building", label: "Building" }),
      ]),
    );
    expect(timeline).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "stage", stage: "review" })]),
    );
  });

  it("replays every stored CI rollup transition with failed check detail", () => {
    const detail = storyDetail();
    detail.prs = [
      pipelinePull(25, {
        ciState: "failure",
        ciHeadSha: "head-25",
        ciFailureNames: ["guards", "typecheck"],
      }),
    ];
    const timeline = deriveStoryTimeline({
      detail,
      proposals: [],
      outcomes: [],
      prs: undefined,
      ciEvents: [
        {
          id: "cie-pending",
          pullNumber: 25,
          headSha: "head-25",
          state: "pending",
          failureNames: [],
          observedAt: "2026-08-02T00:01:00Z",
        },
        {
          id: "cie-success",
          pullNumber: 25,
          headSha: "head-25",
          state: "success",
          failureNames: [],
          observedAt: "2026-08-02T00:02:00Z",
        },
        {
          id: "cie-failure",
          pullNumber: 25,
          headSha: "head-25",
          state: "failure",
          failureNames: ["guards", "typecheck"],
          observedAt: "2026-08-02T00:03:00Z",
        },
      ],
      allowLegacyProposalNumber: true,
      stageLabels: new Map([
        ["review", "In review"],
        ["validating", "Validating"],
      ]),
    });

    expect(
      timeline
        .filter((item) => item.kind === "ci")
        .map((item) => [item.event.state, item.event.failureNames]),
    ).toEqual([
      ["pending", []],
      ["success", []],
      ["failure", ["guards", "typecheck"]],
    ]);
    expect(timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "stage", stage: "validating" }),
        expect.objectContaining({ kind: "stage", stage: "review" }),
      ]),
    );
  });

  it("uses legacy number-only proposals only when that number is unambiguous", () => {
    const proposal = {
      id: "proposal-1",
      payload: { issueNumber: 17 },
    } as unknown as Proposal;
    expect(proposalsForStory([proposal], storyDetail(), false)).toEqual([]);
    expect(proposalsForStory([proposal], storyDetail(), true)).toEqual([proposal]);
  });

  it("uses the originating run to qualify legacy proposals in multi-repo projects", () => {
    const detail = storyDetail();
    detail.runs = [
      {
        id: "run-17",
        mode: "architect",
        engine: "codex",
        status: "succeeded",
        startedAt: null,
        endedAt: null,
        receipt: null,
        triggeredBy: "ada",
      },
    ];
    const proposal = {
      id: "proposal-run-linked",
      runId: "run-17",
      payload: { issueNumber: 17 },
    } as unknown as Proposal;
    expect(proposalsForStory([proposal], detail, false)).toEqual([proposal]);
  });

  it("keeps run-linked human gates on pull-request stories", () => {
    const detail = storyDetail();
    detail.key = "repo-1:pull_request:22";
    detail.storyType = "pull_request";
    detail.number = 22;
    detail.runs = [
      {
        id: "run-pr-22",
        mode: "architect",
        engine: "codex",
        status: "succeeded",
        startedAt: null,
        endedAt: null,
        receipt: null,
        triggeredBy: "ada",
      },
    ];
    const linked = {
      id: "proposal-pr-run",
      runId: "run-pr-22",
      payload: { issueNumber: 999 },
    } as unknown as Proposal;
    const unrelated = {
      id: "proposal-pr-number",
      payload: { issueNumber: 22, repoId: "repo-1" },
    } as unknown as Proposal;

    expect(proposalsForStory([linked, unrelated], detail, false)).toEqual([linked]);
  });

  it("names no owner for an unassigned story", () => {
    expect(storyOwner([])).toBeNull();
  });

  it("names the sole assignee with nothing left over", () => {
    expect(storyOwner(["a"])).toEqual({ login: "a", extra: 0 });
  });

  it("counts the remaining assignees past the first", () => {
    expect(storyOwner(["a", "b", "c"])).toEqual({ login: "a", extra: 2 });
  });

  it("keeps GitHub's assignee order rather than sorting it", () => {
    expect(storyOwner(["zoe", "adam"])).toEqual({ login: "zoe", extra: 1 });
  });

  it("drops empty and blank assignees before naming an owner", () => {
    expect(storyOwner(["", " ", "a"])).toEqual({ login: "a", extra: 0 });
  });

  it("trims whitespace around an assignee's login", () => {
    expect(storyOwner(["  a  "])).toEqual({ login: "a", extra: 0 });
  });

  it("builds a GitHub avatar URL from a login, at twice the drawn size", () => {
    expect(avatarUrlFor("octocat")).toBe("https://github.com/octocat.png?size=40");
  });

  it("trims a login before building its avatar URL", () => {
    expect(avatarUrlFor("  octocat  ")).toBe("https://github.com/octocat.png?size=40");
  });

  it("escapes a login rather than letting it shape the avatar URL", () => {
    expect(avatarUrlFor("a/b?c")).toBe("https://github.com/a%2Fb%3Fc.png?size=40");
  });

  it("has no avatar URL to offer for a blank login", () => {
    expect(avatarUrlFor("")).toBeNull();
    expect(avatarUrlFor("   ")).toBeNull();
  });

  it("falls back to the first letter of a login, uppercased", () => {
    expect(avatarInitial("octocat")).toBe("O");
    expect(avatarInitial("Octocat")).toBe("O");
  });

  it("falls back to the first letter of an email when there is no login", () => {
    expect(avatarInitial("ada@example.test")).toBe("A");
  });

  it("keeps an astral first character whole in the fallback", () => {
    expect(avatarInitial("😀nn")).toBe("😀");
  });

  it("shows a question mark rather than an empty box when there is nothing to draw", () => {
    expect(avatarInitial("")).toBe("?");
    expect(avatarInitial("   ")).toBe("?");
    expect(avatarInitial(null)).toBe("?");
    expect(avatarInitial(undefined)).toBe("?");
  });

  it("does not count draft pull requests as waiting for human review", () => {
    const story = storyDetail();
    story.prs = [
      pipelinePull(21, { draft: true }),
      pipelinePull(22),
      pipelinePull(23, { state: "closed" }),
    ];

    expect(reviewablePullRequests([story]).map(({ pull }) => pull.number)).toEqual([22]);
  });

  it("never counts a story as owned when the viewer has no GitHub login", () => {
    expect(ownedBy(["alice"], undefined)).toBe(false);
    expect(ownedBy([], undefined)).toBe(false);
  });

  it("matches an assignee to the viewer's login regardless of case", () => {
    expect(ownedBy(["Alice"], "alice")).toBe(true);
  });

  it("finds no owner in an empty assignee list", () => {
    expect(ownedBy([], "alice")).toBe(false);
  });

  it("does not match an assignee who isn't the viewer", () => {
    expect(ownedBy(["bob"], "alice")).toBe(false);
  });

  it("builds a mine-only board link with no other filters", () => {
    expect(boardHref("project-1", { mine: true })).toBe("/projects/project-1/stories?mine=1");
  });

  it("combines the stage and mine filters in one board link", () => {
    expect(boardHref("project-1", { stage: "backlog", mine: true })).toBe(
      "/projects/project-1/stories?stage=backlog&mine=1",
    );
  });

  it("omits the mine key entirely when mine is off", () => {
    expect(boardHref("project-1", { mine: false })).toBe("/projects/project-1/stories");
  });

  it("keeps mine on when the all chip clears the stage", () => {
    expect(boardHref("project-1", { stage: "backlog", status: "ready_to_plan", mine: true })).toBe(
      "/projects/project-1/stories?stage=backlog&status=ready_to_plan&mine=1",
    );
    expect(boardHref("project-1", { mine: true })).toBe("/projects/project-1/stories?mine=1");
  });

  it("turns the mine filter on only when the viewer has a GitHub login to match against", () => {
    expect(mineFilterOn("1", "alice")).toBe(true);
    expect(mineFilterOn("1", undefined)).toBe(false);
    expect(mineFilterOn(undefined, "alice")).toBe(false);
    expect(mineFilterOn(undefined, undefined)).toBe(false);
  });

  it("recovers a login-less viewer who arrives with ?mine=1 already in the URL", () => {
    // A shared link, bookmark, or browser history can carry `mine=1` for a
    // viewer with no GitHub login. The derived flag must stay off so the
    // board renders normally and the all chip offers a clean way out.
    const mineOn = mineFilterOn("1", undefined);
    expect(mineOn).toBe(false);
    expect(boardHref("project-1", { mine: mineOn })).toBe("/projects/project-1/stories");
  });
});

function pipelinePull(
  number: number,
  overrides: Partial<StoryDetail["prs"][number]> = {},
): StoryDetail["prs"][number] {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.test/octo/repo/pull/${number}`,
    state: "open",
    draft: false,
    headSha: `head-${number}`,
    ciState: null,
    ciHeadSha: null,
    ciFailureNames: [],
    closingIssues: [],
    createdAt: "2026-08-02T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    ...overrides,
  };
}

function storyDetail(): StoryDetail {
  return {
    key: "repo-1:issue:17",
    id: "ghi-17",
    storyType: "issue",
    repoId: "repo-1",
    repoOwner: "octo",
    repoName: "repo",
    number: 17,
    title: "Story",
    state: "open",
    labels: [],
    assignees: [],
    author: "grace",
    htmlUrl: "https://github.test/octo/repo/issues/17",
    bodyMd: "Body",
    commentsCount: 0,
    ghCreatedAt: "2026-08-01T00:00:00Z",
    ghUpdatedAt: "2026-08-01T00:00:00Z",
    closedAt: null,
    prs: [],
    ciState: null,
    ciUrl: null,
    ciFailureNames: [],
    stage: { key: "backlog", label: "Backlog" },
    pipelineStages: [
      { key: "backlog", label: "Backlog" },
      { key: "planning", label: "Planning" },
      { key: "building", label: "Building" },
      { key: "validating", label: "Validating" },
      { key: "review", label: "In review" },
      { key: "shipped", label: "Shipped" },
    ],
    allowLegacyProposalNumber: true,
    runs: [],
  };
}
