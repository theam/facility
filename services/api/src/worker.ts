import { createDb } from "@facility/db";
import PgBoss from "pg-boss";
import pino from "pino";
import { readConfig } from "./config.js";
import { createGithubClientFactory } from "./github/client.js";
import {
  enqueueFingerprintVerify,
  enqueueGithubIssuesSync,
  processGithubWebhookBatch,
} from "./github/processor.js";
import { expireIdempotencyRecords } from "./idempotency.js";
import { deliverPendingWebhooks } from "./integrations/outbound.js";
import { runLearningNightly } from "./learning.js";
import { destroyPreviewById, provisionPreview, reconcilePreviews } from "./previews.js";
import { deliverPendingRunDeliveries } from "./sandbox/delivery.js";
import {
  dispatchRun,
  reconcileArchitectPlanPublications,
  reconcileSandboxes,
} from "./sandbox/orchestrator.js";
import { runAgentSchedules } from "./schedules.js";
import { runAnalyticsRollup } from "./watchtower/analytics.js";
import { runWatchtowerCanary } from "./watchtower/canary.js";
import { runWatchtowerHealth } from "./watchtower/health.js";
import { runHitlExpire } from "./watchtower/hitl.js";
import { runWatchtowerOutcomes } from "./watchtower/outcomes.js";

export async function startWorker() {
  const config = readConfig();
  const logger = pino({ level: config.logLevel });
  const { db, client } = createDb(config.databaseUrl);
  const boss = new PgBoss({ connectionString: config.databaseUrl });
  boss.on("error", (error) => logger.error({ err: error }, "pg-boss error"));
  await boss.start();
  const githubFactory =
    config.githubAppId && config.githubAppPrivateKey
      ? createGithubClientFactory(config)
      : undefined;
  const queues = [
    "runs.dispatch",
    "deliveries.deliver",
    "architect-plans.publish",
    "watchtower.outcomes",
    "watchtower.health",
    "watchtower.canary",
    "analytics.rollup",
    "learning.nightly",
    "github.webhook",
    "github.issues-sync",
    "fingerprints.verify",
    "hitl.expire",
    "sandbox.reconcile",
    "agent.schedules",
    "webhooks.deliver",
    "idempotency.expire",
    "previews.provision",
    "previews.destroy",
    "previews.reconcile",
  ];
  for (const queue of queues) {
    await boss.createQueue(queue);
  }
  for (const queue of queues) {
    if (queue === "github.webhook") {
      await boss.work<{ inboundEventId?: string }>(
        queue,
        { batchSize: 1_000, includeMetadata: true, pollingIntervalSeconds: 0.5 },
        async (jobs) => {
          const startedAt = Date.now();
          const result = await processGithubWebhookBatch(
            db,
            config,
            jobs.map((job) => job.data),
            githubFactory,
            (name, payload) => boss.send(name, payload),
            {
              warn: (context, message) => logger.warn(context, message),
            },
          );
          const oldestCreatedAt = Math.min(...jobs.map((job) => job.createdOn.getTime()));
          logger.info(
            {
              queue,
              batchSize: jobs.length,
              queueWaitMs: Math.max(0, startedAt - oldestCreatedAt),
              handlerMs: Date.now() - startedAt,
              ...result,
            },
            "worker completed GitHub webhook batch",
          );
        },
      );
      continue;
    }
    await boss.work(queue, async (jobs: PgBoss.Job<unknown>[]) => {
      const job = jobs[0];
      const jobId = job?.id;
      const data = job?.data;
      let result: Record<string, unknown> | undefined;
      if (queue === "runs.dispatch") {
        await dispatchRun(config, data as { runId?: string; orgId?: string });
      } else if (queue === "deliveries.deliver") {
        const deliveries = await deliverPendingRunDeliveries(db, config, {
          runId: String((data as { runId?: string }).runId ?? "") || undefined,
          enqueue: (name, payload) => boss.send(name, payload),
        });
        result = {
          claimed: deliveries.length,
          delivered: deliveries.filter((delivery) => delivery.status === "delivered").length,
          pending: deliveries.filter((delivery) => delivery.status === "pending").length,
          blocked: deliveries.filter((delivery) => delivery.status === "blocked").length,
        };
      } else if (queue === "architect-plans.publish") {
        const publications = await reconcileArchitectPlanPublications(
          db,
          config,
          data as { proposalId?: string; orgId?: string },
          githubFactory,
        );
        result = {
          selected: publications.length,
          published: publications.filter((publication) => publication.status === "published")
            .length,
          closed: publications.filter((publication) => publication.status === "closed").length,
          suppressed: publications.filter((publication) => publication.status === "suppressed")
            .length,
          pending: publications.filter((publication) => publication.status === "pending").length,
        };
      } else if (queue === "sandbox.reconcile") {
        await reconcileSandboxes(config, (name, payload) => boss.send(name, payload));
      } else if (queue === "agent.schedules") {
        result = await runAgentSchedules(config, (targetQueue, targetData, options) =>
          options
            ? boss.send(targetQueue, targetData, options)
            : boss.send(targetQueue, targetData),
        );
      } else if (queue === "webhooks.deliver") {
        await deliverPendingWebhooks(config);
      } else if (queue === "idempotency.expire") {
        await expireIdempotencyRecords(db);
      } else if (queue === "previews.provision") {
        await provisionPreview(config, String((data as { previewId?: string }).previewId ?? ""));
      } else if (queue === "previews.destroy") {
        await destroyPreviewById(config, String((data as { previewId?: string }).previewId ?? ""));
      } else if (queue === "previews.reconcile") {
        result = await reconcilePreviews(config, undefined, (previewId) =>
          boss.send("previews.provision", { previewId }),
        );
      } else if (queue === "watchtower.outcomes") {
        await runWatchtowerOutcomes(config);
      } else if (queue === "watchtower.health") {
        await runWatchtowerHealth(config);
      } else if (queue === "watchtower.canary") {
        await runWatchtowerCanary(config, (name, payload) => boss.send(name, payload));
      } else if (queue === "analytics.rollup") {
        await runAnalyticsRollup(config);
      } else if (queue === "hitl.expire") {
        await runHitlExpire(config);
      } else if (queue === "learning.nightly") {
        await runLearningNightly(config, (targetQueue, targetData) =>
          boss.send(targetQueue, targetData),
        );
      } else if (queue === "fingerprints.verify") {
        await enqueueFingerprintVerify(db, config, data as { repoId?: string }, githubFactory);
      } else if (queue === "github.issues-sync") {
        result = await enqueueGithubIssuesSync(
          db,
          config,
          data as { repoId?: string; orgId?: string },
          githubFactory,
          (targetQueue, targetData) => boss.send(targetQueue, targetData),
        );
      }
      logger.info({ queue, jobId, ...result }, "worker completed job");
    });
  }
  await boss.schedule("sandbox.reconcile", "*/2 * * * *", {});
  await boss.schedule("deliveries.deliver", "* * * * *", {});
  await boss.schedule("architect-plans.publish", "* * * * *", {});
  await boss.schedule("agent.schedules", "* * * * *", {});
  await boss.schedule("webhooks.deliver", "* * * * *", {});
  await boss.schedule("idempotency.expire", "15 2 * * *", {});
  await boss.schedule("previews.reconcile", "*/2 * * * *", {});
  await boss.schedule("hitl.expire", "0 * * * *", {});
  await boss.schedule("watchtower.outcomes", "0 2 * * *", {});
  await boss.schedule("watchtower.health", "0 3 * * *", {});
  await boss.schedule("watchtower.canary", "0 4 * * 2", {});
  await boss.schedule("analytics.rollup", "5 * * * *", {});
  await boss.schedule("learning.nightly", "0 3 * * *", {});
  await boss.schedule("github.issues-sync", "23 */6 * * *", {});
  logger.info({ queues }, "facility worker started");
  boss.on("stopped", () => void client.end());
  return boss;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const boss = await startWorker();
    let closing = false;
    const shutdown = async (signal: NodeJS.Signals) => {
      if (closing) return;
      closing = true;
      console.info(`facility worker received ${signal}; finishing active jobs`);
      try {
        await boss.stop({ graceful: true, timeout: 30_000, close: true });
      } catch (error) {
        console.error("facility worker shutdown failed", error);
        process.exitCode = 1;
      }
    };
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
