import { describe, expect, it } from "vitest";
import { interactivePlanActor } from "../src/stories/plan-confirmation.js";
import {
  verifyWorkflowConfirmationProof,
  type WorkflowProofBinding,
  workflowConfirmationProof,
} from "../src/stories/workflow-confirmation.js";

const now = new Date("2026-10-27T12:00:00Z");
const masterKey = Buffer.alloc(32, 9).toString("base64");
const actor = { id: "user-example", name: "Example", sessionCookie: "synthetic-session" };
const binding: WorkflowProofBinding = {
  purpose: "delivery_acceptance",
  orgId: "org-example",
  projectId: "project-example",
  storyId: "story-example",
  nonce: "request-example",
  digest: "a".repeat(64),
  expiresAt: new Date(now.getTime() + 60_000),
};

describe("interactive workflow confirmations", () => {
  it("accepts the exact current action and session", () => {
    const proof = workflowConfirmationProof(binding, actor, masterKey);
    expect(() =>
      verifyWorkflowConfirmationProof(proof, binding, actor, masterKey, now),
    ).not.toThrow();
  });
  it("rejects cross-action, scope, nonce, snapshot, principal and session substitution", () => {
    const proof = workflowConfirmationProof(binding, actor, masterKey);
    for (const replacement of [
      { purpose: "workflow_policy" as const },
      { orgId: "org-other" },
      { projectId: "project-other" },
      { storyId: "story-other" },
      { nonce: "request-other" },
      { digest: "b".repeat(64) },
      { expiresAt: new Date(now.getTime() + 61_000) },
    ])
      expect(() =>
        verifyWorkflowConfirmationProof(
          proof,
          { ...binding, ...replacement },
          actor,
          masterKey,
          now,
        ),
      ).toThrow();
    for (const replacement of [{ id: "user-other" }, { sessionCookie: "session-other" }])
      expect(() =>
        verifyWorkflowConfirmationProof(
          proof,
          binding,
          { ...actor, ...replacement },
          masterKey,
          now,
        ),
      ).toThrow();
    expect(() =>
      verifyWorkflowConfirmationProof("malformed", binding, actor, masterKey, now),
    ).toThrow();
  });
  it("rejects expired, invalid and overlong confirmations", () => {
    for (const expiresAt of [
      now,
      new Date(now.getTime() - 1),
      new Date(Number.NaN),
      new Date(now.getTime() + 16 * 60_000),
    ])
      expect(() =>
        verifyWorkflowConfirmationProof(
          "x".repeat(43),
          { ...binding, expiresAt },
          actor,
          masterKey,
          now,
        ),
      ).toThrow();
  });
  it("never treats a service key or OAuth bearer as interactive consent", () => {
    expect(() =>
      interactivePlanActor({
        principal: { type: "key", id: "key-example" },
        headers: {},
        cookies: { facility_session: "synthetic-session" },
      }),
    ).toThrow();
    expect(() =>
      interactivePlanActor({
        principal: { type: "user", id: actor.id },
        headers: { authorization: "Bearer synthetic" },
        cookies: { facility_session: "synthetic-session" },
      }),
    ).toThrow();
  });
});
