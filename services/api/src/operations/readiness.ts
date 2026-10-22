import { type FacilityDb, turns, workerHeartbeats } from "@facility/db";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";

/** A worker that misses four beats is gone. The beat interval is 15 seconds. */
export const WORKER_HEARTBEAT_STALE_MS = 60_000;
/** A due turn that nobody has claimed for two minutes is a stuck queue. */
export const QUEUE_AGE_LIMIT_MS = 2 * 60 * 1_000;

export type WorkerReadiness = {
  newestHeartbeatAt: Date | null;
  oldestReadyAt: Date | null;
};

export type ReadinessDecision = {
  ok: boolean;
  worker: "ok" | "down";
  queue: "ok" | "stale";
  queueAgeMs: number | null;
};

export function readinessDecision(input: WorkerReadiness & { now: Date }): ReadinessDecision {
  const heartbeatAt = asDate(input.newestHeartbeatAt);
  const heartbeatAge = heartbeatAt === null ? null : input.now.getTime() - heartbeatAt.getTime();
  const worker = heartbeatAge !== null && heartbeatAge <= WORKER_HEARTBEAT_STALE_MS ? "ok" : "down";
  const readyAt = asDate(input.oldestReadyAt);
  const queueAgeMs = readyAt === null ? null : Math.max(0, input.now.getTime() - readyAt.getTime());
  const queue = queueAgeMs !== null && queueAgeMs > QUEUE_AGE_LIMIT_MS ? "stale" : "ok";
  return { ok: worker === "ok" && queue === "ok", worker, queue, queueAgeMs };
}

export async function readWorkerReadiness(
  db: FacilityDb,
  now = new Date(),
): Promise<WorkerReadiness> {
  const [heartbeat, ready] = await Promise.all([
    db
      .select({ seenAt: sql<Date | string | null>`max(${workerHeartbeats.seenAt})` })
      .from(workerHeartbeats)
      .then((rows) => rows[0]?.seenAt ?? null),
    db
      .select({ createdAt: turns.createdAt })
      .from(turns)
      .where(
        and(eq(turns.state, "queued"), or(isNull(turns.retryAfter), lte(turns.retryAfter, now))),
      )
      .orderBy(asc(turns.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.createdAt ?? null),
  ]);
  return { newestHeartbeatAt: asDate(heartbeat), oldestReadyAt: asDate(ready) };
}

function asDate(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
