import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReviewContextPanel, requestProposalReviewContext } from "@/components/inbox/proposal-card";
import type { ProposalReviewContext } from "@/lib/api";

type ReviewContext = ProposalReviewContext["reviewContext"];

const common = {
  version: 1 as const,
  source: "facility_web" as const,
  repository: { id: "repo_1", owner: "theam", name: "facility" },
  branch: "main",
  planBaseSha: "a".repeat(40),
  planSha256: "b".repeat(64),
  presentedAt: "2026-08-31T08:00:00.000Z",
};

function render(context: ReviewContext) {
  return renderToStaticMarkup(createElement(ReviewContextPanel, { context }));
}

describe("proposal review context", () => {
  it("does not advertise an empty JSON body when requesting review evidence", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ reviewContextSeq: 2, reviewContext: {} }),
    ) as typeof fetch;

    await requestProposalReviewContext("prop_1", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/proposals/prop_1/review-context", {
      method: "POST",
    });
  });

  it("renders the exact repository state shown for an available review", () => {
    const html = render({
      ...common,
      status: "available",
      presentedBaseSha: "c".repeat(40),
      issueRevisionSha256: "d".repeat(64),
      comparison: {
        status: "ahead",
        aheadBy: 14,
        behindBy: 0,
        changedPaths: ["services/api/src/app.ts", "apps/web/app/page.tsx"],
        changedPathsTruncated: false,
      },
    });

    expect(html).toContain("Repository: theam/facility");
    expect(html).toContain("Branch: main");
    expect(html).toContain(`Plan based on: ${"a".repeat(12)}`);
    expect(html).toContain(`Currently presented: ${"c".repeat(12)}`);
    expect(html).toContain("Drift: 14 commits ahead, 0 behind, 2 changed paths");
    expect(html).toContain("services/api/src/app.ts");
  });

  it("renders a stable reason and no invented SHA when evidence is unavailable", () => {
    const html = render({
      ...common,
      status: "unavailable",
      reason: "github_evidence_unavailable",
    });

    expect(html).toContain("Currently presented: unavailable");
    expect(html).toContain("Evidence unavailable: github_evidence_unavailable");
    expect(html).not.toContain(`Currently presented: ${"a".repeat(12)}`);
  });
});
