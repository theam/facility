import { BudgetPolicyError } from "./budget-policy.js";
import { ModelCallLedger, type ModelCallReceipt, type ModelCallSettlement } from "./model-calls.js";

export { BudgetPolicyError } from "./budget-policy.js";

import { costCents, newId, normalizeModel, reservationCents } from "@facility/core";
import {
  budgetReservations,
  type FacilityDb,
  modelCalls,
  projectBudgets,
  storyConsultations,
  turns,
  turnUsage,
} from "@facility/db";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { AgentTurnUsage } from "../turns/engines.js";

export type BudgetState = {
  budget: typeof projectBudgets.$inferSelect | null;
  windowStart: Date;
  windowEnd: Date;
  spentCents: number;
  remainingCents: number | null;
  percentUsed: number | null;
  state: "not_configured" | "disabled" | "ok" | "warning" | "exceeded" | "unconfirmed";
};

export class CostBudgetService {
  private readonly apiCalls: ModelCallLedger;
  constructor(private readonly db: FacilityDb) {
    this.apiCalls = new ModelCallLedger(db, {
      lockBudget,
      committedCents,
      hasUnconfirmedUsage,
      assertRoom,
    });
  }

  async assertTurnAllowed(orgId: string, projectId: string, model: string, now = new Date()) {
    const state = await this.budgetState(orgId, projectId, now);
    if (!state.budget?.enabled) return state;
    if (state.state === "unconfirmed") {
      throw new BudgetPolicyError(
        "budget_usage_unconfirmed",
        "Project spending is unconfirmed after an agent or API call; new model calls are blocked while the budget is enabled.",
      );
    }
    if (!normalizeModel(model)) {
      throw new BudgetPolicyError(
        "budget_model_unpriced",
        `Model ${model} has no price entry, so the project budget cannot safely account for this turn`,
      );
    }
    if (state.spentCents >= state.budget.monthlyLimitCents) {
      throw new BudgetPolicyError(
        "budget_exceeded",
        exhaustedMessage(state.spentCents, state.budget.monthlyLimitCents),
      );
    }
    return state;
  }

  /**
   * Hold this turn's estimate inside the claim transaction. The budget row lock
   * serializes admissions, so two workers cannot both pass a limit that fits one hold.
   * Returns the reservation id, or null when the project is not enforcing a budget
   * or the priced estimate is zero.
   */
  async reserveTurn(
    tx: FacilityDb,
    input: { orgId: string; projectId: string; storyId: string; turnId: string; model: string },
    now = new Date(),
  ) {
    const budget = await lockBudget(tx, input.orgId, input.projectId);
    await releaseOpenTurnReservation(tx, input);
    if (!budget?.enabled) return null;
    if (await hasUnconfirmedUsage(tx, input.orgId, input.projectId)) {
      throw new BudgetPolicyError(
        "budget_usage_unconfirmed",
        "Project spending is unconfirmed; new model calls are blocked while the budget is enabled.",
      );
    }
    const estimate = reservationCents(input.model, "turn");
    if (estimate === null) {
      throw new BudgetPolicyError(
        "budget_model_unpriced",
        `Model ${input.model} has no price entry, so the project budget cannot safely account for this turn`,
      );
    }
    const committed = await committedCents(tx, input.orgId, input.projectId, now);
    assertRoom(committed, estimate, budget.monthlyLimitCents, "turn");
    if (estimate === 0) return null;
    const id = newId("evt");
    await tx.insert(budgetReservations).values({
      id,
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      turnId: input.turnId,
      purpose: "turn",
      state: "open",
      model: input.model,
      reservedCents: estimate,
    });
    return id;
  }

  reserveTitle(
    input: {
      orgId: string;
      projectId: string;
      storyId: string;
      model: string;
      provider?: "openai" | "anthropic";
      requestKey?: string;
      fingerprint?: string;
    },
    now = new Date(),
  ) {
    return this.apiCalls.reserveTitle(input, now);
  }

  claimModelCall(
    input: { orgId: string; projectId: string; storyId: string; callId: string },
    now = new Date(),
    claimed?: (tx: FacilityDb, claimToken: string) => Promise<void>,
  ) {
    return this.apiCalls.claim(input, now, claimed);
  }

  reserveConsultation(
    input: {
      orgId: string;
      projectId: string;
      storyId: string;
      model: string;
      provider: "openai" | "anthropic";
      requestKey: string;
      fingerprint: string;
    },
    now = new Date(),
    admitted?: (
      tx: FacilityDb,
      receipt: { callId: string; reservationId: string },
    ) => Promise<void>,
  ) {
    return this.apiCalls.reserveConsultation(input, now, admitted);
  }

  settleModelCall<T>(
    input: ModelCallSettlement,
    publish?: (tx: FacilityDb, receipt: ModelCallReceipt) => Promise<T>,
  ) {
    return this.apiCalls.settle(input, publish);
  }

  settleTitle<T>(
    input: ModelCallSettlement,
    publish?: (tx: FacilityDb, receipt: ModelCallReceipt) => Promise<T>,
  ) {
    return this.apiCalls.settle(input, publish);
  }

  releaseReservation(
    id: string | null,
    scope: { orgId: string; projectId: string; storyId: string },
  ) {
    return this.apiCalls.release(id, scope);
  }

  recoverModelCalls(now = new Date()) {
    return this.apiCalls.recover(now);
  }

  async record(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    turnId: string;
    agentName: string;
    engine: string;
    model: string;
    usage?: AgentTurnUsage;
    durationMs: number;
    status: "succeeded" | "failed";
    /** False means these counters are only a lower bound, never a zero-cost completion. */
    complete?: boolean;
  }) {
    return this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await lockBudget(tx, input.orgId, input.projectId);
      if (!input.usage && input.complete !== false) {
        await releaseOpenTurnReservation(tx, input);
        return null;
      }
      const usage = input.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const calculated = input.usage
        ? costCents({
            model: input.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
          })
        : null;
      const providerCost = finiteNonNegative(usage.reportedCostCents);
      const cost = providerCost ?? calculated;
      const values: typeof turnUsage.$inferInsert = {
        id: newId("evt"),
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: input.storyId,
        turnId: input.turnId,
        agentName: input.agentName,
        engine: input.engine,
        model: input.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        costCents: cost,
        priced: input.complete !== false && cost !== null,
        source:
          input.complete === false
            ? "unpriced"
            : providerCost !== undefined
              ? "provider"
              : calculated !== null
                ? "price_book"
                : "unpriced",
        durationMs: Math.min(2_147_483_647, Math.max(0, Math.round(input.durationMs))),
        status: input.status,
      };
      const insert = tx.insert(turnUsage).values(values);
      const { id: _id, ...settled } = values;
      // A late live dispatcher can also settle the recovery placeholder. Never
      // overwrite an already priced charge. Confirmed usage enters the budget
      // when it is accounted, just like an ordinary live-worker completion.
      const write = input.usage
        ? insert.onConflictDoUpdate({
            target: turnUsage.turnId,
            set: { ...settled, ...(values.priced ? { createdAt: new Date() } : {}) },
            setWhere: and(
              eq(turnUsage.orgId, input.orgId),
              eq(turnUsage.projectId, input.projectId),
              eq(turnUsage.storyId, input.storyId),
              eq(turnUsage.priced, false),
            ),
          })
        : insert.onConflictDoNothing({ target: turnUsage.turnId });
      const row = (await write.returning())[0];
      await releaseOpenTurnReservation(tx, input);
      return row ?? null;
    });
  }

  async budgetState(orgId: string, projectId: string, now = new Date()): Promise<BudgetState> {
    const [windowStart, windowEnd] = monthWindow(now);
    const [budget, spentCents, unconfirmed] = await Promise.all([
      this.db
        .select()
        .from(projectBudgets)
        .where(and(eq(projectBudgets.orgId, orgId), eq(projectBudgets.projectId, projectId)))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      committedCents(this.db, orgId, projectId, now),
      hasUnconfirmedUsage(this.db, orgId, projectId),
    ]);
    if (!budget) {
      return {
        budget: null,
        windowStart,
        windowEnd,
        spentCents,
        remainingCents: null,
        percentUsed: null,
        state: "not_configured",
      };
    }
    const remainingCents = Math.max(0, budget.monthlyLimitCents - spentCents);
    const percentUsed =
      budget.monthlyLimitCents === 0
        ? spentCents > 0
          ? 100
          : 0
        : (spentCents / budget.monthlyLimitCents) * 100;
    const state = !budget.enabled
      ? "disabled"
      : unconfirmed
        ? "unconfirmed"
        : spentCents >= budget.monthlyLimitCents
          ? "exceeded"
          : percentUsed >= budget.warningPercent
            ? "warning"
            : "ok";
    return { budget, windowStart, windowEnd, spentCents, remainingCents, percentUsed, state };
  }

  async usage(orgId: string, projectId: string, from: Date, to: Date, limit = 100) {
    const [rows, totals] = await Promise.all([
      this.db
        .select()
        .from(turnUsage)
        .where(
          and(
            eq(turnUsage.orgId, orgId),
            eq(turnUsage.projectId, projectId),
            gte(turnUsage.createdAt, from),
            lt(turnUsage.createdAt, to),
          ),
        )
        .orderBy(desc(turnUsage.createdAt))
        .limit(limit),
      this.db
        .select({
          turns: sql<number>`count(*)::int`,
          inputTokens: sql<number>`coalesce(sum(${turnUsage.inputTokens}), 0)::float8`,
          outputTokens: sql<number>`coalesce(sum(${turnUsage.outputTokens}), 0)::float8`,
          cacheReadTokens: sql<number>`coalesce(sum(${turnUsage.cacheReadTokens}), 0)::float8`,
          cacheWriteTokens: sql<number>`coalesce(sum(${turnUsage.cacheWriteTokens}), 0)::float8`,
          costCents: sql<number>`coalesce(sum(${turnUsage.costCents}), 0)::float8`,
          unpricedTurns: sql<number>`count(*) filter (where not ${turnUsage.priced})::int`,
        })
        .from(turnUsage)
        .where(
          and(
            eq(turnUsage.orgId, orgId),
            eq(turnUsage.projectId, projectId),
            gte(turnUsage.createdAt, from),
            lt(turnUsage.createdAt, to),
          ),
        )
        .then((values) => values[0]),
    ]);
    return {
      from,
      to,
      summary: totals ?? {
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costCents: 0,
        unpricedTurns: 0,
      },
      usage: rows,
    };
  }
}

export function monthWindow(now: Date): [Date, Date] {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return [start, end];
}

function finiteNonNegative(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * A hold fits only when spend is still under the cap and the estimate does not
 * cross it. A zero estimate still fails once spend has reached the cap.
 */
export function reservationFits(committed: number, estimate: number, limit: number) {
  return committed < limit && committed + estimate <= limit;
}

function exhaustedMessage(committed: number, limit: number) {
  return `Project monthly budget is exhausted (${committed.toFixed(2)} of ${limit} cents)`;
}

function assertRoom(
  committed: number,
  estimate: number,
  limit: number,
  purpose: "turn" | "title" | "consultation",
) {
  if (committed >= limit) {
    throw new BudgetPolicyError("budget_exceeded", exhaustedMessage(committed, limit));
  }
  if (committed + estimate > limit) {
    throw new BudgetPolicyError(
      "budget_exceeded",
      `Project monthly budget cannot reserve this ${purpose} (${committed.toFixed(2)} spent of ${limit} cents; ${estimate.toFixed(2)} cents required)`,
    );
  }
}

async function lockBudget(db: FacilityDb, orgId: string, projectId: string) {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`facility:budget:${orgId}:${projectId}`}))`,
  );
  return (
    await db
      .select()
      .from(projectBudgets)
      .where(and(eq(projectBudgets.orgId, orgId), eq(projectBudgets.projectId, projectId)))
      .limit(1)
      .for("update")
  )[0];
}

/** Measured turn usage, open holds, legacy title receipts and API charges, each counted once. */
export async function committedCents(
  db: FacilityDb,
  orgId: string,
  projectId: string,
  now = new Date(),
) {
  const [start, end] = monthWindow(now);
  // postgres.js cannot bind a Date for a timestamptz parameter. These values
  // come from monthWindow, so the literal is a fixed UTC timestamp.
  const windowStart = sql.raw(`timestamptz '${start.toISOString()}'`);
  const windowEnd = sql.raw(`timestamptz '${end.toISOString()}'`);
  const result = await db.execute<{ spent_cents: number | string }>(sql`
    select (
      coalesce((
        select sum(${turnUsage.costCents})
        from ${turnUsage}
        where ${turnUsage.orgId} = ${orgId}
          and ${turnUsage.projectId} = ${projectId}
          and ${turnUsage.createdAt} >= ${windowStart}
          and ${turnUsage.createdAt} < ${windowEnd}
      ), 0)
      + coalesce((
        select sum(${budgetReservations.reservedCents})
        from ${budgetReservations}
        where ${budgetReservations.orgId} = ${orgId}
          and ${budgetReservations.projectId} = ${projectId}
          and (
            ${budgetReservations.state} = 'open'
            or (
              ${budgetReservations.state} = 'settled'
              and ${budgetReservations.modelCallId} is null
              and ${budgetReservations.createdAt} >= ${windowStart}
              and ${budgetReservations.createdAt} < ${windowEnd}
            )
          )
      ), 0)
      + coalesce((
        select sum(${modelCalls.costCents}) from ${modelCalls}
        where ${modelCalls.orgId} = ${orgId} and ${modelCalls.projectId} = ${projectId}
          and ${modelCalls.state} in ('confirmed', 'unconfirmed')
          and ${modelCalls.settledAt} >= ${windowStart} and ${modelCalls.settledAt} < ${windowEnd}
      ), 0)
    )::float8 as spent_cents
  `);
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: Array<{ spent_cents: number | string }> }).rows ?? []);
  const spent = Number(rows[0]?.spent_cents ?? 0);
  return Number.isFinite(spent) ? spent : 0;
}

export async function releaseOpenTurnReservation(
  db: FacilityDb,
  input: { orgId: string; projectId: string; turnId: string },
) {
  await db
    .delete(budgetReservations)
    .where(
      and(
        eq(budgetReservations.orgId, input.orgId),
        eq(budgetReservations.projectId, input.projectId),
        eq(budgetReservations.turnId, input.turnId),
        eq(budgetReservations.purpose, "turn"),
        eq(budgetReservations.state, "open"),
      ),
    );
}

async function hasUnconfirmedUsage(db: FacilityDb, orgId: string, projectId: string) {
  // Calendar rollover and an increased cap cannot establish a missing bill.
  const rows = await db
    .select({ id: turnUsage.id })
    .from(turnUsage)
    .where(
      and(
        eq(turnUsage.orgId, orgId),
        eq(turnUsage.projectId, projectId),
        eq(turnUsage.priced, false),
      ),
    )
    .limit(1);
  if (rows.length > 0) return true;
  const uncertainCalls = await db
    .select({ id: modelCalls.id })
    .from(modelCalls)
    .where(
      and(
        eq(modelCalls.orgId, orgId),
        eq(modelCalls.projectId, projectId),
        sql`(${modelCalls.state} = 'unconfirmed' or (${modelCalls.state} = 'started' and ${modelCalls.expiresAt} <= now()))`,
      ),
    )
    .limit(1);
  if (uncertainCalls.length > 0) return true;
  const expiredConsultations = await db
    .select({ id: storyConsultations.id })
    .from(storyConsultations)
    .innerJoin(
      modelCalls,
      and(
        eq(modelCalls.id, storyConsultations.modelCallId),
        eq(modelCalls.orgId, storyConsultations.orgId),
        eq(modelCalls.projectId, storyConsultations.projectId),
        eq(modelCalls.storyId, storyConsultations.storyId),
        eq(modelCalls.purpose, "consultation"),
      ),
    )
    .where(
      and(
        eq(storyConsultations.orgId, orgId),
        eq(storyConsultations.projectId, projectId),
        inArray(storyConsultations.state, ["preparing", "running"]),
        eq(modelCalls.state, "started"),
        sql`(${storyConsultations.leaseExpiresAt} <= now() or ${storyConsultations.expiresAt} <= now())`,
      ),
    )
    .limit(1);
  if (expiredConsultations.length > 0) return true;
  const legacyTitles = await db
    .select({ id: budgetReservations.id })
    .from(budgetReservations)
    .where(
      and(
        eq(budgetReservations.orgId, orgId),
        eq(budgetReservations.projectId, projectId),
        eq(budgetReservations.purpose, "title"),
        eq(budgetReservations.state, "open"),
        sql`${budgetReservations.modelCallId} is null`,
      ),
    )
    .limit(1);
  if (legacyTitles.length > 0) return true;
  const stranded = await db
    .select({ id: budgetReservations.id })
    .from(budgetReservations)
    .innerJoin(
      turns,
      and(
        eq(turns.id, budgetReservations.turnId),
        eq(turns.orgId, budgetReservations.orgId),
        eq(turns.projectId, budgetReservations.projectId),
      ),
    )
    .where(
      and(
        eq(budgetReservations.orgId, orgId),
        eq(budgetReservations.projectId, projectId),
        eq(budgetReservations.state, "open"),
        eq(budgetReservations.purpose, "turn"),
        inArray(turns.state, ["succeeded", "failed", "canceled"]),
      ),
    )
    .limit(1);
  return stranded.length > 0;
}
