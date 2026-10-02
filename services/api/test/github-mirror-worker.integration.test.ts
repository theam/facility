import { randomUUID } from "node:crypto";
import { newId } from "@facility/core";
import { createDb, migrate, orgs, projects } from "@facility/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GithubMirrorService } from "../src/github/mirror.js";
import { handleGithubMirrorJob } from "../src/github/mirror-worker.js";

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

describe("mirror fan-out selects active projects", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; mirror fan-out tests skipped", () =>
      undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org");
  const activeId = newId("proj");
  const archivedId = newId("proj");

  beforeAll(async () => {
    await migrate(databaseUrl);
    await db.insert(orgs).values({
      id: orgId,
      name: "Mirror fan-out",
      slug: `mirror-fanout-${suffix}`,
      settings: {},
    });
    await db.insert(projects).values([
      {
        id: activeId,
        orgId,
        name: "Active",
        slug: `mirror-active-${suffix}`,
        settings: {},
        status: "active",
      },
      {
        id: archivedId,
        orgId,
        name: "Archived",
        slug: `mirror-archived-${suffix}`,
        settings: {},
        status: "archived",
      },
    ]);
  });

  afterAll(async () => {
    await client.end();
  });

  it("enqueues the active project and leaves the archived project out", async () => {
    const mirror = new GithubMirrorService(db, async () => {
      throw new Error("mirror fan-out must not call GitHub");
    });
    const listed = await mirror.activeProjects();
    expect(listed).toContainEqual({ orgId, projectId: activeId });
    expect(listed).not.toContainEqual({ orgId, projectId: archivedId });

    const send = vi.fn().mockResolvedValue("job-id");
    const syncProject = vi.fn();
    await handleGithubMirrorJob(
      { id: "fanout", data: {} },
      {
        listProjects: () => mirror.activeProjects(),
        syncProject,
        send,
        logger: { info: vi.fn() },
      },
    );
    const enqueued = send.mock.calls.map((call) => call[1]);
    expect(enqueued).toContainEqual({ orgId, projectId: activeId });
    expect(enqueued).not.toContainEqual({ orgId, projectId: archivedId });
    expect(syncProject).not.toHaveBeenCalled();
  });
});
