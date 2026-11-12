import {
  type DeliveryReviewResult,
  type ReviewCandidate,
  type ReviewFinding,
  StoryWorkflowPolicySchema,
} from "@facility/core";
import { describe, expect, it, vi } from "vitest";
import {
  blocksDelivery,
  deliveryHeadsFromOutput,
  readReviewResult,
  reviewDecision,
  reviewResultJson,
  transientGithubFailure,
} from "../src/stories/review-cycle-rules.js";

const candidate: ReviewCandidate = {
  id: "c".repeat(64),
  deliveryRevision: "d".repeat(64),
  scopeRevision: 1,
  preview: null,
  pullRequests: [
    {
      repository: "example/app",
      number: 4,
      repositoryId: "repo_1",
      primary: true,
      url: "https://github.com/example/app/pull/4",
      baseRef: "main",
      baseSha: "b".repeat(40),
      headRef: "story",
      headSha: "a".repeat(40),
      changedFiles: 1,
      checks: {
        state: "success",
        headSha: "a".repeat(40),
        observedAt: "2026-01-01T00:00:00Z",
        runs: [],
      },
    },
  ],
};
const finding: ReviewFinding = {
  id: "f-1",
  priority: "P2",
  category: "data",
  requirement: "retained-data",
  repository: "example/app",
  number: 4,
  path: "src/adapter.ts",
  line: 3,
  disposition: "open",
  correction: "within_plan",
  impact: "Existing data becomes unreadable.",
  evidence: "Old rows can have a null status.",
  fix: "Read null as pending.",
};
const report: DeliveryReviewResult = {
  candidateId: candidate.id,
  reviewedPulls: candidate.pullRequests.map(({ repository, number, baseSha, headSha }) => ({
    repository,
    number,
    baseSha,
    headSha,
  })),
  acceptance: [
    {
      id: "retained-data",
      criterion: "Existing data is readable",
      state: "violated",
      evidence: "Read path rejects a legacy value.",
    },
  ],
  findings: [finding],
  missingEvidence: [],
};

describe("bounded review contract", () => {
  it("preserves disabled policies and requires existing plan, failure and acceptance gates when opted in", () => {
    expect(StoryWorkflowPolicySchema.parse({})).not.toHaveProperty("reviewCycle");
    const reviewCycle = {
      builderAgent: "builder",
      reviewerAgent: "pr-reviewer",
      timeoutMinutes: 30,
    };
    expect(StoryWorkflowPolicySchema.safeParse({ reviewCycle }).success).toBe(false);
    expect(
      StoryWorkflowPolicySchema.safeParse({
        reviewCycle,
        planApprovalAgents: ["builder"],
        holdAfterFailure: true,
        requireDeliveryAcceptance: true,
      }).success,
    ).toBe(true);
  });

  it("requires one unique Builder declaration with full commit IDs", () => {
    const published = [{ repository: finding.repository, number: 4, headSha: "a".repeat(40) }];
    const marker = `<facility-delivery-heads>${JSON.stringify(published)}</facility-delivery-heads>`;
    expect(deliveryHeadsFromOutput(`Complete\n${marker}`)).toEqual(published);
    expect(deliveryHeadsFromOutput(marker + marker)).toBeNull();
    expect(deliveryHeadsFromOutput(marker.replace("a".repeat(40), "a"))).toBeNull();
  });

  it("applies severity and requires a human decision for scope changes or exhausted rounds", () => {
    expect(blocksDelivery({ ...finding, priority: "P0", category: "suggestion" })).toBe(true);
    expect(blocksDelivery({ ...finding, priority: "P1", category: "suggestion" })).toBe(true);
    expect(blocksDelivery({ ...finding, category: "suggestion" })).toBe(false);
    expect(blocksDelivery({ ...finding, priority: "P3" })).toBe(false);
    expect(reviewDecision(report, 1).phase).toBe("correction");
    expect(
      reviewDecision({ ...report, findings: [{ ...finding, correction: "requires_decision" }] }, 1)
        .phase,
    ).toBe("decision_required");
    expect(reviewDecision(report, 2).phase).toBe("decision_required");
  });

  it("rejects stale bases, incomplete PR coverage and disappearing or downgraded blockers", () => {
    expect(readReviewResult(JSON.stringify(report), candidate)).toEqual(report);
    const [pull] = report.reviewedPulls;
    if (!pull) throw new Error("The review fixture has no PR");
    for (const bad of [
      { ...report, reviewedPulls: [{ ...pull, baseSha: "e".repeat(40) }] },
      { ...report, reviewedPulls: [] },
      { ...report, reviewedPulls: [pull, pull] },
      { ...report, findings: [] },
    ])
      expect(() => readReviewResult(JSON.stringify(bad), candidate, report)).toThrow(
        /exact candidate/,
      );
    const rechecked = { ...report, acceptance: [{ ...report.acceptance[0], state: "verified" }] };
    expect(() =>
      readReviewResult(
        JSON.stringify({
          ...rechecked,
          findings: [{ ...finding, category: "suggestion" }],
        }),
        candidate,
        report,
      ),
    ).toThrow(/exact candidate/);
    const resolved = readReviewResult(
      JSON.stringify({
        ...rechecked,
        findings: [{ ...finding, disposition: "resolved" }],
      }),
      candidate,
      report,
    );
    expect(reviewDecision(resolved, 2).phase).toBe("human_review");
  });
});

describe("native read-only review contract", () => {
  it("reads one structured block from a readable final response", () => {
    expect(reviewResultJson('Summary first.\n<facility-review>{"a":1}</facility-review>')).toBe(
      '{"a":1}',
    );
    expect(reviewResultJson('{"a":1}')).toBe('{"a":1}');
    expect(
      reviewResultJson(
        "<facility-review>{}</facility-review><facility-review>{}</facility-review>",
      ),
    ).toBeNull();
  });
});

describe("temporary GitHub failures", () => {
  const failure = (status: number, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error("GitHub request failed"), { status, ...extra });
  it("retries outages, timeouts and rate limits but not missing or invalid evidence", () => {
    expect(transientGithubFailure(failure(503))).toBe(true);
    expect(transientGithubFailure(failure(429))).toBe(true);
    expect(
      transientGithubFailure(
        failure(403, { response: { headers: { "x-ratelimit-remaining": "0" } } }),
      ),
    ).toBe(true);
    expect(transientGithubFailure(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(
      true,
    );
    expect(transientGithubFailure(Object.assign(new Error("late"), { name: "TimeoutError" }))).toBe(
      true,
    );
    expect(transientGithubFailure(Object.assign(new Error("deadline"), { statusCode: 503 }))).toBe(
      true,
    );
    expect(transientGithubFailure(failure(404))).toBe(false);
    expect(transientGithubFailure(failure(403))).toBe(false);
    expect(transientGithubFailure(failure(422))).toBe(false);
    expect(transientGithubFailure(new Error("unexpected shape"))).toBe(false);
  });
});
