import { randomUUID } from "node:crypto";
import { newId } from "@facility/core";
import { createDb, migrate, orgs, projects, stories, workspaces } from "@facility/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isComputeSuspended,
  LIVE_WORKSPACE_STATES,
  recordDeleting,
  recordDestroyed,
  recordFailed,
  recordRunning,
  recordSleeping,
  WORKSPACE_RECORD_STATES,
} from "../src/workspaces/lifecycle.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
// Its own org, so the projects it creates never crowd another suite's org listings.
const ORG = newId("org");

describe("workspace record lifecycle", () => {
  const { db, client } = createDb(databaseUrl);

  beforeAll(async () => {
    await migrate(databaseUrl);
    await db.insert(orgs).values({ id: ORG, name: "Lifecycle", slug: `lifecycle-${ORG}` });
  });

  afterAll(async () => client.end());

  async function workspace(state: string = "creating") {
    const suffix = randomUUID().slice(0, 8);
    const projectId = newId("proj");
    const storyId = newId("story");
    const workspaceId = newId("ws");
    await db.insert(projects).values({
      id: projectId,
      orgId: ORG,
      name: `Lifecycle ${suffix}`,
      slug: `lifecycle-${suffix}`,
    });
    await db.insert(stories).values({
      id: storyId,
      orgId: ORG,
      projectId,
      provider: "manual",
      externalId: storyId,
      title: "Lifecycle",
      createdBy: { type: "user", id: "user_local_admin" },
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId: ORG,
      projectId,
      storyId,
      provider: "fake",
      volumeRef: `fake://${workspaceId}`,
      state,
    });
    return { ref: { orgId: ORG, projectId, storyId, workspaceId }, projectId, storyId };
  }

  async function row(workspaceId: string) {
    const [found] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!found) throw new Error("workspace row missing");
    return found;
  }

  it("lists exactly the states the database accepts", async () => {
    const { ref } = await workspace();
    for (const state of WORKSPACE_RECORD_STATES) {
      await db.update(workspaces).set({ state }).where(eq(workspaces.id, ref.workspaceId));
      expect((await row(ref.workspaceId)).state).toBe(state);
    }
    await expect(
      db.update(workspaces).set({ state: "paused" }).where(eq(workspaces.id, ref.workspaceId)),
    ).rejects.toThrow();
  });

  it("keeps one live record per story, as the live states promise", async () => {
    const { ref, projectId, storyId } = await workspace("sleeping");
    await expect(
      db.insert(workspaces).values({
        id: newId("ws"),
        orgId: ORG,
        projectId,
        storyId,
        provider: "fake",
        volumeRef: "fake://second",
        state: "creating",
      }),
    ).rejects.toThrow();
    await recordDestroyed(db, ref);
    const replacement = newId("ws");
    await db.insert(workspaces).values({
      id: replacement,
      orgId: ORG,
      projectId,
      storyId,
      provider: "fake",
      volumeRef: "fake://second",
      state: LIVE_WORKSPACE_STATES[0],
    });
    expect((await row(replacement)).state).toBe("creating");
  });

  it("records a failure with its detail and clears it once compute runs", async () => {
    const { ref } = await workspace();
    await recordFailed(db, ref, "provider quota exceeded");
    expect(await row(ref.workspaceId)).toMatchObject({
      state: "error",
      error: "provider quota exceeded",
    });

    const before = new Date(Date.now() - 1_000);
    const endpoints = [{ service: "web", port: 3000, url: "https://web.example.test" }];
    expect(
      await recordRunning(db, ref, {
        compute: { externalRef: "fake-ext-1", volumeRef: "fake://vol-1" },
        endpoints,
        setupChecksum: "sha256:setup",
      }),
    ).toBe(true);
    const running = await row(ref.workspaceId);
    expect(running).toMatchObject({
      state: "running",
      error: null,
      externalRef: "fake-ext-1",
      volumeRef: "fake://vol-1",
      endpoints,
      setupChecksum: "sha256:setup",
    });
    expect(running.lastActivityAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("leaves fields a running observation does not carry untouched", async () => {
    const { ref } = await workspace();
    await recordRunning(db, ref, { compute: { externalRef: "ext", volumeRef: "fake://kept" } });
    await recordRunning(db, ref);
    expect(await row(ref.workspaceId)).toMatchObject({
      externalRef: "ext",
      volumeRef: "fake://kept",
    });
  });

  it("walks suspension and deletion to a destroyed record with its destruction time", async () => {
    const { ref } = await workspace("running");
    await recordSleeping(db, ref);
    expect((await row(ref.workspaceId)).state).toBe("sleeping");
    await recordDeleting(db, ref);
    expect((await row(ref.workspaceId)).state).toBe("deleting");
    const destroyedAt = new Date("2026-01-02T03:04:05.000Z");
    await recordDestroyed(db, ref, destroyedAt);
    expect(await row(ref.workspaceId)).toMatchObject({ state: "destroyed", destroyedAt });
  });

  it("refuses to write a record from another org, project or story", async () => {
    const { ref } = await workspace("running");
    const other = await workspace("running");
    const foreignRefs = [
      { ...ref, orgId: "org_other" },
      { ...ref, projectId: other.projectId },
      { ...ref, storyId: other.storyId },
    ];
    for (const foreign of foreignRefs) {
      expect(await recordSleeping(db, foreign)).toBe(false);
      expect(await recordFailed(db, foreign, "cross-tenant")).toBe(false);
      expect(await recordDestroyed(db, foreign)).toBe(false);
    }
    expect(await row(ref.workspaceId)).toMatchObject({ state: "running", error: null });
  });

  it("treats only sleeping and destroyed records as suspended compute", () => {
    const suspended = WORKSPACE_RECORD_STATES.filter(isComputeSuspended);
    expect(suspended).toEqual(["sleeping", "destroyed"]);
  });
});
