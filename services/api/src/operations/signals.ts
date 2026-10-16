import { randomUUID } from "node:crypto";
import {
  type FacilityDb,
  mirrorSyncs,
  projectBudgets,
  projects,
  turns,
  turnUsage,
  webhookRejections,
  workerHeartbeats,
} from "@facility/db";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { monthWindow } from "../insights/costs.js";
import { readWorkerReadiness } from "./readiness.js";

export const FAILED_TURN_WINDOW_MS = 15 * 60 * 1_000;
export const WEBHOOK_REJECTION_WINDOW_MS = 15 * 60 * 1_000;
export const MIRROR_LAG_LIMIT_SECONDS = 30 * 60;
const REJECTION_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type WebhookRejectionReason = "signature" | "payload";

/** Counts and ages only. Callers must not add messages, payloads, or errors. */
export type OperationSample = {
  queueAgeSeconds: number;
  failedTurns: number;
  webhookRejections: number;
  mirrorLagSeconds: number;
  budgetsExceeded: number;
};

export const OPERATION_SAMPLE_KEYS = [
  "queueAgeSeconds",
  "failedTurns",
  "webhookRejections",
  "mirrorLagSeconds",
  "budgetsExceeded",
] as const satisfies readonly (keyof OperationSample)[];

export async function beatWorker(db: FacilityDb, workerId: string, seenAt = new Date()) {
  await db
    .insert(workerHeartbeats)
    .values({ id: workerId, seenAt })
    .onConflictDoUpdate({ target: workerHeartbeats.id, set: { seenAt } });
}

export async function recordWebhookRejection(
  db: FacilityDb,
  reason: WebhookRejectionReason,
  receivedAt = new Date(),
) {
  await db.insert(webhookRejections).values({ id: randomUUID(), reason, receivedAt });
}

export async function recordMirrorSync(
  db: FacilityDb,
  project: { orgId: string; projectId: string },
  syncedAt = new Date(),
) {
  await db
    .insert(mirrorSyncs)
    .values({ projectId: project.projectId, orgId: project.orgId, syncedAt })
    .onConflictDoUpdate({
      target: mirrorSyncs.projectId,
      set: { orgId: project.orgId, syncedAt },
    });
}

export async function operationSample(db: FacilityDb, now = new Date()): Promise<OperationSample> {
  const sinceFailures = new Date(now.getTime() - FAILED_TURN_WINDOW_MS);
  const sinceRejections = new Date(now.getTime() - WEBHOOK_REJECTION_WINDOW_MS);
  const [start, end] = monthWindow(now);
  const startAt = timestamptz(start);
  const endAt = timestamptz(end);
  const nowAt = timestamptz(now);
  const [ready, failed, rejections, mirror, budgets] = await Promise.all([
    readWorkerReadiness(db, now),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(turns)
      .where(and(eq(turns.state, "failed"), gte(turns.endedAt, sinceFailures)))
      .then((rows) => Number(rows[0]?.count ?? 0)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(webhookRejections)
      .where(gte(webhookRejections.receivedAt, sinceRejections))
      .then((rows) => Number(rows[0]?.count ?? 0)),
    db
      .select({
        lag: sql<
          number | string | null
        >`max(extract(epoch from (${nowAt} - coalesce(${mirrorSyncs.syncedAt}, ${projects.createdAt}))))`,
      })
      .from(projects)
      .leftJoin(mirrorSyncs, eq(mirrorSyncs.projectId, projects.id))
      .where(eq(projects.status, "active"))
      .then((rows) => Number(rows[0]?.lag ?? 0)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(projectBudgets)
      .where(
        and(
          eq(projectBudgets.enabled, true),
          sql`coalesce((
            select sum(${turnUsage.costCents}) from ${turnUsage}
            where ${turnUsage.projectId} = ${projectBudgets.projectId}
              and ${turnUsage.createdAt} >= ${startAt}
              and ${turnUsage.createdAt} < ${endAt}
          ), 0) >= ${projectBudgets.monthlyLimitCents}`,
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0)),
  ]);
  await db
    .delete(webhookRejections)
    .where(lt(webhookRejections.receivedAt, new Date(now.getTime() - REJECTION_RETENTION_MS)));
  const queueAgeMs = ready.oldestReadyAt
    ? Math.max(0, now.getTime() - ready.oldestReadyAt.getTime())
    : 0;
  return {
    queueAgeSeconds: Math.floor(queueAgeMs / 1000),
    failedTurns: failed,
    webhookRejections: rejections,
    mirrorLagSeconds: Number.isFinite(mirror) ? Math.max(0, Math.floor(mirror)) : 0,
    budgetsExceeded: budgets,
  };
}

function timestamptz(value: Date) {
  return sql.raw(`timestamptz '${value.toISOString()}'`);
}
