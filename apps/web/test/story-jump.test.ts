import { describe, expect, it } from "vitest";
import { interpretJumpResponse, resolveLocalJump, type StoryMatch } from "@/lib/story-jump";

const storyA: StoryMatch = {
  number: 5,
  repoId: "repo_a",
  repoOwner: "theam",
  repoName: "facility",
  storyType: "issue",
};
const storyB: StoryMatch = {
  number: 5,
  repoId: "repo_b",
  repoOwner: "theam",
  repoName: "facility-docs",
  storyType: "issue",
};
const storyC: StoryMatch = {
  number: 9,
  repoId: "repo_a",
  repoOwner: "theam",
  repoName: "facility",
  storyType: "issue",
};

describe("resolveLocalJump", () => {
  it("returns the single match when the number is unique on the board", () => {
    expect(resolveLocalJump([storyA, storyC], 9)).toEqual({ kind: "match", story: storyC });
  });

  it("flags an ambiguous number when two repos share it on the board", () => {
    expect(resolveLocalJump([storyA, storyB], 5)).toEqual({
      kind: "ambiguous",
      matches: [storyA, storyB],
    });
  });

  it("reports not-found when nothing on the board matches", () => {
    expect(resolveLocalJump([storyA], 42)).toEqual({ kind: "not-found" });
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("interpretJumpResponse", () => {
  it("resolves a successful lookup to a match", async () => {
    expect(await interpretJumpResponse(jsonResponse(200, storyA))).toEqual({
      kind: "match",
      story: storyA,
    });
  });

  it("maps a 404 to not-found", async () => {
    expect(
      await interpretJumpResponse(jsonResponse(404, { error: { code: "not_found" } })),
    ).toEqual({ kind: "not-found" });
  });

  it("extracts candidate repos from a 409's error details", async () => {
    const outcome = await interpretJumpResponse(
      jsonResponse(409, {
        error: {
          code: "ambiguous_story_number",
          message: "ambiguous",
          details: { matches: [storyA, storyB] },
        },
      }),
    );
    expect(outcome).toEqual({ kind: "ambiguous", matches: [storyA, storyB] });
  });

  it("treats a 409 with no candidate data as ambiguous with an empty list", async () => {
    const outcome = await interpretJumpResponse(jsonResponse(409, { error: {} }));
    expect(outcome).toEqual({ kind: "ambiguous", matches: [] });
  });

  it("distinguishes a server failure from a genuine not-found", async () => {
    const outcome = await interpretJumpResponse(jsonResponse(500, { error: { message: "boom" } }));
    expect(outcome).toEqual({ kind: "error" });
  });
});
