import { expect, it, vi } from "vitest";
import { configureTurnQueue, TURN_JOB_EXPIRATION_SECONDS } from "../src/turn-queue.js";

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
