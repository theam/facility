import type PgBoss from "pg-boss";
import type { Logger } from "pino";

export function registerGithubWebhookWorker(
  boss: Pick<PgBoss, "work">,
  handleInbound: (inboundEventId: string) => Promise<unknown>,
  logger: Pick<Logger, "info">,
) {
  return boss.work<{ inboundEventId?: string }>(
    "github.webhook",
    // pg-boss retries the entire callback batch on rejection. Keep each delivery independent.
    { batchSize: 1, includeMetadata: true, pollingIntervalSeconds: 0.5 },
    async (jobs) => {
      const job = jobs[0];
      if (!job) return;
      const startedAt = Date.now();
      if (job.data.inboundEventId) {
        await handleInbound(job.data.inboundEventId);
      }
      logger.info(
        {
          queue: "github.webhook",
          jobId: job.id,
          queueWaitMs: Math.max(0, startedAt - job.createdOn.getTime()),
          handlerMs: Date.now() - startedAt,
        },
        "worker completed GitHub webhook delivery",
      );
    },
  );
}
