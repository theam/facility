import { describe, expect, it } from "vitest";
import {
  indeterminateIdempotencyResponse,
  storedIdempotencyCompletion,
} from "../src/idempotency.js";

describe("stored idempotency completion", () => {
  it("stores replayable successful JSON responses", () => {
    expect(
      storedIdempotencyCompletion(201, Buffer.from(JSON.stringify({ id: "created" }))),
    ).toEqual({
      kind: "replayable",
      statusCode: 201,
      responseBody: { id: "created" },
    });
  });

  it("seals server failures without retaining their response", () => {
    const completion = storedIdempotencyCompletion(500, {
      error: { code: "internal_error", detail: "must-not-persist" },
    });

    expect(completion).toEqual({
      kind: "indeterminate",
      statusCode: 409,
      responseBody: indeterminateIdempotencyResponse(),
    });
    expect(JSON.stringify(completion)).not.toContain("must-not-persist");
  });

  it("refuses replay of a successful one-time secret without storing it", () => {
    const completion = storedIdempotencyCompletion(
      200,
      { id: "key_123", secret: "fak_plaintext" },
      "refuse",
    );

    expect(completion).toEqual({
      kind: "indeterminate",
      statusCode: 409,
      responseBody: indeterminateIdempotencyResponse(),
    });
    expect(JSON.stringify(completion)).not.toContain("fak_plaintext");
  });
});
