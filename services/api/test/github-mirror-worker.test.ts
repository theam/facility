import type PgBoss from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_MIRROR_QUEUE,
  handleGithubMirrorJob,
  MIRROR_POOL_SIZE,
  registerGithubMirrorWorker,
} from "../src/github/mirror-worker.js";

const projects = [
  { orgId: "org_a", projectId: "proj_a" },
  { orgId: "org_b", projectId: "proj_b" },
];

describe("per-project GitHub mirror jobs", () => {
  it("enqueues one job per active project and does not sync inside the fan-out", async () => {
    const send = vi.fn().mockResolvedValue("job-id");
    const syncProject = vi.fn();
    const result = await handleGithubMirrorJob(
      { id: "fanout", data: {} },
      {
        listProjects: async () => projects,
        syncProject,
        send,
        logger: { info: vi.fn() },
      },
    );
    expect(result).toEqual({ fanout: true, projects: 2 });
    expect(syncProject).not.toHaveBeenCalled();
    expect(send.mock.calls.map((call) => call[1])).toEqual(projects);
    expect(send.mock.calls.every((call) => call[0] === GITHUB_MIRROR_QUEUE)).toBe(true);
  });

  it("defers only the throttled project until the provider reset", async () => {
    const reset = Math.floor(Date.now() / 1_000) + 3_000;
    const failure = {
      status: 403,
      response: {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(reset),
        },
      },
    };
    const send = vi.fn().mockResolvedValue("replacement-id");
    const syncProject = vi.fn().mockRejectedValue(failure);
    const logger = { info: vi.fn() };
    const target = projects[0];
    if (!target) throw new Error("expected a project");
    const result = await handleGithubMirrorJob(
      { id: "job-1", data: target },
      { listProjects: async () => projects, syncProject, send, logger },
    );
    const retryAt = new Date(reset * 1_000 + 1_000);
    expect(syncProject).toHaveBeenCalledTimes(1);
    expect(syncProject).toHaveBeenCalledWith(target.orgId, target.projectId);
    expect(send).toHaveBeenCalledWith(GITHUB_MIRROR_QUEUE, target, { startAfter: retryAt });
    expect(result).toMatchObject({ deferred: true, retryAt, projectId: target.projectId });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("rate limit exceeded");

    send.mockResolvedValueOnce(null);
    await expect(
      handleGithubMirrorJob(
        { id: "job-2", data: target },
        { listProjects: async () => projects, syncProject, send, logger },
      ),
    ).rejects.toThrow("retry was not enqueued");

    const other = new Error("repository listing failed");
    syncProject.mockRejectedValueOnce(other);
    await expect(
      handleGithubMirrorJob(
        { id: "job-3", data: target },
        { listProjects: async () => projects, syncProject, send, logger },
      ),
    ).rejects.toBe(other);
  });

  it("registers a small mirror pool with one project per callback", async () => {
    expect(MIRROR_POOL_SIZE).toBeGreaterThan(1);
    expect(MIRROR_POOL_SIZE).toBeLessThanOrEqual(4);
    const work = vi.fn().mockResolvedValue("worker-id");
    const syncProject = vi.fn().mockResolvedValue({ repositories: 1 });
    await registerGithubMirrorWorker(
      { work, send: vi.fn() } as unknown as Pick<PgBoss, "work" | "send">,
      { activeProjects: async () => projects, syncProject },
      { info: vi.fn() },
    );
    expect(work).toHaveBeenCalledTimes(MIRROR_POOL_SIZE);
    const callback = work.mock.calls[0]?.[2] as (jobs: unknown[]) => Promise<void>;
    expect(work.mock.calls.every((call) => call[1]?.batchSize === 1 && call[2] === callback)).toBe(
      true,
    );
    await callback([{ id: "job-1", data: projects[0] }]);
    expect(syncProject).toHaveBeenCalledTimes(1);
  });
});
