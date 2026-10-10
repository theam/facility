import type PgBoss from "pg-boss";
import { expect, it, vi } from "vitest";
import {
  configureTurnQueue,
  registerTurnPool,
  TURN_JOB_EXPIRATION_SECONDS,
  TURN_POOL_SIZE,
} from "../src/turn-queue.js";

it("configures long-running dispatch below the queue provider ceiling", async () => {
  const updateQueue = vi.fn().mockResolvedValue(undefined);
  await configureTurnQueue({ updateQueue });
  expect(updateQueue).toHaveBeenCalledWith("turns.dispatch", {
    name: "turns.dispatch",
    expireInSeconds: TURN_JOB_EXPIRATION_SECONDS,
  });
  expect(TURN_JOB_EXPIRATION_SECONDS).toBeGreaterThan(5 * 60 * 60 + 60 * 60);
  expect(TURN_JOB_EXPIRATION_SECONDS).toBeLessThan(24 * 60 * 60);
});

it("registers a small turn pool that still fetches one job per callback", async () => {
  expect(TURN_POOL_SIZE).toBeGreaterThan(1);
  expect(TURN_POOL_SIZE).toBeLessThanOrEqual(4);
  const work = vi.fn().mockResolvedValue("worker-id");
  const handler = vi.fn();
  await registerTurnPool({ work } as unknown as Pick<PgBoss, "work">, handler);
  expect(work).toHaveBeenCalledTimes(TURN_POOL_SIZE);
  for (const call of work.mock.calls) {
    expect(call[0]).toBe("turns.dispatch");
    expect(call[1]).toEqual({ batchSize: 1 });
    expect(call[2]).toBe(handler);
  }
});
