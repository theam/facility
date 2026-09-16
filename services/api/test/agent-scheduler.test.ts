import { describe, expect, it } from "vitest";
import { nextOccurrence, scheduleAdvance } from "../src/agents/scheduler.js";

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

describe("agent scheduler catch-up", () => {
  const hourly = ["0 * * * *", "UTC"] as const;

  it("leaves an on-time claim exactly where it was", () => {
    const dueAt = new Date("2026-09-07T06:00:00.000Z");
    // The worker ticks every minute, so a claim lands within the same period as
    // the occurrence it satisfies rather than precisely on it.
    for (const now of [dueAt, new Date("2026-09-07T06:00:07.000Z")]) {
      const advance = scheduleAdvance(...hourly, dueAt, now);
      expect(advance.nextRunAt).toEqual(new Date("2026-09-07T07:00:00.000Z"));
      expect(advance.nextRunAt).toEqual(nextOccurrence(...hourly, dueAt));
      expect(advance.missed).toBe(false);
    }
  });

  it("collapses a backlog of any size into a single claim", () => {
    const dueAt = new Date("2026-09-06T06:00:00.000Z");
    const now = new Date("2026-09-07T06:00:00.000Z");

    const advance = scheduleAdvance(...hourly, dueAt, now);
    expect(advance.nextRunAt).toEqual(new Date("2026-09-07T07:00:00.000Z"));
    expect(advance.missed).toBe(true);

    // The loop the tick performs: claim while due. Advancing one cron step from
    // the stored occurrence dispatches once per missed hour; advancing from now
    // leaves the schedule ahead of the clock after a single claim.
    let claims = 0;
    let nextRunAt = dueAt;
    while (nextRunAt <= now) {
      nextRunAt = scheduleAdvance(...hourly, nextRunAt, now).nextRunAt;
      claims += 1;
    }
    expect(claims).toBe(1);
    expect(nextRunAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it("reports a single missed occurrence, not only a long outage", () => {
    // One tick late by more than a period: still a coalesced claim, and the
    // difference between this and a normal minute is what the counter carries.
    const advance = scheduleAdvance(
      "*/5 * * * *",
      "UTC",
      new Date("2026-09-07T06:00:00.000Z"),
      new Date("2026-09-07T06:07:00.000Z"),
    );
    expect(advance.nextRunAt).toEqual(new Date("2026-09-07T06:10:00.000Z"));
    expect(advance.missed).toBe(true);
  });

  it("keeps the trigger timezone when catching up across a daylight-saving shift", () => {
    // The outage spans spring-forward. 02:00 local does not exist on 2026-03-08
    // in New York, so a UTC-arithmetic catch-up would land an hour off.
    const advance = scheduleAdvance(
      "0 2 * * *",
      "America/New_York",
      new Date("2026-03-06T07:00:00.000Z"),
      new Date("2026-03-09T12:00:00.000Z"),
    );
    expect(advance.nextRunAt).toEqual(new Date("2026-03-10T06:00:00.000Z"));
    expect(advance.missed).toBe(true);
  });

  it("never moves a schedule backwards when the clock is behind its due instant", () => {
    // Defensive: the tick only selects nextRunAt <= now, but the function is
    // total and must not hand back an occurrence the claim would re-fire.
    const dueAt = new Date("2026-09-07T06:00:00.000Z");
    const advance = scheduleAdvance(...hourly, dueAt, new Date("2026-09-07T05:30:00.000Z"));
    expect(advance.nextRunAt).toEqual(new Date("2026-09-07T07:00:00.000Z"));
    expect(advance.missed).toBe(false);
  });
});
