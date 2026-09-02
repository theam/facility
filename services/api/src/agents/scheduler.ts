import { agentSchedules, type FacilityDb, projects } from "@facility/db";
import cronParser from "cron-parser";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { StoryWorkspaceService } from "../stories/service.js";
import type { ProjectManifest, ProjectManifestSource } from "../workspaces/project-environment.js";
import { type AgentCatalogService, manifestFromProjection } from "./catalog.js";

export class AgentScheduler {
  constructor(
    private readonly db: FacilityDb,
    private readonly catalog: AgentCatalogService,
    private readonly stories: StoryWorkspaceService,
    private readonly projectManifests: ProjectManifestSource,
    private readonly defaultImage: string,
  ) {}

  async tick(now = new Date()) {
    const failures: Array<{ projectId: string; error: string }> = [];
    const activeProjects = await this.db
      .select({ id: projects.id, orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.status, "active"));
    for (const project of activeProjects) {
      try {
        await this.syncProject(project.orgId, project.id, now);
      } catch (error) {
        failures.push({
          projectId: project.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const due = await this.db
      .select()
      .from(agentSchedules)
      .where(and(eq(agentSchedules.enabled, true), lte(agentSchedules.nextRunAt, now)));
    let scheduled = 0;
    for (const schedule of due) {
      const claimed = await this.claim(schedule, now);
      if (!claimed) continue;
      try {
        const [projectManifest, projection] = await Promise.all([
          this.projectManifests.load(schedule.orgId, schedule.projectId),
          this.catalog.get(schedule.orgId, schedule.projectId, schedule.agentName, {
            refresh: false,
          }),
        ]);
        const agent = manifestFromProjection(projection);
        await this.stories.start({
          orgId: schedule.orgId,
          projectId: schedule.projectId,
          provider: "schedule",
          externalId: `${schedule.agentName}:${schedule.triggerName}`,
          title: `${schedule.agentName}: ${schedule.triggerName}`,
          agent,
          message: `Run scheduled agent ${schedule.agentName} (${schedule.triggerName}) for ${schedule.nextRunAt.toISOString()}.`,
          messageDedupeKey: `schedule:${schedule.agentName}:${schedule.triggerName}:${schedule.nextRunAt.toISOString()}`,
          actor: { type: "system", id: `schedule:${schedule.triggerName}` },
          workspace: workspaceInput(projectManifest, this.defaultImage),
          trigger: {
            type: "schedule",
            key: `schedule:${schedule.triggerName}`,
            scheduledFor: schedule.nextRunAt,
          },
        });
        scheduled += 1;
      } catch (error) {
        failures.push({
          projectId: schedule.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { projects: activeProjects.length, due: due.length, scheduled, failures };
  }

  private async syncProject(orgId: string, projectId: string, now: Date) {
    const manifests = (await this.catalog.list(orgId, projectId)).map((row) =>
      manifestFromProjection(row),
    );
    await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`facility:schedules:${orgId}:${projectId}`}))`,
      );
      await tx
        .update(agentSchedules)
        .set({ enabled: false, updatedAt: now })
        .where(and(eq(agentSchedules.orgId, orgId), eq(agentSchedules.projectId, projectId)));
      for (const manifest of manifests) {
        for (const trigger of manifest.triggers) {
          if (trigger.type !== "schedule") continue;
          const existing = (
            await tx
              .select()
              .from(agentSchedules)
              .where(
                and(
                  eq(agentSchedules.projectId, projectId),
                  eq(agentSchedules.agentName, manifest.name),
                  eq(agentSchedules.triggerName, trigger.name),
                ),
              )
              .limit(1)
          )[0];
          const unchanged =
            existing?.manifestHash === manifest.hash &&
            existing.cron === trigger.cron &&
            existing.timezone === trigger.timezone;
          if (existing && unchanged) {
            await tx
              .update(agentSchedules)
              .set({ enabled: manifest.enabled, updatedAt: now })
              .where(
                and(
                  eq(agentSchedules.projectId, projectId),
                  eq(agentSchedules.agentName, manifest.name),
                  eq(agentSchedules.triggerName, trigger.name),
                ),
              );
            continue;
          }
          const nextRunAt = nextOccurrence(trigger.cron, trigger.timezone, now);
          await tx
            .insert(agentSchedules)
            .values({
              orgId,
              projectId,
              agentName: manifest.name,
              triggerName: trigger.name,
              manifestHash: manifest.hash,
              cron: trigger.cron,
              timezone: trigger.timezone,
              enabled: manifest.enabled,
              nextRunAt,
            })
            .onConflictDoUpdate({
              target: [
                agentSchedules.projectId,
                agentSchedules.agentName,
                agentSchedules.triggerName,
              ],
              set: {
                orgId,
                manifestHash: manifest.hash,
                cron: trigger.cron,
                timezone: trigger.timezone,
                enabled: manifest.enabled,
                nextRunAt,
                updatedAt: now,
              },
            });
        }
      }
    });
  }

  private async claim(schedule: typeof agentSchedules.$inferSelect, now: Date) {
    const nextRunAt = nextOccurrence(schedule.cron, schedule.timezone, schedule.nextRunAt);
    return (
      await this.db
        .update(agentSchedules)
        .set({ nextRunAt, lastScheduledAt: schedule.nextRunAt, updatedAt: now })
        .where(
          and(
            eq(agentSchedules.projectId, schedule.projectId),
            eq(agentSchedules.agentName, schedule.agentName),
            eq(agentSchedules.triggerName, schedule.triggerName),
            eq(agentSchedules.enabled, true),
            eq(agentSchedules.nextRunAt, schedule.nextRunAt),
            schedule.lastScheduledAt
              ? eq(agentSchedules.lastScheduledAt, schedule.lastScheduledAt)
              : isNull(agentSchedules.lastScheduledAt),
          ),
        )
        .returning({ projectId: agentSchedules.projectId })
    )[0];
  }
}

function nextOccurrence(cron: string, timezone: string, from: Date) {
  return cronParser.parseExpression(cron, { currentDate: from, tz: timezone }).next().toDate();
}

function workspaceInput(manifest: ProjectManifest, defaultImage: string) {
  return {
    image: manifest.environment.image ?? defaultImage,
    ports: Object.entries(manifest.environment.services).map(([service, value]) => ({
      service,
      port: value.port,
      protocol: value.protocol,
      websocket: value.websocket,
    })),
  };
}
