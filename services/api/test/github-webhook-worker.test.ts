import type PgBoss from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { registerGithubWebhookWorker } from "../src/github/webhook-worker.js";

describe("GitHub webhook retry boundary", () => {
  it("gives pg-boss one delivery per callback and propagates failures for retry", async () => {
    const work = vi.fn().mockResolvedValue("worker-id");
    const handle = vi.fn().mockResolvedValue({ queued: 1 });
    const logger = { info: vi.fn() };
    await registerGithubWebhookWorker({ work } as unknown as Pick<PgBoss, "work">, handle, logger);
    expect(work).toHaveBeenCalledWith(
      "github.webhook",
      expect.objectContaining({ batchSize: 1, includeMetadata: true }),
      expect.any(Function),
    );
    const callback = work.mock.calls[0]?.[2];
    const job = { id: "job-1", data: { inboundEventId: "delivery-1" }, createdOn: new Date() };
    const failure = new Error("provider unavailable");
    handle.mockRejectedValueOnce(failure);
    await expect(callback([job])).rejects.toBe(failure);
    expect(logger.info).not.toHaveBeenCalled();
    await callback([{ ...job, id: "job-2", data: { inboundEventId: "delivery-2" } }]);
    expect(handle).toHaveBeenLastCalledWith("delivery-2");
    expect(logger.info).toHaveBeenCalledOnce();
  });
});
