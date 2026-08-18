import { describe, expect, it } from "vitest";
import { closeCommentBody } from "../src/github/close-story.js";

describe("story close comments", () => {
  it("marks the comment as Facility's own so a retry can correct it", () => {
    expect(closeCommentBody("Not worth doing", "not_planned", "@octocat")).toMatch(
      /^<!-- facility:story-close -->\n/,
    );
  });

  it("attributes the decision and renders the GitHub state reason in words", () => {
    expect(closeCommentBody("Superseded", "not_planned", "@octocat")).toBe(
      "<!-- facility:story-close -->\n**Closed from Facility** by @octocat · not planned\n\nSuperseded",
    );
    expect(closeCommentBody("Shipped in #12", "completed", "dev@example.com")).toBe(
      "<!-- facility:story-close -->\n**Closed from Facility** by dev@example.com · completed\n\nShipped in #12",
    );
  });
});
