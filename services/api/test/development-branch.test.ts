import { describe, expect, it } from "vitest";
import {
  configurationBranch,
  DevelopmentBranchSchema,
  projectDevelopmentBranch,
} from "../src/github/development-branch.js";

describe("project development branch", () => {
  it("retains legacy proposal heads and separates development sources, including names that slugify alike", () => {
    const prefix = "facility/kickstart-0.12";
    expect(configurationBranch(prefix, "main", "main")).toBe(prefix);
    const heads = ["develop", "team/dev", "team-dev"].map((branch) =>
      configurationBranch(prefix, branch, "main"),
    );
    expect(new Set(heads).size).toBe(3);
    expect(heads.every((head) => DevelopmentBranchSchema.safeParse(head).success)).toBe(true);
  });
  it("falls back only when unset, including legacy settings", () => {
    for (const settings of [{}, { developmentBranch: null }, { default_branch: "develop" }]) {
      expect(projectDevelopmentBranch(settings, "main")).toBe("main");
    }
    expect(projectDevelopmentBranch({ developmentBranch: "develop" }, "main")).toBe("develop");
  });
  it.each([
    "",
    "-develop",
    "refs/heads/develop",
    "develop~1",
    "a..b",
    "a//b",
    ".hidden",
    "a/.hidden",
    "a.lock",
    "a/b.lock",
    "@",
    "dev\nmain",
    "a\\b",
    "a/",
    "a.",
  ])("rejects %j", (branch) => {
    expect(DevelopmentBranchSchema.safeParse(branch).success).toBe(false);
    expect(() => projectDevelopmentBranch({ developmentBranch: branch }, "main")).toThrow();
  });
  it.each([
    "main",
    "dev",
    "develop",
    "release/next",
    "team-1/integration",
  ])("accepts %s", (branch) => {
    expect(DevelopmentBranchSchema.parse(branch)).toBe(branch);
  });
});
