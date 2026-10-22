import { describe, expect, it } from "vitest";
import {
  QUEUE_AGE_LIMIT_MS,
  readinessDecision,
  WORKER_HEARTBEAT_STALE_MS,
} from "../src/operations/readiness.js";
import { OPERATION_SAMPLE_KEYS } from "../src/operations/signals.js";

const now = new Date("2026-10-02T12:00:00.000Z");

describe("readiness decision", () => {
  it("stays ready for a fresh worker and a young story branch queue", () => {
    expect(
      readinessDecision({
        newestHeartbeatAt: new Date(now.getTime() - 15_000),
        oldestReadyAt: new Date(now.getTime() - 30_000),
        now,
      }),
    ).toEqual({
      ok: true,
      worker: "ok",
      queue: "ok",
      queueAgeMs: 30_000,
    });
  });

  it("fails when the worker heartbeat is missing or stale", () => {
    expect(readinessDecision({ newestHeartbeatAt: null, oldestReadyAt: null, now }).worker).toBe(
      "down",
    );
    expect(
      readinessDecision({
        newestHeartbeatAt: new Date(now.getTime() - WORKER_HEARTBEAT_STALE_MS - 1),
        oldestReadyAt: null,
        now,
      }),
    ).toMatchObject({ ok: false, worker: "down" });
    expect(
      readinessDecision({
        newestHeartbeatAt: new Date(now.getTime() - WORKER_HEARTBEAT_STALE_MS),
        oldestReadyAt: null,
        now,
      }).worker,
    ).toBe("ok");
  });

  it("fails when the oldest due turn has waited too long and keeps the body free of transcripts", () => {
    const decision = readinessDecision({
      newestHeartbeatAt: now,
      oldestReadyAt: new Date(now.getTime() - QUEUE_AGE_LIMIT_MS - 1),
      now,
    });
    expect(decision).toMatchObject({ ok: false, queue: "stale" });
    expect(JSON.stringify(decision)).not.toMatch(/transcript|prompt|message/i);
    expect(
      readinessDecision({
        newestHeartbeatAt: now,
        oldestReadyAt: new Date(now.getTime() - QUEUE_AGE_LIMIT_MS),
        now,
      }).queue,
    ).toBe("ok");
    expect(readinessDecision({ newestHeartbeatAt: now, oldestReadyAt: null, now }).queue).toBe(
      "ok",
    );
  });

  it("publishes only numeric operation signals", () => {
    expect([...OPERATION_SAMPLE_KEYS]).toEqual([
      "queueAgeSeconds",
      "failedTurns",
      "webhookRejections",
      "mirrorLagSeconds",
      "budgetsExceeded",
    ]);
  });
});
