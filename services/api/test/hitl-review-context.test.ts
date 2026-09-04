import { describe, expect, it } from "vitest";
import { FacilityGithubClient } from "../src/github/client.js";
import { ReviewContextV1Schema, renderReviewContextMarkdown } from "../src/hitl-review-context.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const PLAN_SHA = "c".repeat(64);
const ISSUE_SHA = "d".repeat(64);

describe("decision-time review context", () => {
  it("renders the same available evidence used by Web and GitHub", () => {
    const context = ReviewContextV1Schema.parse({
      version: 1,
      source: "github_plan_comment",
      status: "available",
      repository: { id: "repo_1", owner: "theam", name: "facility" },
      branch: "main",
      planBaseSha: SHA_A,
      planSha256: PLAN_SHA,
      presentedBaseSha: SHA_B,
      issueRevisionSha256: ISSUE_SHA,
      presentedAt: "2026-08-31T00:00:00.000Z",
      comparison: {
        status: "ahead",
        aheadBy: 14,
        behindBy: 0,
        changedPaths: ["services/api/src/routes/v1/hitl.ts", "apps/web/page.tsx"],
        changedPathsTruncated: false,
      },
    });

    expect(renderReviewContextMarkdown(context)).toContain("Repository:** `theam/facility`");
    expect(renderReviewContextMarkdown(context)).toContain("Currently presented:** `bbbbbbbbbbbb`");
    expect(renderReviewContextMarkdown(context)).toContain(
      "14 commits ahead, 0 behind; 2 changed paths",
    );
  });

  it("renders an unavailable snapshot without leaking an internal exception", () => {
    const context = ReviewContextV1Schema.parse({
      version: 1,
      source: "facility_web",
      status: "unavailable",
      repository: null,
      branch: null,
      planBaseSha: SHA_A,
      planSha256: PLAN_SHA,
      presentedAt: "2026-08-31T00:00:00.000Z",
      reason: "github_evidence_unavailable",
    });

    expect(renderReviewContextMarkdown(context)).toContain("Evidence status:** unavailable");
    expect(JSON.stringify(context)).not.toContain("stack");
  });

  it("maps GitHub comparison evidence and marks the 300-path boundary as truncated", async () => {
    const client = new FacilityGithubClient(
      {
        rest: {
          repos: {
            compareCommitsWithBasehead: async () => ({
              data: {
                status: "diverged",
                ahead_by: 3,
                behind_by: 2,
                files: Array.from({ length: 300 }, (_, index) => ({
                  filename: `path-${index}.ts`,
                })),
              },
            }),
          },
        },
      } as never,
      { owner: "theam", repo: "facility", defaultBranch: "main" },
    );

    await expect(client.compareCommits(SHA_A, SHA_B)).resolves.toMatchObject({
      status: "diverged",
      aheadBy: 3,
      behindBy: 2,
      changedPathsTruncated: true,
    });
  });
});
