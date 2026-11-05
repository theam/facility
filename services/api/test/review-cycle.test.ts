import {
  type DeliveryReviewResult,
  type ReviewCandidate,
  type ReviewFinding,
  StoryWorkflowPolicySchema,
} from "@facility/core";
import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";
import { callConsultationProvider } from "../src/stories/consultation-provider.js";
import {
  blocksDelivery,
  checkReviewBudget,
  deliveryHeadsFromOutput,
  readReviewResult,
  reviewDecision,
} from "../src/stories/review-cycle-rules.js";
import { dockerReviewSandbox } from "../src/workspaces/review-sandbox.js";

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
      maxCostCents: 100,
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

  it("rejects an unknown or unaffordable reservation", () => {
    expect(() => checkReviewBudget(1, 2, 3)).not.toThrow();
    expect(() => checkReviewBudget(1.1, 2, 3)).toThrow(/cost limit/);
    expect(() => checkReviewBudget(null, 2, 3)).toThrow(/unconfirmed/);
    expect(() => checkReviewBudget(0, null, 3)).toThrow(/unconfirmed/);
  });
});

describe("isolated review execution", () => {
  it("sends a text-only provider request without tools or a workspace capability", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools).toEqual([]);
      expect(body.system).toMatch(/no tools or ability to change files/);
      expect(body).not.toHaveProperty("workspace");
      return Response.json({
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "{}" }],
        usage: { input_tokens: 50, output_tokens: 10 },
      });
    });
    await expect(
      callConsultationProvider(
        {
          provider: "anthropic",
          model: "claude-sonnet-5",
          apiKey: "synthetic-fixture-key",
          prompt: "Verify the synthetic result.",
          purpose: "delivery_review",
        },
        fetch,
      ),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("passes only pinned files and a fixed command to a disposable networkless container", async () => {
    const container = {
      start: vi.fn(async () => undefined),
      wait: vi.fn(async () => ({ StatusCode: 0 })),
      logs: vi.fn(async () =>
        Buffer.from('facility-review-result:{"exitCode":0,"output":"verified"}'),
      ),
      kill: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const createContainer = vi.fn(async (_options: Docker.ContainerCreateOptions) => container);
    const run = dockerReviewSandbox("fixture-node-image", { createContainer } as unknown as Docker);
    const argv = ["node", "example/app/check.js"];
    const files = [{ path: "example/app/check.js", text: "process.exit(0);" }];
    await expect(run(argv, files, AbortSignal.timeout(1_000))).resolves.toEqual({
      exitCode: 0,
      output: "verified",
    });
    const [options] = createContainer.mock.calls[0] ?? [];
    if (!options) throw new Error("The sandbox did not create a container");
    expect(options).toMatchObject({
      Entrypoint: ["node", "-e"],
      User: "65534:65534",
      NetworkDisabled: true,
      Env: ["HOME=/tmp"],
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
      },
    });
    expect(options.HostConfig?.Mounts).toBeUndefined();
    expect(options.HostConfig?.Binds).toBeUndefined();
    expect(options.HostConfig?.Privileged).toBeUndefined();
    expect(JSON.parse(options.Cmd?.[1] ?? "")).toEqual({ argv, files });
    expect(container.remove).toHaveBeenCalledOnce();
    await expect(
      run(argv, [{ path: "large.js", text: "a".repeat(70_000) }], AbortSignal.timeout(1_000)),
    ).rejects.toThrow(/limit/);
    expect(createContainer).toHaveBeenCalledOnce();
  });
});
