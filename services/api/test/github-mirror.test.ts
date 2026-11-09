import { randomUUID } from "node:crypto";
import { newId } from "@facility/core";
import {
  createDb,
  githubChecks,
  githubInstallations,
  githubPullRequests,
  migrate,
  orgs,
  projectRepositories,
  projects,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GithubMirrorService } from "../src/github/mirror.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";

async function canConnect() {
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe("GitHub mirror reconciliation", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; mirror tests skipped", () => undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org");
  const projectId = newId("proj");
  const installationId = newId("ghi");
  const repositoryId = newId("repo");
  const headSha = "b".repeat(40);

  beforeAll(async () => {
    await migrate(databaseUrl);
    await db.insert(orgs).values({
      id: orgId,
      name: "Mirror",
      slug: `mirror-${suffix}`,
      settings: {},
    });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Mirror",
      slug: `mirror-${suffix}`,
      settings: {},
    });
    await db.insert(githubInstallations).values({
      id: installationId,
      orgId,
      installationId: Math.floor(Math.random() * 1_000_000_000) + 500_000,
      accountId: 1,
      accountLogin: "acme",
      targetType: "Organization",
    });
    await db.insert(projectRepositories).values({
      id: repositoryId,
      orgId,
      projectId,
      installationId,
      owner: "acme",
      name: `app-${suffix}`,
      defaultBranch: "main",
      role: "primary",
    });
  });

  afterAll(async () => {
    await client.end();
  });

  it("continues a project sync when commit statuses are forbidden", async () => {
    const request = async (route: string) => {
      if (route.endsWith("/branches") || route.endsWith("/issues")) return { data: [] };
      if (route.endsWith("/pulls")) {
        return {
          data: [
            {
              number: 41,
              title: "Ship the mirror",
              state: "open",
              html_url: "https://github.com/acme/app/pull/41",
              head: { ref: "facility/status", sha: headSha },
              base: { ref: "main" },
              updated_at: "2026-09-04T10:00:00Z",
            },
          ],
        };
      }
      if (route.endsWith("/status")) {
        throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
      }
      if (route.endsWith("/check-runs")) {
        return {
          data: {
            check_runs: [
              {
                id: 4101,
                name: "verify",
                status: "completed",
                conclusion: "success",
                head_sha: headSha,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected GitHub route ${route}`);
    };
    const mirror = new GithubMirrorService(db, async () => ({ request, rest: {} as never }));

    await expect(mirror.syncProject(orgId, projectId)).resolves.toMatchObject({
      pullRequests: 1,
      checks: 1,
    });
    const [pull] = await db
      .select()
      .from(githubPullRequests)
      .where(
        and(eq(githubPullRequests.repositoryId, repositoryId), eq(githubPullRequests.number, 41)),
      );
    expect(pull).toMatchObject({ number: 41, headSha, state: "open" });
    const [check] = await db
      .select()
      .from(githubChecks)
      .where(eq(githubChecks.repositoryId, repositoryId));
    expect(check).toMatchObject({
      pullNumber: 41,
      checkId: "4101",
      name: "verify",
      headSha,
    });
  });

  it("still aborts a project sync when commit statuses fail for another reason", async () => {
    const head = "c".repeat(40);
    const request = async (route: string) => {
      if (route.endsWith("/branches") || route.endsWith("/issues")) return { data: [] };
      if (route.endsWith("/pulls")) {
        return {
          data: [
            {
              number: 42,
              title: "Keep status failures visible",
              state: "open",
              html_url: "https://github.com/acme/app/pull/42",
              head: { ref: "facility/status-error", sha: head },
              base: { ref: "main" },
              updated_at: "2026-09-04T11:00:00Z",
            },
          ],
        };
      }
      if (route.endsWith("/status")) {
        throw Object.assign(new Error("status upstream failed"), { status: 500 });
      }
      if (route.endsWith("/check-runs")) return { data: { check_runs: [] } };
      throw new Error(`unexpected GitHub route ${route}`);
    };
    const mirror = new GithubMirrorService(db, async () => ({ request, rest: {} as never }));
    await expect(mirror.syncProject(orgId, projectId)).rejects.toMatchObject({ status: 500 });
  });

  function mirrorFor(
    pull: { number: number; title: string; sha: string; ref: string; updatedAt: string },
    statusError: unknown,
    checkRuns: Record<string, unknown>[],
  ) {
    const request = async (route: string) => {
      if (route.endsWith("/branches") || route.endsWith("/issues")) return { data: [] };
      if (route.endsWith("/pulls")) {
        return {
          data: [
            {
              number: pull.number,
              title: pull.title,
              state: "open",
              html_url: `https://github.com/acme/app/pull/${pull.number}`,
              head: { ref: pull.ref, sha: pull.sha },
              base: { ref: "main" },
              updated_at: pull.updatedAt,
            },
          ],
        };
      }
      if (route.endsWith("/status")) throw statusError;
      if (route.endsWith("/check-runs")) return { data: { check_runs: checkRuns } };
      throw new Error(`unexpected GitHub route ${route}`);
    };
    return new GithubMirrorService(db, async () => ({ request, rest: {} as never }));
  }

  async function savedPull(number: number) {
    const [pull] = await db
      .select()
      .from(githubPullRequests)
      .where(
        and(
          eq(githubPullRequests.repositoryId, repositoryId),
          eq(githubPullRequests.number, number),
        ),
      );
    return pull;
  }

  it("does not record success when commit statuses are unreadable", async () => {
    const sha = "d".repeat(40);
    const mirror = mirrorFor(
      {
        number: 43,
        title: "Unreadable statuses",
        sha,
        ref: "facility/unreadable-success",
        updatedAt: "2026-09-04T12:00:00Z",
      },
      { status: 403 },
      [
        {
          id: 4301,
          name: "verify",
          status: "completed",
          conclusion: "success",
          head_sha: sha,
        },
      ],
    );

    await expect(mirror.syncProject(orgId, projectId)).resolves.toMatchObject({
      pullRequests: 1,
      checks: 1,
    });
    const pull = await savedPull(43);
    expect(pull?.ciState).toBeNull();
    expect(pull?.ciHeadSha).toBe(sha);
  });

  it("still reports a failing check run when commit statuses are unreadable", async () => {
    const sha = "e".repeat(40);
    const mirror = mirrorFor(
      {
        number: 44,
        title: "Unreadable statuses with a failure",
        sha,
        ref: "facility/unreadable-failure",
        updatedAt: "2026-09-04T13:00:00Z",
      },
      { status: 403 },
      [
        {
          id: 4401,
          name: "verify",
          status: "completed",
          conclusion: "failure",
          head_sha: sha,
        },
      ],
    );

    await expect(mirror.syncProject(orgId, projectId)).resolves.toMatchObject({
      pullRequests: 1,
      checks: 1,
    });
    const pull = await savedPull(44);
    expect(pull?.ciState).toBe("failure");
    expect(pull?.ciFailureNames).toEqual(["verify"]);
  });

  it("aborts when the statuses 403 is a rate limit", async () => {
    const sha = "f".repeat(40);
    const mirror = mirrorFor(
      {
        number: 45,
        title: "Rate limited statuses",
        sha,
        ref: "facility/rate-limit",
        updatedAt: "2026-09-04T14:00:00Z",
      },
      {
        status: 403,
        response: {
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      },
      [
        {
          id: 4501,
          name: "verify",
          status: "completed",
          conclusion: "success",
          head_sha: sha,
        },
      ],
    );

    await expect(mirror.syncProject(orgId, projectId)).rejects.toMatchObject({ status: 403 });
  });

  it("records pending when an in-progress check run has unreadable statuses", async () => {
    const sha = "1".repeat(40);
    const mirror = mirrorFor(
      {
        number: 46,
        title: "Unreadable statuses with a running check",
        sha,
        ref: "facility/unreadable-pending",
        updatedAt: "2026-09-04T15:00:00Z",
      },
      { status: 403 },
      [
        {
          id: 4601,
          name: "verify",
          status: "in_progress",
          head_sha: sha,
        },
      ],
    );

    await expect(mirror.syncProject(orgId, projectId)).resolves.toMatchObject({
      pullRequests: 1,
      checks: 1,
    });
    const pull = await savedPull(46);
    expect(pull?.ciState).toBe("pending");
    expect(pull?.ciHeadSha).toBe(sha);
  });
});
