import { StoryWorkflowPolicySchema } from "@facility/core";
import { describe, expect, it } from "vitest";
import {
  type AcceptanceObservation,
  acceptanceSnapshot,
  sameAcceptedCandidate,
} from "../src/stories/delivery-acceptance-snapshot.js";
import { deliveryCandidate, deliveryPullProjection } from "../src/stories/delivery-projection.js";

function observation(): AcceptanceObservation {
  const now = new Date("2026-11-05T12:00:00Z");
  const headSha = "a".repeat(40);
  const pullRequests = [1, 2].map((number) =>
    deliveryPullProjection(
      {
        repositoryId: `repo-${number}`,
        repository: `example/app-${number}`,
        number,
        required: true,
        primary: number === 1,
        origin: "registered",
      },
      {
        title: "Change",
        htmlUrl: `https://github.com/example/app-${number}/pull/${number}`,
        state: "open",
        draft: false,
        headSha,
        headRef: "feature",
        baseRef: "main",
        syncedAt: now,
        ciState: "failure",
        ciHeadSha: headSha,
        ciUpdatedAt: now,
      },
      [],
      false,
      now,
    ),
  );
  const scope = {
    revision: 1,
    declaredComplete: true,
    origin: "registered" as const,
    updatedAt: now.toISOString(),
    updatedBy: null,
  };
  const candidate = deliveryCandidate(scope, pullRequests);
  return {
    policy: {
      revision: 1,
      policy: StoryWorkflowPolicySchema.parse({
        requireDeliveryAcceptance: true,
        requirePreviewForAcceptance: true,
      }),
    },
    delivery: { scope, candidate, pullRequests },
    plan: {
      state: { revision: 2, decisionRevision: 3, status: "approved" },
      digest: "b".repeat(64),
    },
    preview: {
      state: "ready",
      desiredGeneration: candidate.revision,
      deployedGeneration: candidate.revision,
    },
  };
}
describe("shared delivery acceptance binding", () => {
  it("binds the complete PR set while keeping failed CI separate from eligibility", () => {
    const input = observation();
    const snapshot = acceptanceSnapshot(input, 0, true);
    expect(snapshot.pullRequests).toHaveLength(2);
    expect(snapshot.candidateRevision).toBe(input.delivery.candidate.revision);
    expect(snapshot.previewGeneration).toBe(snapshot.candidateRevision);
    expect(input.delivery.pullRequests.every((pull) => pull.checks.state === "failure")).toBe(true);
  });
  it("requires an exact ready preview only when requesting, preserving accepted sleep", () => {
    const input = observation();
    const receipt = acceptanceSnapshot(input, 1, true);
    input.preview = {
      state: "suspended",
      desiredGeneration: input.delivery.candidate.revision,
      deployedGeneration: null,
    };
    expect(() => acceptanceSnapshot(input, 1, true)).toThrow(/preview/);
    expect(sameAcceptedCandidate(acceptanceSnapshot(input, 1, false), receipt)).toBe(true);
    input.preview = {
      state: "ready",
      desiredGeneration: input.delivery.candidate.revision,
      deployedGeneration: "f".repeat(64),
    };
    expect(() => acceptanceSnapshot(input, 1, true)).toThrow(/preview/);
  });
  it("invalidates a receipt after a required head, policy or plan changes", () => {
    const original = observation();
    const receipt = acceptanceSnapshot(original, 1, false);
    for (const change of ["head", "policy", "plan"] as const) {
      const input = observation();
      if (change === "head") {
        const second = input.delivery.pullRequests[1];
        if (!second) throw new Error("Missing second pull request");
        second.headSha = "c".repeat(40);
        input.delivery.candidate = deliveryCandidate(
          input.delivery.scope,
          input.delivery.pullRequests,
        );
      } else if (change === "policy") input.policy.revision++;
      else input.plan.state.revision++;
      expect(sameAcceptedCandidate(acceptanceSnapshot(input, 1, false), receipt), change).toBe(
        false,
      );
    }
  });
  it("rejects missing or stale candidate evidence and the current rejected plan", () => {
    for (const state of ["scope_incomplete", "unobserved", "stale"] as const) {
      const input = observation();
      input.delivery.candidate.state = state;
      expect(() => acceptanceSnapshot(input, 0, false)).toThrow(/complete required PR set/);
    }
    const input = observation();
    input.plan.state.status = "rejected";
    expect(() => acceptanceSnapshot(input, 0, false)).toThrow(/Approve the current plan/);
  });
});
