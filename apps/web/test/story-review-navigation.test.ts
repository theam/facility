import { describe, expect, it } from "vitest";
import { readStoryReviewLink, storyReviewHref } from "../lib/story-review-navigation";

describe("exact story review links", () => {
  it("preserves revision, digest and message without allowing a destination outside the story", () => {
    const digest = "a".repeat(64);
    expect(
      readStoryReviewLink({ planRevision: "3", planDigest: digest, messageId: "msg-original" }),
    ).toEqual({
      selection: { revision: 3, digest },
      messageId: "msg-original",
      messageError: undefined,
    });
    expect(
      storyReviewHref(
        "proj/one",
        "story/two",
        { revision: 3, digest },
        "msg?old=1",
        "conversation",
      ),
    ).toBe(
      `/projects/proj%2Fone/stories/story%2Ftwo?planRevision=3&planDigest=${digest}&messageId=msg%3Fold%3D1#conversation`,
    );
  });
  it("keeps malformed and ambiguous links in an explicit error state instead of opening latest", () => {
    for (const planRevision of ["0", "-1", "1.5", "1e2", "2147483648", ["1", "2"]])
      expect(readStoryReviewLink({ planRevision }).selection?.error).toBeTruthy();
    expect(readStoryReviewLink({ planDigest: "a".repeat(64) }).selection?.error).toBeTruthy();
    expect(
      readStoryReviewLink({ planRevision: "2", planDigest: "wrong" }).selection?.error,
    ).toBeTruthy();
    for (const messageId of ["", ["one", "two"], "with space", "x".repeat(201)])
      expect(readStoryReviewLink({ messageId }).messageError).toBeTruthy();
    expect(readStoryReviewLink({}).selection).toBeUndefined();
  });
});
