import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ConfirmWorkflowPolicyBody,
  RequestDeliveryAcceptanceBody,
  StoryWorkflowPolicySchema,
} from "../src/story-workflow.js";

describe("story workflow policy", () => {
  it("keeps policy output fields visible to generated API clients", () => {
    const schema = z.toJSONSchema(StoryWorkflowPolicySchema, {
      io: "output",
      unrepresentable: "any",
    });
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        planApprovalAgents: { type: "array", items: { type: "string" } },
        requireDeliveryAcceptance: { type: "boolean" },
      },
    });
  });
  it("preserves existing projects until explicitly enabled", () => {
    expect(StoryWorkflowPolicySchema.parse({})).toEqual({
      planApprovalAgents: [],
      holdAfterFailure: false,
      requireDeliveryAcceptance: false,
      requirePreviewForAcceptance: false,
    });
  });
  it("normalizes agent order but rejects duplicates, malformed scope and unsupported policy", () => {
    expect(
      StoryWorkflowPolicySchema.parse({ planApprovalAgents: ["reviewer", "builder"] })
        .planApprovalAgents,
    ).toEqual(["builder", "reviewer"]);
    for (const policy of [
      { planApprovalAgents: ["builder", "builder"] },
      { planApprovalAgents: [" builder"] },
      { requirePreviewForAcceptance: true },
      { privilegedBypass: true },
    ])
      expect(StoryWorkflowPolicySchema.safeParse(policy).success).toBe(false);
  });
  it("accepts only exact acceptance identity and no caller-supplied authorizer", () => {
    const valid = {
      expected_candidate_revision: "a".repeat(64),
      expected_plan_revision: 1,
      expected_decision_revision: 2,
      idempotency_key: "acceptance-test",
    };
    expect(RequestDeliveryAcceptanceBody.safeParse(valid).success).toBe(true);
    expect(
      RequestDeliveryAcceptanceBody.safeParse({ ...valid, approved_by: "user-other" }).success,
    ).toBe(false);
    expect(
      RequestDeliveryAcceptanceBody.safeParse({ ...valid, expected_candidate_revision: "latest" })
        .success,
    ).toBe(false);
    expect(
      ConfirmWorkflowPolicyBody.safeParse({
        expected_revision: 0,
        policy: {},
        proof: "x".repeat(43),
        idempotency_key: "policy-test",
      }).success,
    ).toBe(false);
  });
});
