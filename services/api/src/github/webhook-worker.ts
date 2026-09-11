import type PgBoss from "pg-boss";
import type { Logger } from "pino";
import { githubRateLimitRetryAt } from "./rate-limit.js";

export function registerGithubWebhookWorker(
  boss: Pick<PgBoss, "work" | "send">,
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
        try {
          await handleInbound(job.data.inboundEventId);
        } catch (error) {
          const retryAt = githubRateLimitRetryAt(error);
          if (!retryAt) throw error;
          // The durable receipt stays unprocessed. Complete this attempt only
          // after its replacement is persisted; permission is checked again.
          const replacement = await boss.send("github.webhook", job.data, { startAfter: retryAt });
          if (!replacement) throw new Error("GitHub rate-limit retry was not enqueued");
          logger.info(
            { queue: "github.webhook", jobId: job.id, retryAt },
            "deferred GitHub webhook until provider rate limit resets",
          );
          return;
        }
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
