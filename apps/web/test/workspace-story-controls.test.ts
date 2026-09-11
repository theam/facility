import { describe, expect, it } from "vitest";
import { isWorkspaceDeleted } from "../components/story/workspace-story-controls";

describe("workspace story controls", () => {
  it("does not offer reversible lifecycle actions after explicit deletion", () => {
    expect(isWorkspaceDeleted({ deletedAt: "2026-09-02T00:00:00.000Z" }, null)).toBe(true);
    expect(isWorkspaceDeleted({ deletedAt: null }, { state: "destroyed" })).toBe(true);
    expect(isWorkspaceDeleted({ deletedAt: null }, { state: "sleeping" })).toBe(false);
  });
});
