import { costCents } from "@facility/core";
import type { FacilityDb } from "@facility/db";
import { llmRequests, virtualKeys } from "@facility/db";
import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { addBudgetSpend, reconcileBudgetReservations, reserveHardBudgets } from "./budgets.js";
import type { AuthedKey, BudgetState, EnvelopeStore, RequestRecord } from "./types.js";

export function resolveMeteredCost(record: RequestRecord): number {
  const computedCost = costCents({
    model: record.model,
    inputTokens: record.usage.inputTokens,
    outputTokens: record.usage.outputTokens,
    cacheReadTokens: record.usage.cacheReadTokens,
    cacheWriteTokens: record.usage.cacheWriteTokens,
  });
  const measuredCost = record.priced ? (computedCost ?? 0) : 0;
  const usageIncomplete = record.usageComplete === false;
  const conservativeFallback =
    record.status === "error" &&
    record.providerMayHaveCharged &&
    (measuredCost === 0 || usageIncomplete);
  return conservativeFallback
    ? Math.max(measuredCost, record.estimatedCents ?? 0)
    : measuredCost;
}

export function enqueueMetering(
  db: FacilityDb,
  store: EnvelopeStore,
  logger: FastifyBaseLogger,
  record: RequestRecord,
  now: Date,
) {
  return writeMeteringWithRetry(db, store, logger, record, now);
}

async function writeMeteringWithRetry(
  db: FacilityDb,
  store: EnvelopeStore,
  logger: FastifyBaseLogger,
  record: RequestRecord,
  now: Date,
) {
  const delays = [0, 25, 100, 250];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await writeMetering(db, store, logger, record, now);
      return;
    } catch (error) {
      lastError = error;
      logger.warn({ err: error, requestId: record.requestId }, "gateway metering write failed");
    }
  }
  logger.error(
    { err: lastError, requestId: record.requestId, reservations: record.reservations },
    "gateway metering permanently failed; reservation reconciliation may require operator repair",
  );
}

export async function writeMetering(
  db: FacilityDb,
  store: EnvelopeStore,
  logger: FastifyBaseLogger,
  record: RequestRecord,
  now: Date,
) {
  const cost = resolveMeteredCost(record);
  let envelopeUri: string | null = null;
  try {
    envelopeUri = await store.putEnvelope({
      orgId: record.key.orgId,
      requestId: record.requestId,
      now,
      payload: {
        request: record.requestBody,
        response: record.responseBody,
        meta: {
          request_id: record.requestId,
          provider: record.provider,
          model: record.model,
          status: record.status,
          status_code: record.statusCode,
          latency_ms: Date.now() - record.startedAt,
        },
      },
    });
  } catch (error) {
    logger.warn(
      { err: error, requestId: record.requestId },
      "gateway envelope storage failed; recording metering without envelope URI",
    );
    envelopeUri = null;
  }

  const values = {
    id: record.requestId,
    orgId: record.key.orgId,
    projectId: record.key.projectId,
    runId: record.key.runId,
    taskId: record.key.taskId,
    agentDefId: record.key.agentDefId,
    virtualKeyId: record.key.id,
    provider: record.provider,
    model: record.model,
    status: record.status,
    inputTokens: record.usage.inputTokens,
    outputTokens: record.usage.outputTokens,
    cacheRead: record.usage.cacheReadTokens,
    cacheWrite: record.usage.cacheWriteTokens,
    costCents: cost,
    priced: record.priced,
    latencyMs: Date.now() - record.startedAt,
    requestUri: envelopeUri,
    responseUri: envelopeUri,
    error: record.error,
  };

  const reservations = record.reservations ?? [];
  await db.transaction(async (tx) => {
    const updatedReserved = (
      await tx
        .update(llmRequests)
        .set(values)
        .where(and(eq(llmRequests.id, record.requestId), eq(llmRequests.status, "reserved")))
        .returning({ id: llmRequests.id })
    )[0];
    const inserted = updatedReserved
      ? updatedReserved
      : (
          await tx
            .insert(llmRequests)
            .values(values)
            .onConflictDoNothing()
            .returning({ id: llmRequests.id })
        )[0];

    if (!inserted) return;

    if (record.status === "ok" || (record.status === "error" && record.providerMayHaveCharged)) {
      const reservedBudgetIds = new Set(reservations.map((reservation) => reservation.budget.id));
      for (const budget of record.budgets) {
        if (!reservedBudgetIds.has(budget.id)) {
          await addBudgetSpend(tx as unknown as FacilityDb, budget, record.key, cost);
        }
      }
      await reconcileBudgetReservations(tx as unknown as FacilityDb, reservations, cost);
    } else {
      await reconcileBudgetReservations(tx as unknown as FacilityDb, reservations, 0);
    }

    await tx
      .update(virtualKeys)
      .set({ updatedAt: new Date() })
      .where(eq(virtualKeys.id, record.key.id));
  });
}

export async function reserveHardBudgetsAndRecordPending(
  db: FacilityDb,
  states: BudgetState[],
  key: AuthedKey,
  estimatedCents: number,
  record: RequestRecord,
): Promise<
  | { ok: true; reservations: NonNullable<RequestRecord["reservations"]> }
  | { ok: false; budget: BudgetState }
> {
  return db.transaction(async (tx) => {
    const pending = (
      await tx
        .insert(llmRequests)
        .values({
          id: record.requestId,
          orgId: key.orgId,
          projectId: key.projectId,
          runId: key.runId,
          taskId: key.taskId,
          agentDefId: key.agentDefId,
          virtualKeyId: key.id,
          provider: record.provider,
          model: record.model,
          status: "reserved",
          inputTokens: record.usage.inputTokens,
          outputTokens: record.usage.outputTokens,
          cacheRead: record.usage.cacheReadTokens,
          cacheWrite: record.usage.cacheWriteTokens,
          costCents: estimatedCents,
          priced: record.priced,
          latencyMs: Date.now() - record.startedAt,
          error: "budget reservation pending final metering",
        })
        .onConflictDoNothing()
        .returning({ id: llmRequests.id })
    )[0];
    if (!pending) return { ok: true, reservations: [] };

    const reservation = await reserveHardBudgets(
      tx as unknown as FacilityDb,
      states,
      key,
      estimatedCents,
    );
    if (!reservation.ok) {
      await tx.delete(llmRequests).where(eq(llmRequests.id, record.requestId));
      return reservation;
    }
    return reservation;
  });
}
