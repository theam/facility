import { describe, expect, it } from "vitest";
import { ReplaceStoryDeliveryBody } from "../src/story-delivery.js";

const valid = () => ({
  expected_revision: 0,
  declared_complete: true,
  pull_requests: [{ repository: "example/app", number: 12, primary: true }],
  idempotency_key: "delivery-request-1",
});

describe("delivery scope input", () => {
  it("requires explicit completeness while defaulting PRs to required", () => {
    expect(ReplaceStoryDeliveryBody.parse(valid()).pull_requests[0]).toMatchObject({
      required: true,
      primary: true,
    });
    const { declared_complete: _, ...missing } = valid();
    expect(ReplaceStoryDeliveryBody.safeParse(missing).success).toBe(false);
    expect(
      ReplaceStoryDeliveryBody.safeParse({ ...valid(), actor: { id: "spoofed" } }).success,
    ).toBe(false);
  });

  it("rejects duplicates regardless of repository casing, invalid primary and empty completeness", () => {
    const pull = valid().pull_requests[0];
    for (const pull_requests of [
      [pull, { ...pull, repository: "Example/App", primary: false }],
      [{ ...pull, primary: false }],
      [pull, { ...pull, number: 13 }],
      [{ ...pull, required: false }],
      [],
    ]) {
      expect(ReplaceStoryDeliveryBody.safeParse({ ...valid(), pull_requests }).success).toBe(false);
    }
    expect(
      ReplaceStoryDeliveryBody.parse({
        ...valid(),
        declared_complete: false,
        pull_requests: [],
      }).pull_requests,
    ).toEqual([]);
  });

  it("bounds revisions, keys, PR numbers and the full set without accepting URLs as repositories", () => {
    for (const changes of [
      { expected_revision: -1 },
      { expected_revision: 2_147_483_647 },
      { idempotency_key: "short" },
      {
        pull_requests: [{ repository: "https://github.com/example/app", number: 1, primary: true }],
      },
      { pull_requests: [{ repository: "example/app", number: 0, primary: true }] },
      {
        pull_requests: Array.from({ length: 51 }, (_, index) => ({
          repository: "example/app",
          number: index + 1,
          primary: index === 0,
        })),
      },
    ])
      expect(ReplaceStoryDeliveryBody.safeParse({ ...valid(), ...changes }).success).toBe(false);
  });
});
