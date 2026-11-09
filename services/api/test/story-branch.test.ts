import { describe, expect, it } from "vitest";
import { observedStoryBranch } from "../src/stories/branch.js";

describe("verified story branch changes", () => {
  const story = { branch: "facility/story", pullRequestNumber: null, status: "working" };
  const evidence = {
    initialBranch: "facility/story",
    finalBranch: "chore/story",
    captureError: null,
    completedAt: new Date(),
  };
  it("follows the branch recorded after a completed workspace turn", () => {
    expect(observedStoryBranch(story, evidence, "main")).toBe("chore/story");
  });
  it("protects the development branch as well as the GitHub default", () => {
    for (const finalBranch of ["main", "develop"]) {
      expect(
        observedStoryBranch(story, { ...evidence, finalBranch }, "main", "develop"),
      ).toBeNull();
    }
    expect(observedStoryBranch(story, evidence, "main", "develop")).toBe("chore/story");
  });
  it.each([
    ["an existing PR", { ...story, pullRequestNumber: 42 }],
    ["a concurrent branch change", { ...story, branch: "fix/other" }],
    ["an unassigned branch", { ...story, branch: null }],
    ["a completed story", { ...story, status: "done" }],
    ["an archived story", { ...story, status: "archived" }],
  ])("preserves %s", (_name, input) => {
    expect(observedStoryBranch(input, evidence, "main")).toBeNull();
  });
  it.each([
    ["failed capture", { ...evidence, captureError: "git failed" }],
    ["incomplete capture", { ...evidence, completedAt: null }],
    ["detached HEAD", { ...evidence, finalBranch: null }],
    ["an internal preview branch", { ...evidence, finalBranch: "facility/preview/local" }],
    ["the repository default", { ...evidence, finalBranch: "main" }],
    ["the original branch", { ...evidence, finalBranch: story.branch }],
    ["an option-like branch", { ...evidence, finalBranch: "--force" }],
    ["a malformed branch", { ...evidence, finalBranch: "chore/../other" }],
    ["control characters", { ...evidence, finalBranch: "chore/story\nother" }],
    ["the wrong initial branch", { ...evidence, initialBranch: "fix/other" }],
  ])("rejects %s", (_name, input) => {
    expect(observedStoryBranch(story, input, "main")).toBeNull();
  });
});
