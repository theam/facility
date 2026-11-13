// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storyDraftKey } from "../lib/story-draft";
import { readStoryUpload, type StoryUploadAttempt, writeStoryUpload } from "../lib/story-upload";

const attempt = (): StoryUploadAttempt => ({
  idempotencyKey: `ui-file-${crypto.randomUUID()}`,
  name: "fixture.txt",
  size: 7,
  sha256: "a".repeat(64),
  mediaType: "text/plain",
  resume: false,
});
beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});
describe("tab-local upload intent", () => {
  it("keeps only intent metadata, isolated by person, project and story", () => {
    const key = storyDraftKey("org:person", "project", "story");
    const original = attempt();
    expect(
      writeStoryUpload(key, {
        ...original,
        token: "not-a-real-token",
        bytes: "not-file-contents",
      } as StoryUploadAttempt),
    ).toBe(true);
    expect(readStoryUpload(key)).toEqual(original);
    expect(sessionStorage.getItem(`${key}:upload`)).not.toContain("not-a-real-token");
    expect(sessionStorage.getItem(`${key}:upload`)).not.toContain("not-file-contents");
    for (const other of [
      storyDraftKey("org:other", "project", "story"),
      storyDraftKey("org:person", "other", "story"),
      storyDraftKey("org:person", "project", "other"),
    ])
      expect(readStoryUpload(other)).toBeUndefined();
    expect(writeStoryUpload(null, original)).toBe(false);
    expect(readStoryUpload(null)).toBeUndefined();
  });
  it("does not prolong retention while recording or recovering the same attempt", () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const original = attempt();
    writeStoryUpload("draft", original);
    clock.mockReturnValue(start + 23 * 60 * 60 * 1000);
    writeStoryUpload("draft", { ...original, fileId: "infile_0123456789abcdef" });
    expect(readStoryUpload("draft")?.fileId).toBe("infile_0123456789abcdef");
    clock.mockReturnValue(start + 25 * 60 * 60 * 1000);
    expect(readStoryUpload("draft")).toBeUndefined();
    expect(sessionStorage.length).toBe(0);
  });
  it("clears only its upload intent and tolerates unavailable storage", () => {
    sessionStorage.setItem("draft", "message draft");
    writeStoryUpload("draft", attempt());
    writeStoryUpload("draft");
    expect(readStoryUpload("draft")).toBeUndefined();
    expect(sessionStorage.getItem("draft")).toBe("message draft");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw Error("quota");
    });
    expect(writeStoryUpload("draft", attempt())).toBe(false);
  });
  it.each([
    { idempotencyKey: "unsafe\r\nkey" },
    { sha256: "not-a-hash" },
    { fileId: "foreign/id" },
    { size: 0 },
    { resume: "true" },
  ])("rejects invalid restored metadata %j", (changes) => {
    sessionStorage.setItem(
      "draft:upload",
      JSON.stringify({ version: 1, updatedAt: Date.now(), attempt: { ...attempt(), ...changes } }),
    );
    expect(readStoryUpload("draft")).toBeUndefined();
    expect(sessionStorage.getItem("draft:upload")).toBeNull();
  });
});
