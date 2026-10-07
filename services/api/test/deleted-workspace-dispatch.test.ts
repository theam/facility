import type { FacilityDb } from "@facility/db";
import { expect, it, vi } from "vitest";
import type { AgentCatalogService } from "../src/agents/catalog.js";
import type { StoryWorkspaceService } from "../src/stories/service.js";
import { TurnDispatcher } from "../src/turns/dispatcher.js";

const input = {
  orgId: "org_test",
  projectId: "proj_test",
  storyId: "story_test",
  turnId: "turn_test",
};

function fixture(rows: unknown[][]) {
  const limit = vi.fn();
  for (const result of rows) limit.mockResolvedValueOnce(result);
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit,
  };
  const db = { select: vi.fn(() => query) };
  const service = { activateNextMessage: vi.fn(), flagAttention: vi.fn() };
  const catalog = { get: vi.fn().mockRejectedValue(new Error("catalog unavailable")) };
  const dispatcher = new TurnDispatcher(
    db as unknown as FacilityDb,
    service as unknown as StoryWorkspaceService,
    catalog as unknown as AgentCatalogService,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { dispatcher, service, catalog };
}

it("does not resolve agents or activate retained messages without an active workspace", async () => {
  const { dispatcher, service, catalog } = fixture([[]]);
  await dispatcher.activateQueuedSuccessor(input);
  expect(catalog.get).not.toHaveBeenCalled();
  expect(service.activateNextMessage).not.toHaveBeenCalled();
  expect(service.flagAttention).not.toHaveBeenCalled();
});

it("does not create a retry notice when deletion wins during catalog lookup", async () => {
  const { dispatcher, service, catalog } = fixture([
    [{ id: "ws_test" }],
    [{ requestedAgentName: "builder" }],
    [],
  ]);
  await expect(dispatcher.activateQueuedSuccessor(input)).resolves.toBeUndefined();
  expect(catalog.get).toHaveBeenCalledOnce();
  expect(service.activateNextMessage).not.toHaveBeenCalled();
  expect(service.flagAttention).not.toHaveBeenCalled();
});
