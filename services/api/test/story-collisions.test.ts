import { describe, expect, it } from "vitest";
import {
  collisionPromptBlock,
  MAX_COLLISION_PATHS,
  MAX_COLLISION_STORIES,
  overlappingPaths,
} from "../src/turns/collisions.js";

describe("story collision helpers", () => {
  it("intersects path sets in a stable order", () => {
    expect(
      overlappingPaths(
        ["src/b.ts", "src/a.ts", "README.md"],
        new Set(["src/a.ts", "src/b.ts", "other"]),
      ),
    ).toEqual(["src/a.ts", "src/b.ts"]);
    expect(overlappingPaths(["src/a.ts"], [])).toEqual([]);
  });

  it("renders nothing without collisions and caps paths and stories in the prompt", () => {
    expect(collisionPromptBlock([])).toBe("");
    const paths = Array.from({ length: MAX_COLLISION_PATHS + 5 }, (_, index) => `src/${index}.ts`);
    const collision = {
      storyId: "story_a",
      title: "Rework billing",
      provider: "github",
      externalId: "41",
      branch: "facility/rework-billing-story_a",
      status: "working",
      overlappingPaths: paths.slice(0, MAX_COLLISION_PATHS),
      overlapCount: paths.length,
    };
    const block = collisionPromptBlock([collision]);
    expect(block).toContain("# Other active stories touch files you changed");
    expect(block).toContain('"Rework billing" (github:41, branch facility/rework-billing-story_a)');
    expect(block).toContain(`src/${MAX_COLLISION_PATHS - 1}.ts (+5 more)`);
    expect(block).not.toContain(`src/${MAX_COLLISION_PATHS}.ts`);

    const many = Array.from({ length: MAX_COLLISION_STORIES + 3 }, (_, index) => ({
      ...collision,
      storyId: `story_${index}`,
      overlappingPaths: ["src/shared.ts"],
      overlapCount: 1,
    }));
    const crowded = collisionPromptBlock(many);
    expect(crowded.split("\n").filter((line) => line.startsWith('- "'))).toHaveLength(
      MAX_COLLISION_STORIES,
    );
    expect(crowded).toContain("- 3 more stories overlap with this one.");
  });
});
