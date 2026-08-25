import { describe, expect, it } from "vitest";
import { closeCommentBody, closeMarker } from "../src/github/close-story.js";

describe("story close comments", () => {
  it("names the close attempt in the marker so only its own retry recovers it", () => {
    expect(closeMarker("a1b2c3d4")).toBe("<!-- facility:story-close:a1b2c3d4 -->");
    expect(closeMarker(null)).toBe("<!-- facility:story-close -->");
    expect(closeMarker("a1b2c3d4")).not.toBe(closeMarker("e5f6a7b8"));
    expect(
      closeCommentBody("Not worth doing", "not_planned", "@octocat", closeMarker("a1b2c3d4")),
    ).toMatch(/^<!-- facility:story-close:a1b2c3d4 -->\n/);
  });

  it("attributes the decision and renders the GitHub state reason in words", () => {
    const marker = closeMarker("a1b2c3d4");
    expect(closeCommentBody("Superseded", "not_planned", "@octocat", marker)).toBe(
      `${marker}\n**Closed from Facility** by @octocat · not planned\n\nSuperseded`,
    );
    expect(closeCommentBody("Shipped in #12", "completed", "dev@example.com", marker)).toBe(
      `${marker}\n**Closed from Facility** by dev@example.com · completed\n\nShipped in #12`,
    );
  });
});
