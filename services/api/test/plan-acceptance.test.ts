import { describe, expect, it } from "vitest";
import {
  githubPlanAcceptanceIssueLockKey,
  PLAN_ACCEPTANCE_PROPOSAL_ID_RE,
} from "../src/github/plan-acceptance.js";
import { resolveSlashCommand } from "../src/github/router.js";

describe("github plan acceptance command binding", () => {
  it("accepts proposal ids in builder slash commands", () => {
    expect(PLAN_ACCEPTANCE_PROPOSAL_ID_RE.test("prop_0194abcd0194abcd0194abcd0194abcd")).toBe(true);
    expect(resolveSlashCommand("/codex-builder prop_0194abcd0194abcd0194abcd0194abcd: go")).toEqual({
      command: "builder",
      agentCommand: "codex-builder",
      proposalId: "prop_0194abcd0194abcd0194abcd0194abcd",
      ambiguous: false,
    });
  });

  it("ignores proposal ids on architect commands", () => {
    expect(resolveSlashCommand("/architect prop_0194abcd0194abcd0194abcd0194abcd")).toEqual({
      command: "architect",
      agentCommand: "architect",
      ambiguous: false,
    });
  });

  it("scopes the Gate 1 advisory lock to org, repo, and issue", () => {
    expect(
      githubPlanAcceptanceIssueLockKey({
        orgId: "org_1",
        repoId: "repo_1",
        issueNumber: 42,
      }),
    ).toBe("architect-plan-issue:org_1:repo_1:42");
  });
});
