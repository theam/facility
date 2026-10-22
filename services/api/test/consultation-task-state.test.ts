import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readConsultationTaskState } from "../src/stories/consultation-task-state.js";

const scope = { orgId: "org-a", projectId: "project-a", storyId: "story-a" };
const digest = createHash("sha256")
  .update(
    '{"delivery":{"candidate":{"revision":null}},"orgId":"org-a","plans":{"state":{"revision":0}},"projectId":"project-a","storyId":"story-a"}',
  )
  .digest("base64url");
function fixture() {
  return {
    data: {
      storyId: "story-a",
      plans: { state: { revision: 0 } },
      projectId: "project-a",
      orgId: "org-a",
      delivery: { candidate: { revision: null } },
    },
    provenance: {
      hash: digest,
      capturedAt: "2026-10-22T09:00:00.000Z",
      planRevision: 0,
      decisionRevision: 0,
      deliveryScopeRevision: 0,
      deliveryCandidateRevision: null,
    },
    omissions: [],
  };
}
describe("consultation task-state identity", () => {
  it("survives JSONB key order without changing the snapshot identity", () => {
    expect(readConsultationTaskState(fixture(), scope)?.provenance.hash).toBe(digest);
  });
  it("rejects foreign scope and changed snapshot content", () => {
    expect(() =>
      readConsultationTaskState(fixture(), { ...scope, projectId: "project-b" }),
    ).toThrow("scope and digest");
    const altered = fixture();
    altered.data.plans.state.revision = 2;
    expect(() => readConsultationTaskState(altered, scope)).toThrow("scope and digest");
  });
  it("keeps unavailable metadata explicit for earlier saved requests", () => {
    expect(readConsultationTaskState(undefined, scope)).toBeNull();
    expect(() => readConsultationTaskState({ data: {} }, scope)).toThrow();
  });
});
