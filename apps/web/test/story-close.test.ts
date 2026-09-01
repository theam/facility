import { describe, expect, it } from "vitest";
import { attemptKey, storyStateRequest } from "@/lib/story-close";

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

  it("keeps one idempotency key across retries of the same close attempt", () => {
    let minted = 0;
    const mint = () => {
      minted += 1;
      return `key-${minted}`;
    };

    // First submit mints; the retry after a failure reuses, so the server sees
    // one attempt and corrects its own comment instead of posting a second.
    const first = attemptKey(null, mint);
    const retry = attemptKey(first, mint);
    expect(retry).toBe(first);
    expect(minted).toBe(1);

    // Cleared once the attempt finishes: the next close is a new decision.
    expect(attemptKey(null, mint)).not.toBe(first);
    expect(minted).toBe(2);
  });
});
