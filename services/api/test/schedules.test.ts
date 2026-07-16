import { describe, expect, it } from "vitest";
import { cronMatches, validateScheduleTrigger } from "../src/schedules.js";

describe("agent schedule cron matching", () => {
  it("matches exact UTC minutes and rejects adjacent minutes", () => {
    expect(cronMatches("0 6 * * *", new Date("2026-07-16T06:00:00.000Z"))).toBe(true);
    expect(cronMatches("0 6 * * *", new Date("2026-07-16T06:01:00.000Z"))).toBe(false);
  });

  it("supports lists, ranges, steps, and IANA timezones", () => {
    const instant = new Date("2026-07-16T05:30:00.000Z");
    expect(cronMatches("*/15 6 15-20 7 1,4", instant, "Atlantic/Canary")).toBe(true);
    expect(cronMatches("5/10 6 * * *", new Date("2026-07-16T06:35:00.000Z"))).toBe(true);
  });

  it("uses standard cron OR semantics when day-of-month and weekday are restricted", () => {
    // 2026-07-16 is Thursday, so weekday matches even though day 1 does not.
    expect(cronMatches("0 6 1 * 4", new Date("2026-07-16T06:00:00.000Z"))).toBe(true);
  });

  it("rejects malformed cron expressions and timezones", () => {
    expect(() => cronMatches("0 6 * *", new Date())).toThrow(/five fields/);
    expect(() => cronMatches("60 6 * * *", new Date())).toThrow(/outside/);
    expect(() => cronMatches("0 6 * * *", new Date(), "Mars/Olympus")).toThrow(
      /Invalid IANA timezone/,
    );
    expect(() => validateScheduleTrigger({ type: "schedule", config: {} })).toThrow(/config\.cron/);
  });
});
