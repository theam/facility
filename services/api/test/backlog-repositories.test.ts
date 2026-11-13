import { describe, expect, it } from "vitest";
import type { BacklogItem } from "../src/stories/backlog.js";
import { repositoryReferences } from "../src/stories/backlog-repositories.js";

describe("backlog repository references", () => {
  const directory = new Map([
    ["source", { id: "source", name: "example/source" }],
    ["delivery", { id: "delivery", name: "example/delivery" }],
  ]);
  it("counts each source or delivery repository once using canonical scoped names", () => {
    const item = {
      issue: { repositoryId: "source", repository: "old/source" },
      pullRequest: { repositoryId: "source", repository: "old/source" },
      story: { repositoryId: "source" },
    } as Pick<BacklogItem, "issue" | "pullRequest" | "story">;
    expect(
      repositoryReferences(item, directory, ["delivery", "delivery", "source", "foreign"]),
    ).toEqual([
      { id: "source", name: "example/source" },
      { id: "delivery", name: "example/delivery" },
    ]);
  });
  it("includes manual delivery without a source and withholds unknown repository identities", () => {
    const item = { issue: null, pullRequest: null, story: null };
    expect(repositoryReferences(item, directory, ["delivery"])).toEqual([
      { id: "delivery", name: "example/delivery" },
    ]);
    expect(repositoryReferences(item, directory, ["foreign"])).toEqual([]);
    expect(repositoryReferences(item, directory, [])).toEqual([]);
  });
});
