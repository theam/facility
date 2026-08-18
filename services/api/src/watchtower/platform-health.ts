import { type FacilityDb, llmRequests, projects, runs, sandboxProfiles } from "@facility/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { raisePlatformIssue, resolvePlatformIssue } from "./issues.js";

type Resources = { timeout_min?: unknown; timeoutMin?: unknown };

function resourceTimeoutMin(resources: unknown) {
  const value = resources as Resources;
  const raw = value.timeout_min ?? value.timeoutMin;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 60;
}

export async function collectPlatformHealth(db: FacilityDb) {
  await detectStuckRuns(db);
  await detectGatewayErrors(db);
  await detectDispatchDepth(db);
}

async function detectStuckRuns(db: FacilityDb) {
  const activeRuns = await db
    .select({ run: runs, profile: sandboxProfiles })
    .from(runs)
    .leftJoin(
      sandboxProfiles,
      and(
        eq(sandboxProfiles.orgId, runs.orgId),
        or(eq(sandboxProfiles.projectId, runs.projectId), isNull(sandboxProfiles.projectId)),
      ),
    )
    .where(inArray(runs.status, ["queued", "provisioning"]));
  const now = Date.now();
  for (const row of activeRuns) {
    const started = row.run.startedAt ?? row.run.queuedAt;
    const timeoutMin = resourceTimeoutMin(row.profile?.resources);
    const ageMin = (now - started.getTime()) / 60_000;
    const fingerprint = `run_failure:${row.run.id}:stuck`;
    if (ageMin > timeoutMin * 2) {
      await raisePlatformIssue(db, {
        orgId: row.run.orgId,
        projectId: row.run.projectId,
        kind: "platform_failure",
        severity: "error",
        fingerprint,
        title: "Platform run stuck",
        bodyMd: `Run ${row.run.id} has been ${row.run.status} for ${Math.round(
          ageMin,
        )} minutes (profile timeout ${timeoutMin}m).`,
      });
    } else {
      await resolvePlatformIssue(db, row.run.orgId, fingerprint, "run is no longer stuck");
    }
  }
}

async function detectGatewayErrors(db: FacilityDb) {
  const rows = await db
    .select({
      orgId: projects.orgId,
      projectId: projects.id,
      total: sql<number>`count(${llmRequests.id})::int`,
      errors: sql<number>`count(${llmRequests.id}) filter (where ${llmRequests.status} <> 'ok')::int`,
    })
    .from(projects)
    .leftJoin(
      llmRequests,
      and(
        eq(llmRequests.projectId, projects.id),
        sql`${llmRequests.createdAt} >= now() - interval '1 hour'`,
      ),
    )
    .groupBy(projects.orgId, projects.id);
  for (const row of rows) {
    const total = Number(row.total ?? 0);
    const errors = Number(row.errors ?? 0);
    const rate = total === 0 ? 0 : errors / total;
    const fingerprint = `integration_error:${row.projectId}:gateway_error_rate`;
    if (total >= 10 && rate >= 0.2) {
      await raisePlatformIssue(db, {
        orgId: row.orgId,
        projectId: row.projectId,
        kind: "integration_error",
        severity: "error",
        fingerprint,
        title: "Gateway error rate elevated",
        bodyMd: `${errors}/${total} gateway requests failed in the last hour.`,
      });
    } else {
      await resolvePlatformIssue(db, row.orgId, fingerprint, "gateway error rate recovered");
    }
  }
}

async function detectDispatchDepth(db: FacilityDb) {
  const depth = await dispatchDepth(db);
  if (depth == null) return;
  const activeProjects = await db.select().from(projects).where(eq(projects.status, "active"));
  for (const project of activeProjects) {
    const fingerprint = `run_failure:${project.id}:dispatch_queue_depth`;
    if (depth > 100) {
      await raisePlatformIssue(db, {
        orgId: project.orgId,
        projectId: project.id,
        kind: "platform_failure",
        severity: "error",
        fingerprint,
        title: "Dispatch queue depth elevated",
        bodyMd: `runs.dispatch has ${depth} queued jobs.`,
      });
    } else {
      await resolvePlatformIssue(db, project.orgId, fingerprint, "dispatch queue depth recovered");
    }
  }
}

async function dispatchDepth(db: FacilityDb) {
  try {
    const rows = await db.execute(sql`
      select count(*)::int as depth
      from pgboss.job
      where name = 'runs.dispatch' and state in ('created', 'retry')
    `);
    const row = (rows as unknown as Array<{ depth?: number }>)[0];
    return Number(row?.depth ?? 0);
  } catch {
    return null;
  }
}
