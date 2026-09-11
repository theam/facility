import { costCents, newId, normalizeModel } from "@facility/core";
import { type FacilityDb, projectBudgets, turnUsage } from "@facility/db";
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
        `Project monthly budget is exhausted (${state.spentCents.toFixed(2)} of ${state.budget.monthlyLimitCents} cents)`,
      );
    }
    return state;
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
    if (!input.usage) return null;
    const calculated = costCents({
      model: input.model,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cacheReadTokens: input.usage.cacheReadTokens,
      cacheWriteTokens: input.usage.cacheWriteTokens,
    });
    const providerCost = finiteNonNegative(input.usage.reportedCostCents);
    const cost = providerCost ?? calculated;
    const row = (
      await this.db
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
    )[0];
    return row ?? null;
  }

  async budgetState(orgId: string, projectId: string, now = new Date()): Promise<BudgetState> {
    const [windowStart, windowEnd] = monthWindow(now);
    const [budget, totals] = await Promise.all([
      this.db
        .select()
        .from(projectBudgets)
        .where(and(eq(projectBudgets.orgId, orgId), eq(projectBudgets.projectId, projectId)))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      this.db
        .select({
          spentCents: sql<number>`coalesce(sum(${turnUsage.costCents}), 0)::float8`,
        })
        .from(turnUsage)
        .where(
          and(
            eq(turnUsage.orgId, orgId),
            eq(turnUsage.projectId, projectId),
            gte(turnUsage.createdAt, windowStart),
            lt(turnUsage.createdAt, windowEnd),
          ),
        )
        .then((rows) => rows[0]),
    ]);
    const spentCents = totals?.spentCents ?? 0;
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
