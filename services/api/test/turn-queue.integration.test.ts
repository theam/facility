import { randomUUID } from "node:crypto";
import PgBoss from "pg-boss";
import { expect, it } from "vitest";
import { configureTurnQueue, TURN_JOB_EXPIRATION_SECONDS } from "../src/turn-queue.js";

it("replaces the short queue default and persists the long lease on a real dispatch job", async () => {
  const boss = new PgBoss({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test",
    schema: `queue_${randomUUID().replaceAll("-", "")}`,
  });
  const name = "turns.dispatch";
  await boss.start();
  try {
    await boss.createQueue(name, { name, expireInSeconds: 900 });
    await configureTurnQueue(boss);
    const id = await boss.send(name, { turnId: "turn_long_running" });
    expect(id).toBeTruthy();
    const jobs = await boss.fetch(name);
    expect(jobs).toHaveLength(1);
    expect(Number(jobs[0]?.expireInSeconds)).toBe(TURN_JOB_EXPIRATION_SECONDS);
    if (!id) throw new Error("job fixture missing");
    await boss.complete(name, id);
    expect((await boss.getJobById(name, id))?.state).toBe("completed");
  } finally {
    await boss.stop({ graceful: false });
  }
});
