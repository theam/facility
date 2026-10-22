import { createHash, randomUUID } from "node:crypto";
import { costCents, newId, reservationCents } from "@facility/core";
import {
  budgetReservations,
  type FacilityDb,
  modelCalls,
  type projectBudgets,
  stories,
} from "@facility/db";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { AgentTurnUsage } from "../turns/engines.js";
import { BudgetPolicyError } from "./budget-policy.js";

type Scope = { orgId: string; projectId: string; storyId: string };
type Call = typeof modelCalls.$inferSelect;
const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
type TitleAdmissionDenial =
  | "exceeded"
  | "unpriced"
  | "unconfirmed"
  | "in_progress"
  | "settled"
  | "unbilled";
export type TitleAdmission =
  | { outcome: "admitted"; reservationId: string; callId: string }
  | { [K in TitleAdmissionDenial]: { outcome: K } }[TitleAdmissionDenial];
export type ModelCallSettlement = Scope & {
  reservationId: string;
  callId: string;
  claimToken: string | null;
  certainty: "confirmed" | "unconfirmed" | "unbilled";
  usage?: AgentTurnUsage;
  cents?: number;
  errorCode?: string;
};
export type ModelCallReceipt = {
  state: "confirmed" | "unconfirmed" | "unbilled";
  costCents: number | null;
};
type Policy = {
  lockBudget: (
    db: FacilityDb,
    orgId: string,
    projectId: string,
  ) => Promise<typeof projectBudgets.$inferSelect | undefined>;
  committedCents: (db: FacilityDb, orgId: string, projectId: string, now: Date) => Promise<number>;
  hasUnconfirmedUsage: (db: FacilityDb, orgId: string, projectId: string) => Promise<boolean>;
  assertRoom: (
    committed: number,
    estimate: number,
    limit: number,
    purpose: "turn" | "title" | "consultation",
  ) => void;
};

export function modelCallFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

export function validModelUsage(usage: unknown): usage is AgentTurnUsage {
  if (!usage || typeof usage !== "object") return false;
  const value = usage as Record<string, unknown>;
  return USAGE_KEYS.every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0);
}

/** Only numerical billing data enters this ledger; provider credentials and prompts do not. */
export class ModelCallLedger {
  constructor(
    private readonly db: FacilityDb,
    private readonly policy: Policy,
  ) {}

  reserveTitle(
    input: Scope & {
      model: string;
      provider?: "openai" | "anthropic";
      requestKey?: string;
      fingerprint?: string;
    },
    now = new Date(),
  ): Promise<TitleAdmission> {
    return this.reserveApiCall({ ...input, purpose: "title" }, now);
  }

  reserveConsultation(
    input: Scope & {
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
    return this.reserveApiCall({ ...input, purpose: "consultation" }, now, admitted);
  }

  private async reserveApiCall(
    input: Scope & {
      model: string;
      provider?: "openai" | "anthropic";
      requestKey?: string;
      fingerprint?: string;
      purpose: "title" | "consultation";
    },
    now: Date,
    admitted?: (
      tx: FacilityDb,
      receipt: { callId: string; reservationId: string },
    ) => Promise<void>,
  ): Promise<TitleAdmission> {
    const provider = input.provider ?? (input.model.startsWith("claude-") ? "anthropic" : "openai");
    const requestKey = input.requestKey ?? `${input.purpose}:${input.storyId}`;
    const fingerprint =
      input.fingerprint ??
      modelCallFingerprint({
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: input.storyId,
        model: input.model,
        provider,
        requestKey,
      });
    if (
      !input.model ||
      input.model.length > 160 ||
      !requestKey ||
      requestKey.length > 200 ||
      requestKey.includes("\0") ||
      !/^[A-Za-z0-9_-]{43}$/.test(fingerprint)
    )
      throw new BudgetPolicyError("model_call_invalid", "Provide a bounded model-call identity.");
    return this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await this.scope(tx, input);
      const budget = await this.policy.lockBudget(tx, input.orgId, input.projectId);
      if (
        budget?.enabled &&
        (await this.policy.hasUnconfirmedUsage(tx, input.orgId, input.projectId))
      )
        return { outcome: "unconfirmed" as const };
      const existing = (
        await tx
          .select()
          .from(modelCalls)
          .where(
            and(
              scopeWhere(input),
              eq(modelCalls.purpose, input.purpose),
              eq(modelCalls.requestKey, requestKey),
            ),
          )
          .for("update")
      )[0];
      if (existing) {
        if (
          existing.fingerprint !== fingerprint ||
          existing.model !== input.model ||
          existing.provider !== provider
        )
          throw new BudgetPolicyError(
            "model_call_conflict",
            "This model-call key already identifies another request.",
          );
        if (existing.state === "unconfirmed") return { outcome: "unconfirmed" as const };
        if (existing.state === "started") return { outcome: "in_progress" as const };
        if (existing.state === "confirmed") return { outcome: "settled" as const };
        if (existing.state === "unbilled") return { outcome: "unbilled" as const };
        const hold = await this.hold(tx, input, existing.id);
        if (!hold || existing.expiresAt <= now) {
          await this.finishInTransaction(
            tx,
            existing,
            hold?.id,
            { certainty: "unbilled", errorCode: "attempt_expired_before_start" },
            now,
          );
          return { outcome: "unbilled" as const };
        }
        const receipt = {
          outcome: "admitted" as const,
          reservationId: hold.id,
          callId: existing.id,
        };
        if (admitted) await admitted(tx, receipt);
        return receipt;
      }
      const legacy = (
        await tx
          .select({ id: budgetReservations.id })
          .from(budgetReservations)
          .where(
            and(
              holdScope(input),
              eq(budgetReservations.purpose, input.purpose),
              eq(budgetReservations.state, "open"),
            ),
          )
          .limit(1)
      )[0];
      if (legacy) return { outcome: "unconfirmed" as const };
      const estimate = reservationCents(input.model, input.purpose);
      if (estimate === null) return { outcome: "unpriced" as const };
      if (budget?.enabled) {
        const committed = await this.policy.committedCents(tx, input.orgId, input.projectId, now);
        try {
          this.policy.assertRoom(committed, estimate, budget.monthlyLimitCents, input.purpose);
        } catch (error) {
          if (error instanceof BudgetPolicyError && error.code === "budget_exceeded")
            return { outcome: "exceeded" as const };
          throw error;
        }
      }
      const callId = newId("mcall"),
        reservationId = newId("evt");
      await tx.insert(modelCalls).values({
        id: callId,
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: input.storyId,
        purpose: input.purpose,
        provider,
        model: input.model,
        requestKey,
        fingerprint,
        reservationId,
        state: "reserved",
        estimatedCents: estimate,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + 120_000),
      });
      await tx.insert(budgetReservations).values({
        id: reservationId,
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: input.storyId,
        modelCallId: callId,
        purpose: input.purpose,
        state: "open",
        model: input.model,
        reservedCents: estimate,
        createdAt: now,
      });
      const receipt = { outcome: "admitted" as const, reservationId, callId };
      if (admitted) await admitted(tx, receipt);
      return receipt;
    });
  }

  async claim(
    input: Scope & { callId: string },
    now = new Date(),
    claimed?: (tx: FacilityDb, claimToken: string) => Promise<void>,
  ): Promise<string | null> {
    return this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await this.scope(tx, input);
      const budget = await this.policy.lockBudget(tx, input.orgId, input.projectId);
      const call = await this.call(tx, input);
      if (call.state !== "reserved") return null;
      const hold = await this.hold(tx, input, call.id);
      if (!hold || call.expiresAt <= now) {
        await this.finishInTransaction(
          tx,
          call,
          hold?.id,
          { certainty: "unbilled", errorCode: "attempt_expired_before_start" },
          now,
        );
        return null;
      }
      if (budget?.enabled) {
        if (await this.policy.hasUnconfirmedUsage(tx, input.orgId, input.projectId))
          throw new BudgetPolicyError(
            "budget_usage_unconfirmed",
            "Project spending is unconfirmed.",
          );
        const committed = await this.policy.committedCents(tx, input.orgId, input.projectId, now);
        if (committed > budget.monthlyLimitCents)
          throw new BudgetPolicyError(
            "budget_exceeded",
            "The admitted model call no longer fits the project budget.",
          );
      }
      const claimToken = randomUUID();
      await tx
        .update(modelCalls)
        .set({ state: "started", claimToken, startedAt: now, updatedAt: now })
        .where(eq(modelCalls.id, call.id));
      if (claimed) await claimed(tx, claimToken);
      return claimToken;
    });
  }

  async settle<T>(
    input: ModelCallSettlement,
    publish?: (tx: FacilityDb, receipt: ModelCallReceipt) => Promise<T>,
    now = new Date(),
  ) {
    return this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await this.scope(tx, input);
      await this.policy.lockBudget(tx, input.orgId, input.projectId);
      const call = await this.call(tx, input);
      if (call.reservationId !== input.reservationId)
        throw new BudgetPolicyError(
          "budget_reservation_not_found",
          "The reservation does not identify this model call.",
        );
      const hold = (
        await tx
          .select()
          .from(budgetReservations)
          .where(
            and(
              holdScope(input),
              eq(budgetReservations.id, input.reservationId),
              eq(budgetReservations.modelCallId, call.id),
            ),
          )
          .for("update")
      )[0];
      if (
        call.claimToken !== input.claimToken ||
        (!call.startedAt && input.certainty !== "unbilled")
      )
        throw new BudgetPolicyError(
          "model_call_not_owned",
          "Only the recorded attempt can settle this call.",
        );
      if (call.state === "confirmed" || call.state === "unbilled")
        return {
          replayed: true,
          published: undefined,
          receipt: { state: call.state, costCents: call.costCents } as ModelCallReceipt,
        };
      if (!hold && call.state !== "unconfirmed")
        throw new BudgetPolicyError(
          "budget_reservation_not_found",
          "Model-call reservation was not found in this story.",
        );
      const receipt = await this.finishInTransaction(tx, call, hold?.id, input, now);
      const published = publish ? await publish(tx, receipt) : undefined;
      return { replayed: false, published, receipt };
    });
  }

  async release(reservationId: string | null, scope: Scope) {
    if (!reservationId) return;
    await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await this.scope(tx, scope);
      await this.policy.lockBudget(tx, scope.orgId, scope.projectId);
      const hold = (
        await tx
          .select()
          .from(budgetReservations)
          .where(
            and(
              holdScope(scope),
              eq(budgetReservations.id, reservationId),
              eq(budgetReservations.state, "open"),
            ),
          )
          .for("update")
      )[0];
      if (!hold) return;
      if (hold.modelCallId) {
        const call = await this.call(tx, { ...scope, callId: hold.modelCallId });
        if (call.state === "confirmed" || call.state === "unbilled") {
          await tx.delete(budgetReservations).where(eq(budgetReservations.id, hold.id));
          return;
        }
        await this.finishInTransaction(
          tx,
          call,
          hold.id,
          { certainty: call.startedAt ? "unconfirmed" : "unbilled", errorCode: "attempt_released" },
          new Date(),
        );
      } else if (hold.purpose === "turn") {
        await tx.delete(budgetReservations).where(eq(budgetReservations.id, hold.id));
      }
    });
  }

  async recover(now = new Date()) {
    const expired = await this.db
      .select()
      .from(modelCalls)
      .where(
        and(inArray(modelCalls.state, ["reserved", "started"]), lte(modelCalls.expiresAt, now)),
      )
      .orderBy(asc(modelCalls.expiresAt))
      .limit(1000);
    for (const candidate of expired)
      await this.db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as FacilityDb;
        await this.scope(tx, candidate);
        await this.policy.lockBudget(tx, candidate.orgId, candidate.projectId);
        const call = await this.call(tx, { ...candidate, callId: candidate.id });
        if (!["reserved", "started"].includes(call.state) || call.expiresAt > now) return;
        const hold = await this.hold(tx, candidate, call.id);
        await this.finishInTransaction(
          tx,
          call,
          hold?.id,
          {
            certainty: call.startedAt ? "unconfirmed" : "unbilled",
            errorCode: "attempt_expired",
          },
          now,
        );
      });
    return expired.length;
  }

  private async finishInTransaction(
    tx: FacilityDb,
    call: Call,
    holdId: string | undefined,
    input: Pick<ModelCallSettlement, "certainty" | "usage" | "cents" | "errorCode">,
    now: Date,
  ): Promise<ModelCallReceipt> {
    if (input.cents !== undefined && (!Number.isFinite(input.cents) || input.cents < 0))
      throw new BudgetPolicyError(
        "model_call_invalid",
        "A measured model charge must be finite and non-negative.",
      );
    const usage = validModelUsage(input.usage) ? input.usage : undefined;
    if (
      (usage && USAGE_KEYS.some((key) => usage[key] < (call[key] ?? 0))) ||
      (input.cents !== undefined && input.cents < (call.costCents ?? 0))
    )
      throw new BudgetPolicyError(
        "model_call_conflict",
        "A model-call receipt cannot discard previously observed usage or charges.",
      );
    if (
      input.certainty === "unbilled" &&
      ((call.costCents ?? 0) > 0 ||
        (input.cents ?? 0) > 0 ||
        [call.inputTokens, call.outputTokens, call.cacheReadTokens, call.cacheWriteTokens].some(
          (value) => (value ?? 0) > 0,
        ) ||
        (input.usage !== undefined && !usage) ||
        (usage && USAGE_KEYS.some((key) => usage[key] > 0)))
    )
      throw new BudgetPolicyError(
        "model_call_conflict",
        "An unbilled outcome conflicts with observed usage.",
      );
    const cost =
      input.certainty === "unbilled"
        ? 0
        : (input.cents ?? (usage ? costCents({ model: call.model, ...usage }) : call.costCents));
    if (cost !== null && cost < (call.costCents ?? 0))
      throw new BudgetPolicyError(
        "model_call_conflict",
        "A model-call receipt cannot reduce an observed charge.",
      );
    const state =
      input.certainty === "unbilled"
        ? "unbilled"
        : input.certainty === "confirmed" &&
            (input.cents !== undefined || usage !== undefined) &&
            cost !== null
          ? "confirmed"
          : "unconfirmed";
    await tx
      .update(modelCalls)
      .set({
        state,
        costCents: cost,
        inputTokens: usage?.inputTokens ?? call.inputTokens,
        outputTokens: usage?.outputTokens ?? call.outputTokens,
        cacheReadTokens: usage?.cacheReadTokens ?? call.cacheReadTokens,
        cacheWriteTokens: usage?.cacheWriteTokens ?? call.cacheWriteTokens,
        errorCode: input.errorCode?.slice(0, 200) ?? null,
        settledAt: now,
        updatedAt: now,
      })
      .where(eq(modelCalls.id, call.id));
    if (holdId) {
      // Keep the title receipt for existing consumers; totals count its linked call once.
      if (state === "confirmed" && call.purpose === "title")
        await tx
          .update(budgetReservations)
          .set({ state: "settled", reservedCents: cost ?? 0 })
          .where(eq(budgetReservations.id, holdId));
      else await tx.delete(budgetReservations).where(eq(budgetReservations.id, holdId));
    }
    return { state, costCents: cost };
  }

  private async call(tx: FacilityDb, input: Scope & { callId: string }) {
    const call = (
      await tx
        .select()
        .from(modelCalls)
        .where(and(scopeWhere(input), eq(modelCalls.id, input.callId)))
        .for("update")
    )[0];
    if (!call)
      throw new BudgetPolicyError(
        "budget_reservation_not_found",
        "Model call was not found in this story.",
      );
    return call;
  }

  private async hold(tx: FacilityDb, input: Scope, callId: string) {
    return (
      await tx
        .select()
        .from(budgetReservations)
        .where(
          and(
            holdScope(input),
            eq(budgetReservations.modelCallId, callId),
            eq(budgetReservations.state, "open"),
          ),
        )
        .for("update")
    )[0];
  }

  private async scope(tx: FacilityDb, input: Scope) {
    const story = (
      await tx
        .select({ id: stories.id })
        .from(stories)
        .where(
          and(
            eq(stories.orgId, input.orgId),
            eq(stories.projectId, input.projectId),
            eq(stories.id, input.storyId),
          ),
        )
        .limit(1)
    )[0];
    if (!story)
      throw new BudgetPolicyError(
        "budget_reservation_not_found",
        "Story was not found in this project.",
      );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`facility:story:${input.orgId}:${input.projectId}:${input.storyId}`}))`,
    );
  }
}

function scopeWhere(scope: Scope) {
  return and(
    eq(modelCalls.orgId, scope.orgId),
    eq(modelCalls.projectId, scope.projectId),
    eq(modelCalls.storyId, scope.storyId),
  );
}
function holdScope(scope: Scope) {
  return and(
    eq(budgetReservations.orgId, scope.orgId),
    eq(budgetReservations.projectId, scope.projectId),
    eq(budgetReservations.storyId, scope.storyId),
  );
}
