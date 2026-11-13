import { describe, expect, it } from "vitest";
import type { BacklogItem } from "../src/stories/backlog.js";
import { type BacklogTracking, trackingGroup } from "../src/stories/backlog-tracking.js";

const item = {
  phase: "in_progress",
  activity: { state: "running" },
  attention: [],
  pullRequest: null,
} as unknown as BacklogItem;
const tracking: Omit<BacklogTracking, "group"> = {
  pendingMessages: 0,
  messageWait: null,
  previewApplying: false,
  plan: null,
  delivery: null,
  wait: null,
};
describe("tracking groups", () => {
  it("preserves execution and pending facts while surfacing a review", () => {
    const facts = { ...tracking, pendingMessages: 3, plan: { revision: 2, digest: "digest" } };
    expect(trackingGroup(item, facts)).toBe("review");
    expect(item.activity.state).toBe("running");
    expect(facts.pendingMessages).toBe(3);
    expect(trackingGroup(item, tracking)).toBe("in_progress");
  });
  it("separates an active preview, dispatch wait and idle work without inventing capacity", () => {
    const idle = { ...item, activity: { ...item.activity, state: "idle" as const } };
    expect(trackingGroup(idle, { ...tracking, previewApplying: true, pendingMessages: 1 })).toBe(
      "in_progress",
    );
    expect(trackingGroup(idle, { ...tracking, pendingMessages: 1 })).toBe("waiting");
    expect(trackingGroup(idle, tracking)).toBe("backlog");
  });
  it("keeps incomplete delivery and pending checks distinct from available review", () => {
    const idle = { ...item, activity: { ...item.activity, state: "idle" as const } };
    expect(
      trackingGroup(idle, { ...tracking, delivery: { ready: false, detail: "Checks pending" } }),
    ).toBe("waiting");
    expect(trackingGroup(idle, { ...tracking, delivery: { ready: true, detail: "Review" } })).toBe(
      "review",
    );
    const pull = { state: "open", draft: false, ciState: "pending" } as NonNullable<
      BacklogItem["pullRequest"]
    >;
    expect(trackingGroup({ ...idle, pullRequest: pull }, tracking)).toBe("waiting");
    expect(trackingGroup({ ...idle, pullRequest: { ...pull, ciState: "success" } }, tracking)).toBe(
      "review",
    );
    expect(trackingGroup({ ...idle, phase: "archived" }, tracking)).toBe("archived");
  });
});
