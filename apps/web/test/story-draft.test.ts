// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSentStoryDraft,
  readStoryDraft,
  storyDraftKey,
  writeStoryDraft,
} from "../lib/story-draft";

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("tab-local story drafts", () => {
  it("clears a receipt only while the exact submitted draft still owns storage", () => {
    const attempt = {
      agent: "builder",
      message: "Submitted",
      idempotencyKey: `ui-message-${crypto.randomUUID()}`,
    };
    writeStoryDraft("draft", attempt);
    expect(clearSentStoryDraft("draft", attempt)).toBe(true);
    writeStoryDraft("draft", { ...attempt, message: "Newer edit" });
    expect(clearSentStoryDraft("draft", attempt)).toBe(false);
    expect(readStoryDraft("draft")?.message).toBe("Newer edit");
    writeStoryDraft("draft", { agent: attempt.agent, message: attempt.message });
    expect(clearSentStoryDraft("draft", attempt)).toBe(false);
  });
  it("requires an identified person and separates every scope", () => {
    expect(storyDraftKey(undefined, "project", "story")).toBeNull();
    const keys = new Set([
      storyDraftKey("org:person", "project", "story"),
      storyDraftKey("other-org:person", "project", "story"),
      storyDraftKey("org:other-person", "project", "story"),
      storyDraftKey("org:person", "other-project", "story"),
      storyDraftKey("org:person", "project", "other-story"),
      storyDraftKey("org:person:project", "story", ""),
    ]);
    expect(keys.size).toBe(6);
  });

  it("round-trips unchanged retry identity and clears sent or discarded text", () => {
    const key = storyDraftKey("person", "project", "story");
    const draft = {
      agent: "implementer",
      message: "Do the change",
      idempotencyKey: `ui-message-${crypto.randomUUID()}`,
    };
    expect(writeStoryDraft(key, draft)).toBe(true);
    expect(readStoryDraft(key)).toEqual(draft);
    writeStoryDraft(key, { agent: draft.agent, message: "" });
    expect(readStoryDraft(key)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("does not extend retention by restoring or preparing an unchanged retry", () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const draft = { agent: "designer", message: "Keep the last edit time" };
    writeStoryDraft("draft", draft);
    clock.mockReturnValue(start + 23 * 60 * 60 * 1_000);
    const restored = readStoryDraft("draft");
    expect(restored).not.toBeNull();
    writeStoryDraft("draft", { ...draft, idempotencyKey: `ui-message-${crypto.randomUUID()}` });
    clock.mockReturnValue(start + 25 * 60 * 60 * 1_000);
    expect(readStoryDraft("draft")).toBeNull();
  });

  it("starts a new retention period when the person edits the draft", () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    writeStoryDraft("draft", { agent: "designer", message: "First edit" });
    clock.mockReturnValue(start + 23 * 60 * 60 * 1_000);
    writeStoryDraft("draft", { agent: "designer", message: "Second edit" });
    clock.mockReturnValue(start + 25 * 60 * 60 * 1_000);
    expect(readStoryDraft("draft")?.message).toBe("Second edit");
  });

  it.each([
    { version: 0 },
    { updatedAt: Date.now() - 25 * 60 * 60 * 1_000 },
    { updatedAt: Date.now() + 120_000 },
    { message: 42 },
    { message: "x".repeat(200_001) },
    { idempotencyKey: "unsafe\r\nheader" },
  ])("does not restore an invalid or expired record: %j", (changes) => {
    const key = "test-draft";
    sessionStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        agent: "designer",
        message: "Draft",
        ...changes,
      }),
    );
    expect(readStoryDraft(key)).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it("tolerates malformed JSON and unavailable storage", () => {
    sessionStorage.setItem("broken", "{");
    expect(readStoryDraft("broken")).toBeNull();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw Error("quota");
    });
    expect(writeStoryDraft("draft", { agent: "designer", message: "Still in memory" })).toBe(false);
  });
});
