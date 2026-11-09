import { describe, expect, it } from "vitest";
import {
  ConfirmPlanDecisionBody,
  ProposeStoryPlanBody,
  RequestPlanDecisionBody,
} from "../src/story-plans.js";

const proposal = {
  expected_revision: 0,
  markdown: "# Plan\nPreserve the current behavior.",
  repositories: ["example/app"],
  agents: ["builder"],
  idempotency_key: "plan-proposal-1",
};
describe("story plan inputs", () => {
  it("preserves exact source text and accepts explicit repository/agent scope", () => {
    const markdown = "  source formatting\n";
    expect(
      ProposeStoryPlanBody.parse({ ...proposal, markdown, source_message_id: "msg_source" })
        .markdown,
    ).toBe(markdown);
  });
  it("rejects forged authority, duplicate scope, unsupported text and unbounded revisions", () => {
    for (const changes of [
      { approvedBy: "user_owner" },
      { actor: { type: "user", id: "user_owner" } },
      { repositories: ["example/app", "Example/App"] },
      { agents: ["builder", "builder"] },
      { repositories: [] },
      { agents: [] },
      { markdown: "  " },
      { markdown: "bad\0text" },
      { expected_revision: -1 },
      { expected_revision: 2_147_483_647 },
      { idempotency_key: "short" },
    ])
      expect(ProposeStoryPlanBody.safeParse({ ...proposal, ...changes }).success).toBe(false);
  });
  it("requires a reason for rejection and both observed revisions for any decision request", () => {
    const value = {
      expected_revision: 1,
      expected_decision_revision: 0,
      intent: "approve",
      idempotency_key: "decision-request-1",
    };
    expect(RequestPlanDecisionBody.parse(value).intent).toBe("approve");
    expect(RequestPlanDecisionBody.safeParse({ ...value, intent: "reject" }).success).toBe(false);
    expect(
      RequestPlanDecisionBody.parse({
        ...value,
        intent: "reject",
        reason: "Verify the migration first",
      }).intent,
    ).toBe("reject");
    expect(RequestPlanDecisionBody.safeParse({ ...value, expected_revision: 0 }).success).toBe(
      false,
    );
    expect(RequestPlanDecisionBody.safeParse({ ...value, humanVerified: true }).success).toBe(
      false,
    );
  });
  it("only accepts a bounded proof and request key at confirmation", () => {
    const value = { proof: "a".repeat(43), idempotency_key: "confirm-request-1" };
    expect(ConfirmPlanDecisionBody.parse(value)).toEqual(value);
    for (const changes of [
      { proof: "short" },
      { proof: "!".repeat(43) },
      { intent: "approve" },
      { plan_revision: 2 },
      { actor: "user_owner" },
    ])
      expect(ConfirmPlanDecisionBody.safeParse({ ...value, ...changes }).success).toBe(false);
  });
});
