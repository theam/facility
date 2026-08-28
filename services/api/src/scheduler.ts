import { newId } from "@facility/core";
import {
  agentDefs,
  createDb,
  type FacilityDb,
  insertAuditEvent,
  runEvents,
  runs,
} from "@facility/db";
// Default-import: cron-parser is CJS and its named exports aren't statically
// visible to Node's ESM loader (tsx runs the worker in real ESM mode).
import cronParser from "cron-parser";
import { and, eq, not, notInArray, sql } from "drizzle-orm";
import {
  assertBuilderPlanDispatch,
  isBuilderPlanDenialError,
  lockBuilderPlanPolicy,
} from "./builder-plan-policy.js";
import { TERMINAL_RUN_STATUSES } from "./sandbox/state.js";
import type { AppConfig } from "./types.js";

type Enqueue = (queue: string, data: Record<string, unknown>) => Promise<unknown>;

type ScheduleTrigger = {
  type: "schedule";
  config: {
    cron: string;
    timezone?: string;
  };
};

export async function runScheduledAgents(
  config: AppConfig,
  enqueue: Enqueue = async () => undefined,
  deps: { now?: Date } = {},
) {
  const { db, client } = createDb(config.databaseUrl);
  const now = deps.now ?? new Date();
  const dispatches: Array<{ runId: string; orgId: string; projectId: string }> = [];
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agents.schedule'))`);
      const agents = await tx
        .select()
        .from(agentDefs)
        .where(
          and(
            eq(agentDefs.enabled, true),
            not(eq(agentDefs.name, "learning")),
            sql`${agentDefs.triggers} @> '[{"type":"schedule"}]'::jsonb`,
          ),
        );
      for (const agent of agents) {
        // The bespoke learning.nightly packet job owns learning agents because it
        // assembles a daily packet before dispatch; the generic scheduler skips them.
        const trigger = dueScheduleTrigger(agent.triggers, agent.lastScheduledAt, now);
        if (!agent.lastScheduledAt) {
          await tx
            .update(agentDefs)
            .set({ lastScheduledAt: now, updatedAt: now })
            .where(and(eq(agentDefs.orgId, agent.orgId), eq(agentDefs.id, agent.id)));
          continue;
        }
        if (!trigger) continue;

        const liveRun = (
          await tx
            .select({ id: runs.id })
            .from(runs)
            .where(
              and(
                eq(runs.orgId, agent.orgId),
                eq(runs.projectId, agent.projectId),
                eq(runs.agentDefId, agent.id),
                notInArray(runs.status, [...TERMINAL_RUN_STATUSES]),
              ),
            )
            .limit(1)
        )[0];
        if (!liveRun) {
          const runTrigger = { type: "schedule", cron: trigger.config.cron };
          let admittedMode = agent.name;
          try {
            const policyTx = tx as unknown as FacilityDb;
            await lockBuilderPlanPolicy(policyTx, agent.orgId, agent.projectId);
            const admission = await assertBuilderPlanDispatch(policyTx, {
              orgId: agent.orgId,
              projectId: agent.projectId,
              mode: agent.name,
              agentDefId: agent.id,
              trigger: runTrigger,
              actor: { type: "system", id: "scheduler" },
              source: "legacy_scheduler",
            });
            admittedMode = admission.mode;
          } catch (error) {
            if (!isBuilderPlanDenialError(error)) throw error;
            await tx
              .update(agentDefs)
              .set({ lastScheduledAt: now, updatedAt: now })
              .where(and(eq(agentDefs.orgId, agent.orgId), eq(agentDefs.id, agent.id)));
            continue;
          }
          const run = (
            await tx
              // builder-plan-preflight: scheduled_run
              .insert(runs)
              .values({
                id: newId("run"),
                orgId: agent.orgId,
                projectId: agent.projectId,
                agentDefId: agent.id,
                mode: admittedMode,
                engine: agent.engine,
                trigger: runTrigger,
                createdBy: { type: "system", id: "scheduler" },
              })
              .returning()
          )[0];
          if (run) {
            await tx.insert(runEvents).values({
              orgId: run.orgId,
              runId: run.id,
              seq: 1,
              type: "queued",
              data: { queue: "runs.dispatch" },
            });
            dispatches.push({ runId: run.id, orgId: run.orgId, projectId: run.projectId });
          }
        }
        await tx
          .update(agentDefs)
          .set({ lastScheduledAt: now, updatedAt: now })
          .where(and(eq(agentDefs.orgId, agent.orgId), eq(agentDefs.id, agent.id)));
      }
    });

    for (const dispatch of dispatches) {
      await insertAuditEvent(db, {
        orgId: dispatch.orgId,
        projectId: dispatch.projectId,
        actor: { type: "system", id: "scheduler" },
        action: "run.scheduled",
        target: { type: "run", id: dispatch.runId },
        payload: { queue: "runs.dispatch" },
      });
      await enqueue("runs.dispatch", { runId: dispatch.runId, orgId: dispatch.orgId });
    }
    return { dispatched: dispatches.map((dispatch) => dispatch.runId) };
  } finally {
    await client.end();
  }
}

function dueScheduleTrigger(
  value: unknown,
  lastScheduledAt: Date | null,
  now: Date,
): ScheduleTrigger | null {
  const triggers = scheduleTriggers(value);
  if (!lastScheduledAt) return triggers[0] ?? null;
  for (const trigger of triggers) {
    const prev = previousOccurrence(trigger, now);
    if (prev && prev.getTime() > lastScheduledAt.getTime()) return trigger;
  }
  return null;
}

function scheduleTriggers(value: unknown): ScheduleTrigger[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const trigger = candidate as { type?: unknown; config?: unknown };
    if (trigger.type !== "schedule" || !trigger.config || typeof trigger.config !== "object") {
      return [];
    }
    const config = trigger.config as { cron?: unknown; timezone?: unknown };
    if (typeof config.cron !== "string") return [];
    return [
      {
        type: "schedule",
        config: {
          cron: config.cron,
          ...(typeof config.timezone === "string" ? { timezone: config.timezone } : {}),
        },
      },
    ];
  });
}

function previousOccurrence(trigger: ScheduleTrigger, now: Date): Date | null {
  try {
    const interval = cronParser.parseExpression(trigger.config.cron, {
      currentDate: new Date(now.getTime() + 1_000),
      tz: trigger.config.timezone ?? "UTC",
    });
    return interval.prev().toDate();
  } catch {
    return null;
  }
}
