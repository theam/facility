import { newId } from "@facility/core";
import {
  agentDefs,
  auditEvents,
  createDb,
  migrate,
  orgs,
  projects,
  registryItems,
  runEvents,
  runs,
  schedulerWatermarks,
} from "@facility/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScheduledAgents } from "../src/scheduler.js";
import { runAgentSchedules } from "../src/schedules.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const config = { databaseUrl } as AppConfig;

async function canConnect() {
  const sqlClient = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await sqlClient`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sqlClient.end().catch(() => undefined);
  }
}

describe("scheduled agents", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; scheduler tests skipped", () => undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);

  beforeAll(async () => {
    await migrate(databaseUrl);
  });

  afterAll(async () => {
    await client.end();
  });

  it("arms a never-scheduled agent without dispatching", async () => {
    const now = new Date("2026-07-06T06:01:30.000Z");
    const agent = await insertAgent("arming", {
      triggers: [{ type: "schedule", config: { cron: "* * * * *", timezone: "UTC" } }],
      lastScheduledAt: null,
    });
    const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];
    await runScheduledAgents(
      config,
      async (queue, data) => {
        enqueued.push({ queue, data });
      },
      { now },
    );
    expect(enqueued).toEqual([]);
    const stored = (
      await db.select().from(agentDefs).where(eq(agentDefs.id, agent.id)).limit(1)
    )[0];
    expect(stored?.lastScheduledAt?.toISOString()).toBe(now.toISOString());
  });

  it("dispatches due agents, writes a queued event and audits the schedule", async () => {
    const now = new Date("2026-07-06T06:01:30.000Z");
    const agent = await insertAgent("due", {
      triggers: [{ type: "schedule", config: { cron: "* * * * *", timezone: "UTC" } }],
      lastScheduledAt: new Date("2026-07-06T06:00:00.000Z"),
    });
    const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const result = await runScheduledAgents(
      config,
      async (queue, data) => {
        enqueued.push({ queue, data });
      },
      { now },
    );
    expect(result.dispatched).toHaveLength(1);
    expect(enqueued).toEqual([
      { queue: "runs.dispatch", data: { runId: result.dispatched[0], orgId: agent.orgId } },
    ]);
    const run = (
      await db
        .select()
        .from(runs)
        .where(eq(runs.id, result.dispatched[0] ?? ""))
    )[0];
    expect(run).toMatchObject({
      orgId: agent.orgId,
      projectId: agent.projectId,
      agentDefId: agent.id,
      mode: "due",
      engine: "codex",
      trigger: { type: "schedule", cron: "* * * * *" },
      createdBy: { type: "system", id: "scheduler" },
    });
    const event = (
      await db
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, run?.id ?? ""))
        .limit(1)
    )[0];
    expect(event).toMatchObject({ seq: 1, type: "queued", data: { queue: "runs.dispatch" } });
    const audit = (
      await db.select().from(auditEvents).where(eq(auditEvents.orgId, agent.orgId)).limit(1)
    )[0];
    expect(audit).toMatchObject({
      projectId: agent.projectId,
      action: "run.scheduled",
      target: { type: "run", id: run?.id },
    });
    const stored = (
      await db.select().from(agentDefs).where(eq(agentDefs.id, agent.id)).limit(1)
    )[0];
    expect(stored?.lastScheduledAt?.toISOString()).toBe(now.toISOString());
  });

  it("skips due agents with a live run but still advances last_scheduled_at", async () => {
    const now = new Date("2026-07-06T06:01:30.000Z");
    const agent = await insertAgent("live-skip", {
      triggers: [{ type: "schedule", config: { cron: "* * * * *", timezone: "UTC" } }],
      lastScheduledAt: new Date("2026-07-06T06:00:00.000Z"),
    });
    await db.insert(runs).values({
      id: newId("run"),
      orgId: agent.orgId,
      projectId: agent.projectId,
      agentDefId: agent.id,
      mode: agent.name,
      engine: agent.engine,
      status: "running",
      trigger: {},
      createdBy: { type: "system", id: "test" },
    });
    const enqueued: unknown[] = [];
    await runScheduledAgents(
      config,
      async (queue, data) => {
        enqueued.push({ queue, data });
      },
      { now },
    );
    expect(enqueued).toEqual([]);
    const allRuns = await db.select().from(runs).where(eq(runs.agentDefId, agent.id));
    expect(allRuns).toHaveLength(1);
    const stored = (
      await db.select().from(agentDefs).where(eq(agentDefs.id, agent.id)).limit(1)
    )[0];
    expect(stored?.lastScheduledAt?.toISOString()).toBe(now.toISOString());
  });

  it("leaves learning agents to the bespoke nightly scheduler", async () => {
    const lastScheduledAt = new Date("2026-07-06T06:00:00.000Z");
    const agent = await insertAgent("learning", {
      triggers: [{ type: "schedule", config: { cron: "* * * * *", timezone: "UTC" } }],
      lastScheduledAt,
    });
    const enqueued: unknown[] = [];
    await runScheduledAgents(
      config,
      async (queue, data) => {
        enqueued.push({ queue, data });
      },
      { now: new Date("2026-07-06T06:01:30.000Z") },
    );
    expect(enqueued).toEqual([]);
    const stored = (
      await db.select().from(agentDefs).where(eq(agentDefs.id, agent.id)).limit(1)
    )[0];
    expect(stored?.lastScheduledAt?.toISOString()).toBe(lastScheduledAt.toISOString());
  });

  it("honors trigger timezones when calculating due occurrences", async () => {
    const now = new Date("2026-01-01T14:00:30.000Z");
    const agent = await insertAgent("timezone", {
      triggers: [
        { type: "schedule", config: { cron: "0 0 * * *", timezone: "Pacific/Kiritimati" } },
      ],
      lastScheduledAt: new Date("2026-01-01T09:30:00.000Z"),
    });
    const enqueued: unknown[] = [];
    await runScheduledAgents(
      config,
      async (queue, data) => {
        enqueued.push({ queue, data });
      },
      { now },
    );
    expect(enqueued).toHaveLength(1);
    const stored = (
      await db.select().from(agentDefs).where(eq(agentDefs.id, agent.id)).limit(1)
    )[0];
    expect(stored?.lastScheduledAt?.toISOString()).toBe(now.toISOString());
  });

  it("does not create or enqueue a legacy scheduled Builder run when plans are required", async () => {
    const now = new Date("2032-09-14T11:08:30.000Z");
    const agent = await insertAgent("governed-legacy-schedule", {
      triggers: [
        { type: "schedule", config: { cron: "* * * * *", timezone: "UTC" } },
        { type: "command", command: "builder" },
      ],
      lastScheduledAt: new Date("2032-09-14T11:07:00.000Z"),
      builderPlanPolicy: "required",
    });
    const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];

    await runScheduledAgents(
      config,
      async (queue, data) => {
        enqueued.push({ queue, data });
      },
      { now },
    );

    expect(await db.select().from(runs).where(eq(runs.agentDefId, agent.id))).toEqual([]);
    expect(enqueued.filter((job) => job.data.orgId === agent.orgId)).toEqual([]);
    const denial = (
      await db.select().from(auditEvents).where(eq(auditEvents.orgId, agent.orgId))
    ).find(
      (event) =>
        event.action === "run.builder_plan_denied" &&
        (event.payload as { source?: unknown }).source === "legacy_scheduler",
    );
    expect(denial).toMatchObject({
      projectId: agent.projectId,
      payload: { code: "builder_plan_required", source: "legacy_scheduler" },
    });
    const stored = (
      await db.select().from(agentDefs).where(eq(agentDefs.id, agent.id)).limit(1)
    )[0];
    expect(stored?.lastScheduledAt?.toISOString()).toBe(now.toISOString());
  });

  it("does not create or enqueue a canonical scheduled Builder run when plans are required", async () => {
    const now = new Date("2032-09-14T12:08:30.000Z");
    const agent = await insertAgent("governed-canonical-schedule", {
      triggers: [
        { type: "schedule", config: { cron: "* * * * *", timezone: "UTC" } },
        { type: "command", command: "builder" },
      ],
      lastScheduledAt: new Date("2032-09-14T12:07:00.000Z"),
      builderPlanPolicy: "required",
    });
    await db
      .insert(schedulerWatermarks)
      .values({
        name: "agent.schedules",
        lastTick: new Date("2032-09-14T12:07:00.000Z"),
      })
      .onConflictDoUpdate({
        target: schedulerWatermarks.name,
        set: { lastTick: new Date("2032-09-14T12:07:00.000Z"), updatedAt: new Date() },
      });
    const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];

    await runAgentSchedules(
      config,
      async (queue, data) => {
        enqueued.push({ queue, data });
        return null;
      },
      now,
    );

    expect(await db.select().from(runs).where(eq(runs.agentDefId, agent.id))).toEqual([]);
    expect(enqueued.filter((job) => job.data.orgId === agent.orgId)).toEqual([]);
    const denial = (
      await db.select().from(auditEvents).where(eq(auditEvents.orgId, agent.orgId))
    ).find(
      (event) =>
        event.action === "run.builder_plan_denied" &&
        (event.payload as { source?: unknown }).source === "agent_scheduler",
    );
    expect(denial).toMatchObject({
      projectId: agent.projectId,
      payload: { code: "builder_plan_required", source: "agent_scheduler" },
    });
  });

  async function insertAgent(
    name: string,
    input: {
      triggers: unknown[];
      lastScheduledAt: Date | null;
      builderPlanPolicy?: "optional" | "required";
    },
  ) {
    const suffix = `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const orgId = newId("org");
    const projectId = newId("proj");
    await db.insert(orgs).values({ id: orgId, name: `Org ${suffix}`, slug: `org-${suffix}` });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      builderPlanPolicy: input.builderPlanPolicy ?? "optional",
      settings: {},
    });
    const item = (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId,
          kind: "agent_contract",
          name: `contract-${suffix}`,
        })
        .returning()
    )[0];
    const agent = (
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId,
          name,
          engine: "codex",
          model: {},
          contractItemId: item?.id ?? "",
          triggers: input.triggers,
          lastScheduledAt: input.lastScheduledAt,
          enabled: true,
        })
        .returning()
    )[0];
    if (!agent) throw new Error("failed to insert agent");
    return agent;
  }
});
