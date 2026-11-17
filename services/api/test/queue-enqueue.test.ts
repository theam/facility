import type PgBoss from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { createQueueEnqueuer } from "../src/queue-enqueue.js";

describe("pg-boss queue initialization", () => {
  it("starts once and creates each queue once for concurrent enqueue calls", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const createQueue = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue("job-id");
    const enqueue = createQueueEnqueuer({ start, createQueue, send } as unknown as Pick<
      PgBoss,
      "start" | "createQueue" | "send"
    >);

    await Promise.all([
      enqueue("github.webhook", { inboundEventId: "one" }),
      enqueue("github.webhook", { inboundEventId: "two" }),
      enqueue("turns.dispatch", { turnId: "three" }),
    ]);

    expect(start).toHaveBeenCalledOnce();
    expect(createQueue.mock.calls.map(([queue]) => queue).sort()).toEqual([
      "github.webhook",
      "turns.dispatch",
    ]);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("allows startup and queue-creation failures to be retried", async () => {
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error("start failed"))
      .mockResolvedValue(undefined);
    const createQueue = vi
      .fn()
      .mockRejectedValueOnce(new Error("queue failed"))
      .mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue("job-id");
    const enqueue = createQueueEnqueuer({ start, createQueue, send } as unknown as Pick<
      PgBoss,
      "start" | "createQueue" | "send"
    >);

    await expect(enqueue("github.webhook", {})).rejects.toThrow("start failed");
    await expect(enqueue("github.webhook", {})).rejects.toThrow("queue failed");
    await expect(enqueue("github.webhook", {})).resolves.toBe("job-id");

    expect(start).toHaveBeenCalledTimes(2);
    expect(createQueue).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledOnce();
  });
});
