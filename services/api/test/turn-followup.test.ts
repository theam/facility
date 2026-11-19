import { describe, expect, it } from "vitest";
import {
  followupExpired,
  followupToolInput,
  turnToolToken,
  verifyTurnToolToken,
} from "../src/turns/followup.js";

describe("native turn follow-up requests", () => {
  const start = new Date("2026-01-01T12:00:00Z");
  const masterKey = "test-key";
  const turnId = "turn_a12";
  const token = turnToolToken(masterKey, turnId, start);

  it("authenticates only the issuing turn within the lifetime", () => {
    expect(verifyTurnToolToken(masterKey, `Bearer ${token}`, start.getTime())).toEqual({
      turnId,
      startedAt: start.getTime(),
    });
    expect(
      verifyTurnToolToken(
        masterKey,
        `Bearer ${token.replace(turnId, "turn_b34")}`,
        start.getTime(),
      ),
    ).toBeNull();
    expect(verifyTurnToolToken("other-key", `Bearer ${token}`, start.getTime())).toBeNull();
    expect(verifyTurnToolToken(masterKey, `Bearer ${token}`, start.getTime() - 1)).toBeNull();
    expect(
      verifyTurnToolToken(masterKey, `Bearer ${token}`, start.getTime() + 24 * 60 * 60_000),
    ).toBeNull();
  });

  it("bounds the wait and rejects scope overrides", () => {
    const request = { delay_seconds: 30, reason: "Wait for the build", context: "job-42" };
    expect(followupToolInput.safeParse(request).success).toBe(true);
    expect(followupToolInput.safeParse({ ...request, delay_seconds: 29 }).success).toBe(false);
    expect(followupToolInput.safeParse({ ...request, delay_seconds: 3_601 }).success).toBe(false);
    expect(followupToolInput.safeParse({ ...request, orgId: "org_other" }).success).toBe(false);
    expect(followupExpired(start, new Date(start.getTime() + 15 * 60_000 - 1))).toBe(false);
    expect(followupExpired(start, new Date(start.getTime() + 15 * 60_000))).toBe(true);
  });
});
