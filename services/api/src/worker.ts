import { createDb } from "@facility/db";
import PgBoss from "pg-boss";
import pino from "pino";
import { readConfig } from "./config.js";
import {
  enqueueFingerprintVerify,
  enqueueGithubIssuesSync,
  processGithubWebhook,
} from "./github/processor.js";
import { runLearningNightly } from "./learning.js";
import { dispatchRun, reconcileSandboxes } from "./sandbox/orchestrator.js";
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
  const queues = [
    "runs.dispatch",
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
  ];
  for (const queue of queues) {
    await boss.createQueue(queue);
  }
  for (const queue of queues) {
    await boss.work(queue, async (job: PgBoss.Job<unknown> | PgBoss.Job<unknown>[]) => {
      const jobId = Array.isArray(job) ? job[0]?.id : job.id;
      const data = Array.isArray(job) ? job[0]?.data : job.data;
      if (queue === "runs.dispatch") {
        await dispatchRun(config, data as { runId?: string; orgId?: string });
      } else if (queue === "sandbox.reconcile") {
        await reconcileSandboxes(config);
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
      } else if (queue === "github.webhook") {
        await processGithubWebhook(
          db,
          config,
          data as { inboundEventId?: string },
          undefined,
          (name, payload) => boss.send(name, payload),
        );
      } else if (queue === "fingerprints.verify") {
        await enqueueFingerprintVerify(db, config, data as { repoId?: string });
      } else if (queue === "github.issues-sync") {
        await enqueueGithubIssuesSync(db, config, data as { repoId?: string; orgId?: string });
      }
      logger.info({ queue, jobId }, "worker completed job");
    });
  }
  await boss.schedule("sandbox.reconcile", "*/2 * * * *", {});
  await boss.schedule("hitl.expire", "0 * * * *", {});
  await boss.schedule("watchtower.outcomes", "0 2 * * *", {});
  await boss.schedule("watchtower.health", "0 3 * * *", {});
  await boss.schedule("watchtower.canary", "0 4 * * 2", {});
  await boss.schedule("analytics.rollup", "5 * * * *", {});
  await boss.schedule("learning.nightly", "0 3 * * *", {});
  logger.info({ queues }, "facility worker started");
  boss.on("stopped", () => void client.end());
  return boss;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
