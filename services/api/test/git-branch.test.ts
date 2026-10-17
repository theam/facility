import { describe, expect, it } from "vitest";
import { isSafeGitBranch } from "../src/workspaces/git-branch.js";

describe("isSafeGitBranch", () => {
  it("accepts ordinary refs and hostile-but-valid Git names", () => {
    expect(isSafeGitBranch("main")).toBe(true);
    expect(isSafeGitBranch("release/2026")).toBe(true);
    expect(isSafeGitBranch("$(id)")).toBe(true);
    expect(isSafeGitBranch('foo"bar')).toBe(true);
  });

  it("rejects refs that become git revision syntax or control characters", () => {
    expect(isSafeGitBranch("foo..bar")).toBe(false);
    expect(isSafeGitBranch("foo@{upstream}")).toBe(false);
    expect(isSafeGitBranch("-force")).toBe(false);
    expect(isSafeGitBranch("chore/../other")).toBe(false);
    expect(isSafeGitBranch("main\nother")).toBe(false);
    expect(isSafeGitBranch("")).toBe(false);
  });
});
