import { createDb, type FacilityDb, turns } from "@facility/db";
import { and, asc, eq, lte } from "drizzle-orm";
import PgBoss from "pg-boss";
import pino from "pino";
import { readConfig } from "./config.js";
import { createGithubClientFactory } from "./github/client.js";
import type { StoryWorkspaceService } from "./stories/service.js";
import { createStoryDomain } from "./story-domain.js";

const TURN_LEASE_TIMEOUT_MS = 2 * 60 * 1_000;

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
  const storyDomain = createStoryDomain({
    db,
    config,
    githubFactory,
    enqueue: (queue, data) => boss.send(queue, data),
    logger,
  });
  const queues = ["turns.dispatch", "github.webhook", "github.mirror", "agent.schedules"];
  for (const queue of queues) {
    await boss.createQueue(queue);
  }
  const interruptedAtStartup = await recoverInterruptedTurns(
    db,
    storyDomain.stories,
    new Date(),
    TURN_LEASE_TIMEOUT_MS,
    (turn) => storyDomain.dispatcher.activateQueuedSuccessor(turn),
  );
  const queuedAtStartup = await recoverQueuedTurns(db, (queue, data) => boss.send(queue, data));
  if (interruptedAtStartup > 0 || queuedAtStartup > 0) {
    logger.info(
      { interruptedTurns: interruptedAtStartup, queuedTurns: queuedAtStartup },
      "recovered durable turns at startup",
    );
  }
  for (const queue of queues) {
    if (queue === "github.webhook") {
      await boss.work<{ inboundEventId?: string }>(
        queue,
        { batchSize: 1_000, includeMetadata: true, pollingIntervalSeconds: 0.5 },
        async (jobs) => {
          const startedAt = Date.now();
          for (const job of jobs) {
            if (job.data.inboundEventId) {
              await storyDomain.githubTriggers.handleInbound(job.data.inboundEventId);
            }
          }
          const oldestCreatedAt = Math.min(...jobs.map((job) => job.createdOn.getTime()));
          logger.info(
            {
              queue,
              batchSize: jobs.length,
              queueWaitMs: Math.max(0, startedAt - oldestCreatedAt),
              handlerMs: Date.now() - startedAt,
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
      if (queue === "turns.dispatch") {
        result = await storyDomain.dispatcher.dispatch(
          data as { orgId: string; projectId: string; turnId: string },
        );
      } else if (queue === "github.mirror") {
        result = await storyDomain.mirror.syncAll();
      } else if (queue === "agent.schedules") {
        const interruptedTurns = await recoverInterruptedTurns(
          db,
          storyDomain.stories,
          new Date(),
          TURN_LEASE_TIMEOUT_MS,
          (turn) => storyDomain.dispatcher.activateQueuedSuccessor(turn),
        );
        const recoveredTurns = await recoverQueuedTurns(db, (name, payload) =>
          boss.send(name, payload),
        );
        result = { ...(await storyDomain.scheduler.tick()), interruptedTurns, recoveredTurns };
      }
      logger.info({ queue, jobId, ...result }, "worker completed job");
    });
  }
  await boss.schedule("agent.schedules", "* * * * *", {});
  await boss.schedule("github.mirror", "*/10 * * * *", {});
  logger.info({ queues }, "facility worker started");
  boss.on("stopped", () => void client.end());
  return boss;
}

export async function recoverQueuedTurns(
  db: FacilityDb,
  enqueue: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
  limit = 1_000,
) {
  const queued = await db
    .select({ id: turns.id, orgId: turns.orgId, projectId: turns.projectId })
    .from(turns)
    .where(eq(turns.state, "queued"))
    .orderBy(asc(turns.createdAt))
    .limit(limit);
  for (const turn of queued) {
    await enqueue("turns.dispatch", {
      orgId: turn.orgId,
      projectId: turn.projectId,
      turnId: turn.id,
    });
  }
  return queued.length;
}

export async function recoverInterruptedTurns(
  db: FacilityDb,
  stories: StoryWorkspaceService,
  now = new Date(),
  leaseTimeoutMs = TURN_LEASE_TIMEOUT_MS,
  onRecovered?: (turn: {
    orgId: string;
    projectId: string;
    storyId: string;
    turnId: string;
  }) => Promise<unknown>,
) {
  const staleBefore = new Date(now.getTime() - leaseTimeoutMs);
  const running = await db
    .select({
      id: turns.id,
      orgId: turns.orgId,
      projectId: turns.projectId,
      storyId: turns.storyId,
    })
    .from(turns)
    .where(and(eq(turns.state, "running"), lte(turns.updatedAt, staleBefore)))
    .orderBy(asc(turns.updatedAt))
    .limit(1_000);
  let recovered = 0;
  for (const turn of running) {
    if (
      await stories.recoverInterruptedTurn({
        orgId: turn.orgId,
        projectId: turn.projectId,
        turnId: turn.id,
        staleBefore,
      })
    ) {
      recovered += 1;
      await onRecovered?.({
        orgId: turn.orgId,
        projectId: turn.projectId,
        storyId: turn.storyId,
        turnId: turn.id,
      });
    }
  }
  return recovered;
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
