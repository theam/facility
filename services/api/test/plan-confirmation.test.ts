import { describe, expect, it } from "vitest";
import {
  type InteractivePlanActor,
  interactivePlanActor,
  type PlanProofBinding,
  planConfirmationProof,
  verifyPlanConfirmationProof,
} from "../src/stories/plan-confirmation.js";

const key = Buffer.alloc(32, 7).toString("base64");
const now = new Date("2026-10-21T10:00:00Z");
const actor: InteractivePlanActor = {
  id: "user_owner",
  name: "Owner",
  sessionCookie: "already-verified-test-session",
};
const binding: PlanProofBinding = {
  orgId: "org_one",
  projectId: "proj_one",
  storyId: "story_one",
  requestId: "dreq_one",
  planRevision: 1,
  planDigest: "a".repeat(64),
  decisionRevision: 0,
  intent: "approve",
  reason: null,
  expiresAt: new Date(now.getTime() + 15 * 60_000),
};
describe("interactive plan confirmation proof", () => {
  it("verifies only an exact session, actor, target scope and intent without including the cookie in the proof", () => {
    const proof = planConfirmationProof(binding, actor, key);
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(proof).not.toContain(actor.sessionCookie);
    expect(() => verifyPlanConfirmationProof(proof, binding, actor, key, now)).not.toThrow();
    for (const changes of [
      { orgId: "org_other" },
      { projectId: "proj_other" },
      { storyId: "story_other" },
      { requestId: "dreq_other" },
      { planRevision: 2 },
      { planDigest: "b".repeat(64) },
      { decisionRevision: 1 },
      { intent: "reject" as const },
      { reason: "Changed intent" },
      { expiresAt: new Date(binding.expiresAt.getTime() + 1000) },
    ])
      expect(() =>
        verifyPlanConfirmationProof(proof, { ...binding, ...changes }, actor, key, now),
      ).toThrow(/does not match/);
    for (const changed of [
      { ...actor, id: "user_other" },
      { ...actor, sessionCookie: "renewed-session" },
    ])
      expect(() => verifyPlanConfirmationProof(proof, binding, changed, key, now)).toThrow(
        /does not match/,
      );
    expect(() =>
      verifyPlanConfirmationProof(
        proof,
        binding,
        actor,
        Buffer.alloc(32, 8).toString("base64"),
        now,
      ),
    ).toThrow(/does not match/);
  });
  it("rejects malformed signatures and the expiry boundary without timing or encoding exceptions", () => {
    for (const proof of ["", "a", "x".repeat(43), "é".repeat(43), "a".repeat(1000)])
      expect(() => verifyPlanConfirmationProof(proof, binding, actor, key, now)).toThrow(
        /does not match/,
      );
    const proof = planConfirmationProof(binding, actor, key);
    expect(() =>
      verifyPlanConfirmationProof(proof, binding, actor, key, binding.expiresAt),
    ).toThrow(/expired/);
    expect(() =>
      verifyPlanConfirmationProof(
        proof,
        binding,
        actor,
        key,
        new Date(binding.expiresAt.getTime() + 1),
      ),
    ).toThrow(/expired/);
  });
  it("requires the already-authenticated cookie path and never treats an OAuth identity or service key as interactive confirmation", () => {
    const request = {
      principal: { type: "user" as const, id: actor.id, name: "Owner" },
      headers: {},
      cookies: { facility_session: actor.sessionCookie },
    };
    expect(interactivePlanActor(request)).toEqual(actor);
    for (const changed of [
      { ...request, headers: { authorization: "Bearer oauth-user" } },
      { ...request, headers: { authorization: "" } },
      { ...request, principal: { type: "key" as const, id: "key_service" } },
      { ...request, principal: undefined },
      { ...request, cookies: {} },
    ])
      expect(() => interactivePlanActor(changed)).toThrow(/browser session/);
  });
});
