import { costCents, newId, normalizeModel, reservationCents } from "@facility/core";
import { budgetReservations, type FacilityDb, projectBudgets, turnUsage } from "@facility/db";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { AgentTurnUsage } from "../turns/engines.js";

export class BudgetPolicyError extends Error {
  constructor(
    readonly code: "budget_exceeded" | "budget_model_unpriced",
    message: string,
  ) {
    super(message);
    this.name = "BudgetPolicyError";
  }
}

export type BudgetState = {
  budget: typeof projectBudgets.$inferSelect | null;
  windowStart: Date;
  windowEnd: Date;
  spentCents: number;
  remainingCents: number | null;
  percentUsed: number | null;
  state: "not_configured" | "disabled" | "ok" | "warning" | "exceeded";
};

export class CostBudgetService {
  constructor(private readonly db: FacilityDb) {}

  async assertTurnAllowed(orgId: string, projectId: string, model: string, now = new Date()) {
    const state = await this.budgetState(orgId, projectId, now);
    if (!state.budget?.enabled) return state;
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

  /** Hold the title estimate, or reuse the hold already taken for this story. */
  async reserveTitle(
    input: { orgId: string; projectId: string; storyId: string; model: string },
    now = new Date(),
  ): Promise<
    | { outcome: "admitted"; reservationId: string | null }
    | { outcome: "exceeded" }
    | { outcome: "unpriced" }
  > {
    return this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      const budget = await lockBudget(tx, input.orgId, input.projectId);
      const existing = (
        await tx
          .select()
          .from(budgetReservations)
          .where(
            and(
              eq(budgetReservations.orgId, input.orgId),
              eq(budgetReservations.projectId, input.projectId),
              eq(budgetReservations.storyId, input.storyId),
              eq(budgetReservations.purpose, "title"),
              eq(budgetReservations.state, "open"),
            ),
          )
          .for("update")
      )[0];
      if (!budget?.enabled) {
        if (existing)
          await tx.delete(budgetReservations).where(eq(budgetReservations.id, existing.id));
        return { outcome: "admitted" as const, reservationId: null };
      }
      const estimate = reservationCents(input.model, "title");
      if (estimate === null) {
        if (existing)
          await tx.delete(budgetReservations).where(eq(budgetReservations.id, existing.id));
        return { outcome: "unpriced" as const };
      }
      if (existing) return { outcome: "admitted" as const, reservationId: existing.id };
      const committed = await committedCents(tx, input.orgId, input.projectId, now);
      if (exceedsBudget(committed, estimate, budget.monthlyLimitCents)) {
        return { outcome: "exceeded" as const };
      }
      if (estimate === 0) return { outcome: "admitted" as const, reservationId: null };
      const id = newId("evt");
      await tx.insert(budgetReservations).values({
        id,
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: input.storyId,
        turnId: null,
        purpose: "title",
        state: "open",
        model: input.model,
        reservedCents: estimate,
      });
      return { outcome: "admitted" as const, reservationId: id };
    });
  }

  /** Replace a title hold with the measured cost. A missing hold still records a charge when a budget exists. */
  async settleTitle(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    model: string;
    reservationId: string | null;
    cents: number;
  }) {
    const cents = finiteNonNegative(input.cents) ?? 0;
    await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      const budget = await lockBudget(tx, input.orgId, input.projectId);
      if (input.reservationId) {
        if (!budget || cents === 0) {
          await tx
            .delete(budgetReservations)
            .where(
              and(
                eq(budgetReservations.id, input.reservationId),
                eq(budgetReservations.state, "open"),
              ),
            );
          return;
        }
        const updated = await tx
          .update(budgetReservations)
          .set({ state: "settled", reservedCents: cents, model: input.model })
          .where(
            and(
              eq(budgetReservations.id, input.reservationId),
              eq(budgetReservations.state, "open"),
            ),
          )
          .returning({ id: budgetReservations.id });
        if (updated.length > 0) return;
      }
      if (!budget || cents === 0) return;
      const prior = (
        await tx
          .select({ id: budgetReservations.id })
          .from(budgetReservations)
          .where(
            and(
              eq(budgetReservations.orgId, input.orgId),
              eq(budgetReservations.storyId, input.storyId),
              eq(budgetReservations.purpose, "title"),
              eq(budgetReservations.state, "settled"),
            ),
          )
          .limit(1)
      )[0];
      if (prior) return;
      await tx.insert(budgetReservations).values({
        id: newId("evt"),
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: input.storyId,
        turnId: null,
        purpose: "title",
        state: "settled",
        model: input.model,
        reservedCents: cents,
      });
    });
  }

  async releaseReservation(id: string | null) {
    if (!id) return;
    await this.db
      .delete(budgetReservations)
      .where(and(eq(budgetReservations.id, id), eq(budgetReservations.state, "open")));
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
  }) {
    return this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      let row: typeof turnUsage.$inferSelect | null = null;
      if (input.usage) {
        const calculated = costCents({
          model: input.model,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          cacheReadTokens: input.usage.cacheReadTokens,
          cacheWriteTokens: input.usage.cacheWriteTokens,
        });
        const providerCost = finiteNonNegative(input.usage.reportedCostCents);
        const cost = providerCost ?? calculated;
        row =
          (
            await tx
              .insert(turnUsage)
              .values({
                id: newId("evt"),
                orgId: input.orgId,
                projectId: input.projectId,
                storyId: input.storyId,
                turnId: input.turnId,
                agentName: input.agentName,
                engine: input.engine,
                model: input.model,
                inputTokens: input.usage.inputTokens,
                outputTokens: input.usage.outputTokens,
                cacheReadTokens: input.usage.cacheReadTokens,
                cacheWriteTokens: input.usage.cacheWriteTokens,
                costCents: cost,
                priced: cost !== null,
                source:
                  providerCost !== undefined
                    ? "provider"
                    : calculated !== null
                      ? "price_book"
                      : "unpriced",
                durationMs: Math.max(0, Math.round(input.durationMs)),
                status: input.status,
              })
              .onConflictDoNothing({ target: turnUsage.turnId })
              .returning()
          )[0] ?? null;
      }
      await releaseOpenTurnReservation(tx, input);
      return row;
    });
  }

  async budgetState(orgId: string, projectId: string, now = new Date()): Promise<BudgetState> {
    const [windowStart, windowEnd] = monthWindow(now);
    const [budget, spentCents] = await Promise.all([
      this.db
        .select()
        .from(projectBudgets)
        .where(and(eq(projectBudgets.orgId, orgId), eq(projectBudgets.projectId, projectId)))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      committedCents(this.db, orgId, projectId, now),
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

function exceedsBudget(committed: number, estimate: number, limit: number) {
  return !reservationFits(committed, estimate, limit);
}

function exhaustedMessage(committed: number, limit: number) {
  return `Project monthly budget is exhausted (${committed.toFixed(2)} of ${limit} cents)`;
}

function assertRoom(committed: number, estimate: number, limit: number, purpose: "turn" | "title") {
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
  return (
    await db
      .select()
      .from(projectBudgets)
      .where(and(eq(projectBudgets.orgId, orgId), eq(projectBudgets.projectId, projectId)))
      .limit(1)
      .for("update")
  )[0];
}

/** Measured turn usage plus open holds and title charges settled this month. */
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
              and ${budgetReservations.createdAt} >= ${windowStart}
              and ${budgetReservations.createdAt} < ${windowEnd}
            )
          )
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
