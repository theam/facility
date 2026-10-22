import type PgBoss from "pg-boss";
import { githubRateLimitRetryAt } from "./rate-limit.js";

export const GITHUB_MIRROR_QUEUE = "github.mirror";

/** Project syncs this process may run at once, so one slow repository does not block the rest. */
export const MIRROR_POOL_SIZE = 2;

export type MirrorTarget = { orgId: string; projectId: string };

type MirrorLogger = {
  info: (data: Record<string, unknown>, message: string) => void;
};

type MirrorDeps = {
  listProjects: () => Promise<MirrorTarget[]>;
  syncProject: (orgId: string, projectId: string) => Promise<unknown>;
  send: (
    queue: string,
    data: MirrorTarget,
    options?: { startAfter?: Date },
  ) => Promise<string | null>;
  logger: MirrorLogger;
};

export function mirrorTarget(data: unknown): MirrorTarget | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as { orgId?: unknown; projectId?: unknown };
  if (typeof record.orgId !== "string" || typeof record.projectId !== "string") return undefined;
  if (!record.orgId || !record.projectId) return undefined;
  return { orgId: record.orgId, projectId: record.projectId };
}

export async function handleGithubMirrorJob(
  job: { id?: string; data?: unknown },
  deps: MirrorDeps,
): Promise<Record<string, unknown>> {
  const target = mirrorTarget(job.data);
  if (!target) {
    const projects = await deps.listProjects();
    for (const project of projects) {
      const enqueued = await deps.send(GITHUB_MIRROR_QUEUE, project);
      if (!enqueued) throw new Error("GitHub mirror project job was not enqueued");
    }
    return { fanout: true, projects: projects.length };
  }

  try {
    await deps.syncProject(target.orgId, target.projectId);
    return { orgId: target.orgId, projectId: target.projectId, synced: true };
  } catch (error) {
    const retryAt = githubRateLimitRetryAt(error);
    if (!retryAt) throw error;
    const replacement = await deps.send(GITHUB_MIRROR_QUEUE, target, { startAfter: retryAt });
    if (!replacement) throw new Error("GitHub rate-limit retry was not enqueued");
    deps.logger.info(
      {
        queue: GITHUB_MIRROR_QUEUE,
        jobId: job.id,
        orgId: target.orgId,
        projectId: target.projectId,
        retryAt,
      },
      "deferred GitHub mirror until provider rate limit resets",
    );
    return { orgId: target.orgId, projectId: target.projectId, deferred: true, retryAt };
  }
}

export function registerGithubMirrorWorker(
  boss: Pick<PgBoss, "work" | "send">,
  mirror: {
    activeProjects: () => Promise<MirrorTarget[]>;
    syncProject: (orgId: string, projectId: string) => Promise<unknown>;
  },
  logger: MirrorLogger,
) {
  const handler: PgBoss.WorkHandler<unknown> = async (jobs) => {
    const job = jobs[0];
    if (!job) return;
    const result = await handleGithubMirrorJob(job, {
      listProjects: () => mirror.activeProjects(),
      syncProject: (orgId, projectId) => mirror.syncProject(orgId, projectId),
      send: (queue, data, options) =>
        options ? boss.send(queue, data, options) : boss.send(queue, data),
      logger,
    });
    logger.info({ queue: GITHUB_MIRROR_QUEUE, jobId: job.id, ...result }, "worker completed job");
  };
  return Promise.all(
    Array.from({ length: MIRROR_POOL_SIZE }, () =>
      boss.work(GITHUB_MIRROR_QUEUE, { batchSize: 1 }, handler),
    ),
  );
}
