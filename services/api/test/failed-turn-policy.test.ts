import { expect, it } from "vitest";
import { shouldSuspendFailedWorkspace } from "../src/workspaces/failed-turn-policy.js";

const failed = {
  workspaceState: "running",
  workspaceUpdatedAt: new Date(100),
  latestTurnState: "failed",
  latestTurnEndedAt: new Date(200),
  hasPendingWork: false,
};

it("suspends failed idle compute, including retryable provider errors", () => {
  expect(shouldSuspendFailedWorkspace(failed)).toBe(true);
  expect(shouldSuspendFailedWorkspace({ ...failed, workspaceState: "error" })).toBe(true);
});

it.each([
  { hasPendingWork: true },
  { latestTurnState: "succeeded" },
  { latestTurnState: "running" },
  { latestTurnState: "queued" },
  { workspaceState: "sleeping" },
  { workspaceState: "destroyed" },
  { workspaceState: "deleting" },
  { workspaceState: "creating" },
  { latestTurnEndedAt: null },
  { workspaceUpdatedAt: new Date(300) },
])("preserves active work and explicit operator wake: %j", (override) => {
  expect(shouldSuspendFailedWorkspace({ ...failed, ...override })).toBe(false);
});
