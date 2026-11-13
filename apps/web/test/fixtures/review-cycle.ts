import type { StoryWorkflowStatus } from "@facility/sdk";
import { coreFixture } from "./core";

export function reviewCycleFixture(): NonNullable<StoryWorkflowStatus["reviewCycle"]> {
  // The core read-contract tests validate this shared wire fixture.
  return coreFixture<NonNullable<StoryWorkflowStatus["reviewCycle"]>>("review-cycle.json");
}
