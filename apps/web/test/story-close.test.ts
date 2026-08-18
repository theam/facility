import { describe, expect, it } from "vitest";
import { storyStateRequest } from "@/lib/story-close";

describe("story close and reopen requests", () => {
  it("requires a reason to close and sends the chosen GitHub state reason", () => {
    expect(storyStateRequest({ state: "open", reason: "  ", stateReason: "not_planned" })).toEqual({
      ok: false,
      message: "A reason is required to close a story",
    });
    expect(
      storyStateRequest({ state: "open", reason: "  Superseded  ", stateReason: "not_planned" }),
    ).toEqual({
      ok: true,
      verb: "close",
      body: { reason: "Superseded", stateReason: "not_planned" },
    });
  });

  it("reopens with an empty body, carrying no reason", () => {
    expect(storyStateRequest({ state: "closed", reason: "", stateReason: "completed" })).toEqual({
      ok: true,
      verb: "reopen",
      body: {},
    });
    expect(
      storyStateRequest({ state: "closed", reason: " Back on ", stateReason: "completed" }),
    ).toEqual({ ok: true, verb: "reopen", body: {} });
  });
});
