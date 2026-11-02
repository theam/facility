import { describe, expect, it } from "vitest";
import { indexPullRequests } from "../src/stories/pull-index.js";

const pulls = [
  {
    key: "repo-a:41",
    repositoryId: "repo-a",
    number: 41,
    headRef: "feature/shared",
    closingIssues: [7],
  },
  {
    key: "repo-a:42",
    repositoryId: "repo-a",
    number: 42,
    headRef: "feature/shared",
    closingIssues: [8, 8],
  },
  {
    key: "repo-b:41",
    repositoryId: "repo-b",
    number: 41,
    headRef: "feature/shared",
    closingIssues: [7],
  },
];

describe("backlog pull request index", () => {
  const index = indexPullRequests(pulls);

  it("finds direct, external-id, and branch links once in their original order", () => {
    expect(
      index
        .forStory({
          repositoryId: "repo-a",
          pullRequestNumber: 42,
          externalId: "pull-request:41",
          branch: "feature/shared",
        })
        .map((pull) => pull.key),
    ).toEqual(["repo-a:41", "repo-a:42"]);
  });

  it("looks up closing pull requests by repository and issue number", () => {
    expect(index.forIssue({ repositoryId: "repo-a", number: 8 }).map((pull) => pull.key)).toEqual([
      "repo-a:42",
    ]);
    expect(index.forIssue({ repositoryId: "repo-b", number: 8 })).toEqual([]);
    expect(
      index
        .forStory({
          repositoryId: null,
          pullRequestNumber: null,
          externalId: "manual:key",
          branch: null,
        })
        .map((pull) => pull.key),
    ).toEqual([]);
  });
});
