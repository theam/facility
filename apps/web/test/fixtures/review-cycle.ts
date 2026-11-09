import type { StoryWorkflowStatus } from "@facility/sdk";
import fixture from "../../../../packages/core/test/fixtures/review-cycle.json";

export function reviewCycleFixture(): NonNullable<StoryWorkflowStatus["reviewCycle"]> {
  // The core read-contract tests validate this shared wire fixture.
  return structuredClone(fixture) as NonNullable<StoryWorkflowStatus["reviewCycle"]>;
}
