import { describe, expect, it } from "vitest";
import { nextOccurrence } from "../src/agents/scheduler.js";

describe("agent scheduler clock", () => {
  it("uses the trigger timezone across daylight-saving boundaries", () => {
    const beforeSpringForward = new Date("2026-03-08T06:59:00.000Z");
    expect(nextOccurrence("0 2 * * *", "America/New_York", beforeSpringForward)).toEqual(
      new Date("2026-03-08T07:00:00.000Z"),
    );

    const beforeFallBack = new Date("2026-11-01T04:00:00.000Z");
    expect(nextOccurrence("30 1 * * *", "America/New_York", beforeFallBack)).toEqual(
      new Date("2026-11-01T05:30:00.000Z"),
    );
  });

  it("returns the same scheduled instant when a calculation is retried", () => {
    const current = new Date("2026-07-14T12:34:56.000Z");
    const first = nextOccurrence("15 9 * * 1-5", "Europe/Madrid", current);
    const retried = nextOccurrence("15 9 * * 1-5", "Europe/Madrid", current);

    expect(retried).toEqual(first);
    expect(first).toEqual(new Date("2026-07-15T07:15:00.000Z"));
  });
});
