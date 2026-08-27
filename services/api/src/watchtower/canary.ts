import { createHash } from "node:crypto";
import { newId } from "@facility/core";
import {
  agentDefs,
  createDb,
  type FacilityDb,
  projects,
  repos,
  runEvents,
  runs,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import { isBuilderPlanDenialError, withBuilderPlanPreflight } from "../builder-plan-policy.js";
import type { AppConfig } from "../types.js";
import { createGitHubClient, type GitHubClient } from "./github.js";
import { raisePlatformIssue, resolvePlatformIssue } from "./issues.js";

export const CANARY_MESSAGE = "Facility watchtower canary: pinned architect acknowledgement probe.";
export const CANARY_MESSAGE_HASH = createHash("sha256").update(CANARY_MESSAGE).digest("hex");

type CanarySettings = {
  enabled?: boolean;
  lane?: "platform" | "repo";
  agentDefId?: string;
  workflowName?: string;
};

type ProjectSettings = {
  watchtower?: { canary?: CanarySettings };
};

type Dispatch = (queue: string, data: Record<string, unknown>) => Promise<unknown>;

function canarySettings(settings: unknown): CanarySettings {
  return (settings as ProjectSettings).watchtower?.canary ?? {};
}

function weekStart() {
  return new Date(Date.now() - 7 * 24 * 3600_000);
}

function objectValue(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export async function runWatchtowerCanary(
  config: AppConfig,
  dispatch?: Dispatch,
  github: GitHubClient = createGitHubClient(),
) {
  const { db, client } = createDb(config.databaseUrl);
  try {
    await collectCanaries(db, github, dispatch);
  } finally {
    await client.end();
  }
}

export async function collectCanaries(db: FacilityDb, github: GitHubClient, dispatch?: Dispatch) {
  const activeProjects = await db.select().from(projects).where(eq(projects.status, "active"));
  for (const project of activeProjects) {
    const settings = canarySettings(project.settings);
    if (!settings.enabled) continue;
    if (settings.lane === "repo") {
      await verifyRepoCanary(db, github, project.id, project.orgId, settings.workflowName);
    } else {
      await verifyPlatformCanary(db, github, project.id, project.orgId, settings, dispatch);
    }
  }
}

async function verifyPlatformCanary(
  db: FacilityDb,
  github: GitHubClient,
  projectId: string,
  orgId: string,
  settings: CanarySettings,
  dispatch?: Dispatch,
) {
  const fingerprint = `canary_failure:${projectId}:platform:${CANARY_MESSAGE_HASH}`;
  const recent = (
    await db
      .select()
      .from(runs)
      .where(and(eq(runs.orgId, orgId), eq(runs.projectId, projectId)))
  )
    .filter((run) => {
      const trigger = objectValue(run.trigger);
      return (
        trigger.kind === "watchtower.canary" &&
        trigger.messageHash === CANARY_MESSAGE_HASH &&
        run.createdAt >= weekStart()
      );
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const latest = recent[0];
  if (!latest) {
    const agent = await canaryAgent(db, orgId, projectId, settings.agentDefId);
    if (!agent) {
      await raisePlatformIssue(db, {
        orgId,
        projectId,
        kind: "canary_failure",
        severity: "error",
        fingerprint,
        title: "Canary agent missing",
        bodyMd: "No enabled architect agent_def is available for the platform canary.",
      });
      return;
    }
    const trigger = {
      kind: "watchtower.canary",
      message: CANARY_MESSAGE,
      messageHash: CANARY_MESSAGE_HASH,
    };
    let run: typeof runs.$inferSelect | undefined;
    try {
      run = (
        await withBuilderPlanPreflight(
          db,
          {
            orgId,
            projectId,
            mode: "architect",
            agentDefId: agent.id,
            trigger,
            actor: { type: "system", id: "watchtower" },
            source: "watchtower_canary",
          },
          (tx, admission) =>
            tx
              // builder-plan-preflight: watchtower_canary
              .insert(runs)
              .values({
                id: newId("run"),
                orgId,
                projectId,
                agentDefId: agent.id,
                mode: admission.mode,
                engine: agent.engine,
                trigger,
                createdBy: { type: "system", id: "watchtower" },
              })
              .returning(),
        )
      )[0];
    } catch (error) {
      if (!isBuilderPlanDenialError(error)) throw error;
      await raisePlatformIssue(db, {
        orgId,
        projectId,
        kind: "canary_failure",
        severity: "error",
        fingerprint,
        title: "Canary agent blocked by Builder plan policy",
        bodyMd:
          "The configured canary agent also resolves as Builder and cannot run without canonical plan acceptance.",
      });
      return;
    }
    if (run) {
      await db.insert(runEvents).values({
        orgId,
        runId: run.id,
        seq: 1,
        type: "queued",
        data: { queue: "runs.dispatch", canary: true, messageHash: CANARY_MESSAGE_HASH },
      });
      await dispatch?.("runs.dispatch", { orgId, runId: run.id });
    }
    return;
  }
  if (!["succeeded", "failed", "canceled"].includes(latest.status)) return;
  const independentEvidence = await hasIndependentCanaryEvidence(db, github, projectId);
  if (latest.status === "succeeded" && independentEvidence) {
    await resolvePlatformIssue(db, orgId, fingerprint, "platform canary passed");
    return;
  }
  if (latest.status === "succeeded") {
    // A platform-lane run's status, receipt, and gh fields are written by the
    // runner itself. Without independent GitHub evidence this is inconclusive,
    // not a pass and not a red health signal.
    return;
  }
  await raisePlatformIssue(db, {
    orgId,
    projectId,
    kind: "canary_failure",
    severity: "error",
    fingerprint,
    title: "Platform canary failed",
    bodyMd: `Latest canary run ${latest.id} ended ${latest.status}.`,
  });
}

async function hasIndependentCanaryEvidence(
  db: FacilityDb,
  github: GitHubClient,
  projectId: string,
) {
  const projectRepos = await db.select().from(repos).where(eq(repos.projectId, projectId));
  for (const repo of projectRepos) {
    const week = await github.listWorkflowRuns(
      { owner: repo.owner, name: repo.name },
      weekStart().toISOString(),
    );
    if (
      week.some(
        (run) =>
          run.name === "facility-canary" &&
          run.status === "completed" &&
          run.conclusion === "success",
      )
    ) {
      return true;
    }
  }
  return false;
}

async function canaryAgent(
  db: FacilityDb,
  orgId: string,
  projectId: string,
  configuredId?: string,
) {
  if (configuredId) {
    const configured = (
      await db
        .select()
        .from(agentDefs)
        .where(
          and(
            eq(agentDefs.orgId, orgId),
            eq(agentDefs.projectId, projectId),
            eq(agentDefs.id, configuredId),
          ),
        )
        .limit(1)
    )[0];
    if (configured?.enabled) return configured;
  }
  const agents = await db
    .select()
    .from(agentDefs)
    .where(
      and(
        eq(agentDefs.orgId, orgId),
        eq(agentDefs.projectId, projectId),
        eq(agentDefs.enabled, true),
      ),
    );
  return agents.find((agent) => /architect/i.test(agent.name)) ?? agents[0] ?? null;
}

async function verifyRepoCanary(
  db: FacilityDb,
  github: GitHubClient,
  projectId: string,
  orgId: string,
  workflowName = "facility-canary",
) {
  const projectRepos = await db.select().from(repos).where(eq(repos.projectId, projectId));
  for (const repo of projectRepos) {
    const fingerprint = `canary_failure:${repo.id}:repo`;
    const week = await github.listWorkflowRuns(
      { owner: repo.owner, name: repo.name },
      weekStart().toISOString(),
    );
    const passed = week.some(
      (run) =>
        run.name === workflowName && run.status === "completed" && run.conclusion === "success",
    );
    if (passed) {
      await resolvePlatformIssue(db, orgId, fingerprint, "repo canary workflow passed this week");
    } else {
      await raisePlatformIssue(db, {
        orgId,
        projectId,
        kind: "canary_failure",
        severity: "error",
        fingerprint,
        title: "Repo canary missing or failing",
        bodyMd: `${repo.owner}/${repo.name} has no successful ${workflowName} run this week.`,
      });
    }
  }
}
