import { describe, expect, it } from "vitest";
import type { GitHubReference } from "@/components/markdown";
import { createStoryReferenceLink } from "@/lib/story-reference";

const currentStory = {
  number: 98,
  repoId: "repo_facility",
  repoOwner: "theam",
  repoName: "facility",
  prs: [{ number: 140 }],
};

const siblingStory = {
  number: 12,
  repoId: "repo_docs",
  repoOwner: "theam",
  repoName: "docs",
  prs: [{ number: 21 }],
};

function reference(fields: Partial<GitHubReference> = {}): GitHubReference {
  return {
    owner: null,
    repo: null,
    number: 98,
    githubUrl: null,
    ...fields,
  };
}

describe("story reference links", () => {
  const linkReference = createStoryReferenceLink({
    projectId: "proj_1",
    currentStory,
    stories: [siblingStory],
  });

  it("opens a same-repository reference inside Facility", () => {
    expect(linkReference(reference())).toBe("/projects/proj_1/stories/98?repoId=repo_facility");
  });

  it("maps a linked PR number to its owning Facility story", () => {
    expect(linkReference(reference({ number: 140 }))).toBe(
      "/projects/proj_1/stories/98?repoId=repo_facility",
    );
  });

  it("resolves a connected repository case-insensitively", () => {
    expect(
      linkReference(
        reference({
          owner: "THEAM",
          repo: "DOCS",
          number: 21,
          githubUrl: "https://github.com/THEAM/DOCS/pull/21",
        }),
      ),
    ).toBe("/projects/proj_1/stories/12?repoId=repo_docs");
  });

  it("falls back to GitHub for an unknown qualified reference", () => {
    expect(
      linkReference(
        reference({
          owner: "someone",
          repo: "elsewhere",
          number: 7,
          githubUrl: "https://github.com/someone/elsewhere/pull/7",
        }),
      ),
    ).toBe("https://github.com/someone/elsewhere/pull/7");
  });

  it("falls back to the current GitHub repository for an unknown local reference", () => {
    expect(linkReference(reference({ number: 404 }))).toBe(
      "https://github.com/theam/facility/issues/404",
    );
  });
});
