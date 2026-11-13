import type { FacilityDb } from "@facility/db";
import { describe, expect, it, vi } from "vitest";
import { StoryWorkspaceService } from "../src/stories/service.js";
import type { WorkspaceRuntime } from "../src/workspaces/runtime.js";

describe("source conversation reads", () => {
  it("rejects mixed cursor instructions before any lookup or execution", async () => {
    const select = vi.fn();
    const queued = vi.fn();
    const service = new StoryWorkspaceService(
      { select } as unknown as FacilityDb,
      {} as WorkspaceRuntime,
      queued,
    );
    for (const cursor of [{ after: 2 }, { before: 5 }]) {
      await expect(
        service.conversationPage("org", "project", "story", {
          messageId: "source",
          ...cursor,
        }),
      ).rejects.toMatchObject({ code: "invalid_cursor", statusCode: 400 });
    }
    expect(select).not.toHaveBeenCalled();
    expect(queued).not.toHaveBeenCalled();
  });

  it("never falls back to latest messages when the story or source cannot be found", async () => {
    for (const storyExists of [false, true]) {
      const limit = vi
        .fn()
        .mockResolvedValueOnce(storyExists ? [{ id: "story" }] : [])
        .mockResolvedValue([]);
      const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) }));
      const queued = vi.fn();
      const service = new StoryWorkspaceService(
        { select } as unknown as FacilityDb,
        {} as WorkspaceRuntime,
        queued,
      );
      const recent = vi.spyOn(service, "conversation");
      await expect(
        service.conversationPage("org", "project", "story", {
          messageId: "missing-or-foreign",
        }),
      ).rejects.toMatchObject({
        code: storyExists ? "message_not_found" : "story_not_found",
        statusCode: 404,
      });
      expect(recent).not.toHaveBeenCalled();
      expect(queued).not.toHaveBeenCalled();
    }
  });
});
