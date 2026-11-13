import { describe, expect, it } from "vitest";
import { observePlanExecution } from "../src/stories/plan-execution-observation.js";

const scope = { orgId: "org", projectId: "project", storyId: "story" };
const at = new Date("2026-11-05T10:00:00Z");
const decision: Parameters<typeof observePlanExecution>[2] = {
  ...scope,
  id: "decision",
  intent: "approve",
  decisionRevision: 2,
  planRevision: 3,
  planDigest: "d".repeat(64),
};
const turn = {
  ...scope,
  id: "retained",
  agentName: "architect",
  engine: "codex",
  model: "fixture",
  manifestHash: "a".repeat(64),
  state: "running",
  startedAt: at,
  endedAt: null,
};
const authorization = {
  schemaVersion: 1,
  policyRevision: 1,
  planRevision: decision.planRevision,
  planDigest: decision.planDigest,
  decisionRevision: decision.decisionRevision,
  decisionId: decision.id,
  authorizerId: "reviewer",
  agentName: turn.agentName,
  manifestHash: turn.manifestHash,
  repositoryIds: ["repo"],
};
const evidence = {
  ...scope,
  turnId: turn.id,
  source: "facility",
  type: "workflow.execution_authorized",
  externalKey: `workflow:execution:${turn.id}`,
  occurredAt: at,
  data: authorization,
};

describe("observed execution after approval", () => {
  it("links the recorded turn and timestamps to the exact approval without exposing raw authorization data", () => {
    const result = observePlanExecution(evidence, turn, decision);
    expect(result).toMatchObject({
      turnId: "retained",
      state: "running",
      startedAt: at.toISOString(),
      authorizedAt: at.toISOString(),
    });
    expect(result).not.toHaveProperty("authorizerId");
    expect(result).not.toHaveProperty("data");
  });
  it("rejects missing turns, cross-scope rows and untrusted or misattributed evidence", () => {
    expect(observePlanExecution(evidence, null, decision)).toBeNull();
    for (const patch of [{ orgId: "other" }, { projectId: "other" }, { storyId: "other" }]) {
      expect(observePlanExecution({ ...evidence, ...patch }, turn, decision)).toBeNull();
      expect(observePlanExecution(evidence, { ...turn, ...patch }, decision)).toBeNull();
    }
    for (const patch of [
      { source: "workspace" },
      { type: "turn.completed" },
      { externalKey: "different" },
      { turnId: "another" },
    ]) {
      expect(observePlanExecution({ ...evidence, ...patch }, turn, decision)).toBeNull();
    }
  });
  it("does not reuse another plan, decision or agent version as evidence for this approval", () => {
    expect(observePlanExecution({ ...evidence, data: {} }, turn, decision)).toBeNull();
    expect(observePlanExecution(evidence, turn, { ...decision, intent: "reject" })).toBeNull();
    for (const patch of [
      { decisionId: "other" },
      { decisionRevision: 1 },
      { planRevision: 2 },
      { planDigest: "other" },
      { agentName: "builder" },
      { manifestHash: "other" },
    ]) {
      expect(
        observePlanExecution({ ...evidence, data: { ...authorization, ...patch } }, turn, decision),
      ).toBeNull();
    }
  });
  it("reports current queue or failure state instead of turning an admission receipt into successful execution", () => {
    expect(
      observePlanExecution(evidence, { ...turn, state: "queued", startedAt: null }, decision),
    ).toMatchObject({ state: "queued", startedAt: null });
    expect(
      observePlanExecution(evidence, { ...turn, state: "failed", endedAt: at }, decision),
    ).toMatchObject({ state: "failed", endedAt: at.toISOString() });
    expect(observePlanExecution(evidence, { ...turn, state: "unrecognized" }, decision)).toBeNull();
  });
});
