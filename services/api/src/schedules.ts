import { createHash } from "node:crypto";
import {
  agentDefs,
  createDb,
  insertAuditEvent,
  projects,
  repos,
  runEvents,
  runs,
  schedulerWatermarks,
} from "@facility/db";
import { and, eq, not, sql } from "drizzle-orm";
import { isBuilderPlanDenialError, withBuilderPlanPreflight } from "./builder-plan-policy.js";
import { laneFor } from "./github/agent-routing.js";
import type { AppConfig } from "./types.js";

type Enqueue = (
  queue: string,
  data: Record<string, unknown>,
  options?: { singletonKey?: string },
) => Promise<unknown>;

type ScheduleTrigger = {
  type: "schedule";
  config: { cron: string; timezone?: string };
};

const weekdayNumbers: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
const SCHEDULE_WATERMARK = "agent.schedules";
const MAX_CATCH_UP_MINUTES = 24 * 60;
const REPOSITORY_SCHEDULED_AGENTS = new Set(["security-sweep"]);

export async function runAgentSchedules(config: AppConfig, enqueue: Enqueue, now = new Date()) {
  const { db, client } = createDb(config.databaseUrl);
  try {
    const rows = await db
      .select({ agent: agentDefs, project: projects })
      .from(agentDefs)
      .innerJoin(projects, eq(projects.id, agentDefs.projectId))
      .where(
        and(
          eq(agentDefs.enabled, true),
          not(eq(agentDefs.name, "learning")),
          eq(projects.status, "active"),
        ),
      );
    const currentMinute = minuteFloor(now);
    const projectRepos = await db.select().from(repos);
    const watermark = (
      await db
        .select()
        .from(schedulerWatermarks)
        .where(eq(schedulerWatermarks.name, SCHEDULE_WATERMARK))
        .limit(1)
    )[0];
    const instants = catchUpMinutes(watermark?.lastTick, currentMinute);
    let created = 0;
    for (const { agent } of rows) {
      if (
        REPOSITORY_SCHEDULED_AGENTS.has(agent.name) &&
        !projectRepos.some(
          (repo) => repo.projectId === agent.projectId && laneFor(repo, agent.name) === "platform",
        )
      ) {
        continue;
      }
      const triggers = scheduleTriggers(agent.triggers);
      for (const [index, trigger] of triggers.entries()) {
        for (const instant of instants) {
          if (!cronMatches(trigger.config.cron, instant, trigger.config.timezone ?? "UTC"))
            continue;
          const runId = scheduledRunId(agent.id, index, instant);
          const runTrigger = {
            type: "schedule",
            agentName: agent.name,
            cron: trigger.config.cron,
            timezone: trigger.config.timezone ?? "UTC",
            scheduledFor: minuteIso(instant),
          };
          let inserted = false;
          try {
            inserted = await withBuilderPlanPreflight(
              db,
              {
                orgId: agent.orgId,
                projectId: agent.projectId,
                mode: agent.name,
                agentDefId: agent.id,
                trigger: runTrigger,
                actor: { type: "system", id: "agent-scheduler" },
                source: "agent_scheduler",
              },
              async (tx, admission) => {
                const run = (
                  await tx
                    // builder-plan-preflight: schedule_dispatch
                    .insert(runs)
                    .values({
                      id: runId,
                      orgId: agent.orgId,
                      projectId: agent.projectId,
                      agentDefId: agent.id,
                      mode: admission.mode,
                      engine: agent.engine,
                      trigger: runTrigger,
                      createdBy: { type: "system", id: "agent-scheduler" },
                    })
                    .onConflictDoNothing()
                    .returning({ id: runs.id })
                )[0];
                if (!run) return false;
                await tx.insert(runEvents).values({
                  orgId: agent.orgId,
                  runId,
                  seq: 1,
                  type: "queued",
                  data: { queue: "runs.dispatch", source: "schedule" },
                });
                return true;
              },
            );
          } catch (error) {
            if (isBuilderPlanDenialError(error)) continue;
            throw error;
          }
          if (inserted) {
            await insertAuditEvent(db, {
              orgId: agent.orgId,
              projectId: agent.projectId,
              actor: { type: "system", id: "agent-scheduler" },
              action: "run.scheduled",
              target: { type: "run", id: runId },
              payload: {
                agentDefId: agent.id,
                cron: trigger.config.cron,
                scheduledFor: minuteIso(instant),
              },
            });
            created += 1;
          }
        }
      }
    }

    // This is also an outbox recovery pass. If a worker crashed after the run
    // transaction committed but before pg-boss accepted the dispatch, the next
    // minute re-enqueues it. singletonKey prevents concurrent duplicate jobs.
    const queued = await db
      .select({ id: runs.id, orgId: runs.orgId })
      .from(runs)
      .where(and(eq(runs.status, "queued"), sql`${runs.trigger}->>'type' = 'schedule'`));
    for (const run of queued) {
      await enqueue("runs.dispatch", { runId: run.id, orgId: run.orgId }, { singletonKey: run.id });
    }
    if (!watermark || watermark.lastTick <= currentMinute) {
      await db
        .insert(schedulerWatermarks)
        .values({ name: SCHEDULE_WATERMARK, lastTick: currentMinute })
        .onConflictDoUpdate({
          target: schedulerWatermarks.name,
          set: { lastTick: currentMinute, updatedAt: new Date() },
        });
    }
    return {
      created,
      dispatched: queued.length,
      evaluatedMinutes: instants.length,
      caughtUpMinutes: Math.max(0, instants.length - 1),
    };
  } finally {
    await client.end();
  }
}

export function validateScheduleTrigger(trigger: unknown) {
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) return;
  const value = trigger as { type?: unknown; config?: unknown };
  if (value.type !== "schedule") return;
  const config = objectOrEmpty(value.config);
  if (typeof config.cron !== "string") throw new Error("Schedule trigger requires config.cron");
  const timezone = typeof config.timezone === "string" ? config.timezone : "UTC";
  cronMatches(config.cron, new Date(), timezone);
}

export function cronMatches(cron: string, instant: Date, timezone = "UTC") {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron must contain exactly five fields");
  const values = zonedParts(instant, timezone);
  const minute = parseCronField(fields[0] ?? "", 0, 59);
  const hour = parseCronField(fields[1] ?? "", 0, 23);
  const dayOfMonth = parseCronField(fields[2] ?? "", 1, 31);
  const month = parseCronField(fields[3] ?? "", 1, 12);
  const dayOfWeek = parseCronField(fields[4] ?? "", 0, 7, true);
  const domRestricted = !fields[2]?.startsWith("*");
  const dowRestricted = !fields[4]?.startsWith("*");
  const dayMatches =
    domRestricted && dowRestricted
      ? dayOfMonth.has(values.day) || dayOfWeek.has(values.weekday)
      : dayOfMonth.has(values.day) && dayOfWeek.has(values.weekday);
  return (
    minute.has(values.minute) && hour.has(values.hour) && month.has(values.month) && dayMatches
  );
}

function scheduleTriggers(value: unknown): ScheduleTrigger[] {
  if (!Array.isArray(value)) return [];
  return value.filter((trigger): trigger is ScheduleTrigger => {
    if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) return false;
    const item = trigger as { type?: unknown; config?: unknown };
    const config = objectOrEmpty(item.config);
    return item.type === "schedule" && typeof config.cron === "string";
  });
}

function zonedParts(instant: Date, timezone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      weekday: "short",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    }).formatToParts(instant);
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour) % 24,
    minute: Number(lookup.minute),
    weekday: weekdayNumbers[lookup.weekday ?? ""] ?? -1,
  };
}

function parseCronField(field: string, min: number, max: number, normalizeSunday = false) {
  const values = new Set<number>();
  for (const segment of field.split(",")) {
    if (!segment) throw new Error(`Invalid cron field: ${field}`);
    const [rangePart, stepPart] = segment.split("/");
    if (segment.split("/").length > 2) throw new Error(`Invalid cron field: ${field}`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid cron step: ${segment}`);
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart?.includes("-")) {
      const [rawStart, rawEnd] = rangePart.split("-");
      start = Number(rawStart);
      end = Number(rawEnd);
    } else {
      start = Number(rangePart);
      end = stepPart === undefined ? start : max;
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      throw new Error(`Cron value is outside ${min}-${max}: ${segment}`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalizeSunday && value === 7 ? 0 : value);
    }
  }
  return values;
}

function scheduledRunId(agentId: string, triggerIndex: number, instant: Date) {
  const digest = createHash("sha256")
    .update(`${agentId}:${triggerIndex}:${minuteIso(instant)}`)
    .digest("hex")
    .slice(0, 24);
  return `run_sched_${digest}`;
}

function minuteIso(instant: Date) {
  return `${instant.toISOString().slice(0, 16)}:00.000Z`;
}

function minuteFloor(instant: Date) {
  return new Date(minuteIso(instant));
}

function catchUpMinutes(lastTick: Date | undefined, currentMinute: Date) {
  if (!lastTick) return [currentMinute];
  const firstMissing = minuteFloor(new Date(lastTick.getTime() + 60_000));
  const oldestAllowed = new Date(currentMinute.getTime() - (MAX_CATCH_UP_MINUTES - 1) * 60_000);
  const start = firstMissing < oldestAllowed ? oldestAllowed : firstMissing;
  const instants: Date[] = [];
  for (let value = start.getTime(); value <= currentMinute.getTime(); value += 60_000) {
    instants.push(new Date(value));
  }
  return instants;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
