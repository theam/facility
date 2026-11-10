import type { StoryWorkflowStatus, WorkspaceStoryBundle } from "@facility/sdk";
import { describe, expect, it } from "vitest";
import { storyFocus } from "../lib/story-focus";

type Shape = {
  status?: string;
  plan?: string;
  delivery?: string;
  completion?: string;
  running?: boolean;
};

function bundle(shape: Shape = {}) {
  return {
    story: { status: shape.status ?? "working", deletedAt: null, archivedAt: null },
    plans: shape.plan ? { state: { status: shape.plan } } : null,
    delivery: shape.delivery
      ? { pullRequests: [{ number: 1 }], candidate: { state: shape.delivery } }
      : null,
    completion: shape.completion
      ? { nextAction: shape.completion, source: { kind: "github", state: "open" } }
      : null,
    turns: shape.running ? [{ state: "running" }] : [],
    progress: null,
  } as unknown as WorkspaceStoryBundle;
}

function review(phase: string) {
  return { reviewCycle: { phase, reason: null } } as unknown as StoryWorkflowStatus;
}

describe("story focus", () => {
  it("marks only steps that wait on a person as a decision", () => {
    expect(storyFocus(bundle({ plan: "proposed" }), undefined)).toMatchObject({
      section: "plan",
      decision: true,
    });
    expect(storyFocus(bundle({ plan: "approved" }), undefined, true).decision).toBe(true);
    expect(storyFocus(bundle({ delivery: "recorded" }), undefined)).toMatchObject({
      section: "delivery",
      decision: true,
    });
    expect(storyFocus(bundle({ completion: "request_completion" }), undefined)).toMatchObject({
      section: "completion",
      decision: true,
    });
    expect(storyFocus(bundle(), review("human_review")).decision).toBe(true);
    expect(storyFocus(bundle(), review("decision_required")).decision).toBe(true);
  });

  it("keeps running work, waits and incomplete candidates out of the decision slot", () => {
    expect(storyFocus(bundle({ running: true }), undefined)).toMatchObject({
      section: "progress",
      decision: false,
    });
    for (const state of ["stale", "unobserved", "scope_incomplete"])
      expect(storyFocus(bundle({ delivery: state }), undefined).decision).toBe(false);
    expect(storyFocus(bundle({ completion: "wait_completion" }), undefined).decision).toBe(false);
    expect(storyFocus(bundle(), review("correction")).decision).toBe(false);
    expect(storyFocus(bundle({ status: "done" }), undefined).decision).toBe(false);
    expect(storyFocus(bundle(), undefined).decision).toBe(false);
  });
});
