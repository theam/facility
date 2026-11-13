import { describe, expect, it } from "vitest";
import { ReviewCycleStatusSchema } from "../src/story-review-cycle.js";
import { StoryWorkflowStatusSchema } from "../src/story-workflow.js";
import fixture from "./fixtures/review-cycle.json";

const workflow = {
  schemaVersion: 1,
  orgId: "org-a",
  projectId: "project-a",
  storyId: "story-a",
  policy: { revision: 1, policy: {} },
  plan: { revision: 4, decisionRevision: 1, status: "approved" },
  queuedAgents: [],
  blockedReason: null,
  acceptance: {
    schemaVersion: 1,
    orgId: "org-a",
    projectId: "project-a",
    storyId: "story-a",
    required: true,
    status: "missing",
    receipt: null,
  },
};
describe("optional recorded review projection", () => {
  it("preserves complete pinned evidence and unknown cost through workflow serialization", () => {
    const raw = { ...workflow, reviewCycle: fixture };
    const parsed = StoryWorkflowStatusSchema.parse(JSON.parse(JSON.stringify(raw)));
    expect(parsed.reviewCycle).toEqual(fixture);
    expect(parsed.reviewCycle?.costCents).toBeNull();
  });
  it("keeps older workflow responses valid without inventing a review cycle", () => {
    expect(StoryWorkflowStatusSchema.parse(workflow)).not.toHaveProperty("reviewCycle");
  });
  it("rejects branch labels and unsafe paths in evidence that claims to identify an exact source", () => {
    const raw = structuredClone(fixture);
    const pull = raw.candidate.pullRequests[0];
    const finding = raw.reviews[0]?.result.findings[0];
    if (!pull || !finding) throw new Error("Missing review fixture");
    pull.headSha = "main";
    expect(ReviewCycleStatusSchema.safeParse(raw).success).toBe(false);
    pull.headSha = "a".repeat(40);
    finding.path = "../../.env";
    expect(ReviewCycleStatusSchema.safeParse(raw).success).toBe(false);
  });
});
