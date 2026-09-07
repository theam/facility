import { randomUUID } from "node:crypto";
import { parseAgentManifest } from "@facility/agents";
import { newId } from "@facility/core";
import {
  createDb,
  migrate,
  orgs,
  projects,
  stories,
  storyMessages,
  turns,
  workspaces,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sandboxApi = vi.hoisted(() => ({ get: vi.fn(), getOrCreate: vi.fn() }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: sandboxApi }));

import { StoryWorkspaceService } from "../src/stories/service.js";
import { VercelWorkspaceRuntime } from "../src/workspaces/vercel.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";

async function canConnect() {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end();
  }
}

function sandboxFixture(name: string) {
  const sandbox = {
    name,
    status: "running",
    currentSnapshotId: "snap_original",
    currentSession: () => ({ sessionId: `session_${name}` }),
    files: new Map([[".facility/plan.md", "Keep this plan across failed starts"]]),
    failNextInitialization: true,
    failStop: false,
    runCommand: vi.fn(async () => {
      const exitCode = sandbox.failNextInitialization ? 1 : 0;
      sandbox.failNextInitialization = false;
      return { exitCode, stderr: async () => "Docker failed to initialize" };
    }),
    stop: vi.fn(async () => {
      if (sandbox.failStop) throw new Error("provider stop unavailable");
      sandbox.status = "stopped";
      sandbox.currentSnapshotId = "snap_preserved";
    }),
    delete: vi.fn(),
  };
  return sandbox;
}

describe("Vercel startup cleanup through the story service", async () => {
  if (!(await canConnect())) {
    it.skip("Postgres is unreachable at DATABASE_URL; Vercel lifecycle integration tests skipped", () =>
      undefined);
    return;
  }
  const { db, client } = createDb(databaseUrl);
  const orgId = newId("org");
  const projectId = newId("proj");
  const suffix = randomUUID().slice(0, 8);
  const sandboxes = new Map<string, ReturnType<typeof sandboxFixture>>();
  const runtime = new VercelWorkspaceRuntime();
  const dispatched = vi.fn().mockResolvedValue(undefined);
  const service = new StoryWorkspaceService(db, runtime, dispatched);
  const agent = parseAgentManifest(
    `---
name: builder
description: Builds the accepted plan.
engine: codex
model: gpt-5.5
enabled: true
triggers:
  - type: manual
---
Implement and verify the plan.
`,
    "builder.md",
  );

  beforeAll(async () => {
    await migrate(databaseUrl);
    await db
      .insert(orgs)
      .values({ id: orgId, name: "Startup cleanup", slug: `cleanup-${suffix}`, settings: {} });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Startup cleanup",
      slug: `cleanup-${suffix}`,
      settings: {},
    });
    sandboxApi.getOrCreate.mockImplementation(
      async ({
        name,
        onCreate,
        onResume,
      }: {
        name: string;
        onCreate?: () => Promise<void>;
        onResume?: () => Promise<void>;
      }) => {
        let sandbox = sandboxes.get(name);
        if (!sandbox) {
          sandbox = sandboxFixture(name);
          sandboxes.set(name, sandbox);
          await onCreate?.();
        } else if (sandbox.status === "stopped") {
          await onResume?.();
        }
        sandbox.status = "running";
        return sandbox;
      },
    );
    sandboxApi.get.mockImplementation(
      async ({
        name,
        resume,
        onResume,
      }: {
        name: string;
        resume: boolean;
        onResume?: () => Promise<void>;
      }) => {
        const sandbox = sandboxes.get(name);
        if (!sandbox) throw Object.assign(new Error("unknown sandbox"), { status: 404 });
        if (resume && sandbox.status === "stopped") {
          sandbox.status = "running";
          await onResume?.();
        }
        return sandbox;
      },
    );
  });
  afterAll(async () => {
    await client.end();
  });

  function input(externalId: string) {
    return {
      orgId,
      projectId,
      provider: "github" as const,
      externalId,
      title: "Accepted plan",
      agent,
      message: "Build the plan",
      messageDedupeKey: `build:${externalId}`,
      actor: { type: "user" as const, id: "user_maintainer" },
      workspace: { image: "facility-runner:test", ports: [] },
    };
  }

  async function failedBundle(externalId: string) {
    const story = (
      await db
        .select()
        .from(stories)
        .where(and(eq(stories.projectId, projectId), eq(stories.externalId, externalId)))
    )[0];
    if (!story) throw new Error("expected failed story");
    const bundle = await service.get(orgId, projectId, story.id);
    if (!bundle.workspace) throw new Error("expected retained workspace record");
    const sandbox = sandboxes.get(bundle.workspace.id);
    if (!sandbox) throw new Error("expected allocated sandbox");
    return { ...bundle, workspace: bundle.workspace, sandbox };
  }

  it("stops failed create and wake attempts, keeps one workspace and disk, and resumes successfully", async () => {
    const request = input(`issue:${randomUUID()}`);
    await expect(service.start(request)).rejects.toMatchObject({ code: "workspace_start_failed" });
    const failed = await failedBundle(request.externalId);
    expect(failed.workspace.state).toBe("error");
    expect(failed.sandbox.status).toBe("stopped");
    expect(await db.select().from(turns).where(eq(turns.storyId, failed.story.id))).toHaveLength(0);
    expect(
      await db.select().from(storyMessages).where(eq(storyMessages.storyId, failed.story.id)),
    ).toHaveLength(0);
    expect(dispatched).not.toHaveBeenCalled();

    const resumed = await service.start(request);
    expect(resumed.workspace).toMatchObject({
      id: failed.workspace.id,
      externalRef: failed.workspace.id,
      volumeRef: "snap_preserved",
      state: "running",
    });
    expect(failed.sandbox.files.get(".facility/plan.md")).toBe(
      "Keep this plan across failed starts",
    );
    expect(dispatched).toHaveBeenCalledOnce();

    await service.suspend(orgId, projectId, failed.story.id);
    failed.sandbox.failNextInitialization = true;
    await expect(service.start(request)).rejects.toMatchObject({ code: "workspace_start_failed" });
    expect(failed.sandbox.status).toBe("stopped");
    expect((await service.get(orgId, projectId, failed.story.id)).workspace?.state).toBe("error");
    await service.start(request);
    expect(failed.sandbox.status).toBe("running");
    expect(failed.sandbox.files.get(".facility/plan.md")).toBe(
      "Keep this plan across failed starts",
    );
    expect(
      await db.select().from(workspaces).where(eq(workspaces.storyId, failed.story.id)),
    ).toHaveLength(1);
    expect(await db.select().from(turns).where(eq(turns.storyId, failed.story.id))).toHaveLength(1);
    expect(failed.sandbox.delete).not.toHaveBeenCalled();
    const stopsBefore = failed.sandbox.stop.mock.calls.length;
    failed.sandbox.failNextInitialization = true;
    await expect(service.start(request)).rejects.toMatchObject({ code: "workspace_start_failed" });
    expect(failed.sandbox.status).toBe("running");
    expect(failed.sandbox.stop).toHaveBeenCalledTimes(stopsBefore);
    expect(await db.select().from(turns).where(eq(turns.storyId, failed.story.id))).toHaveLength(1);
  });

  it("records failed cleanup with an operator-recoverable identity and queues no work", async () => {
    sandboxApi.getOrCreate.mockImplementationOnce(
      async ({ name, onCreate }: { name: string; onCreate?: () => Promise<void> }) => {
        const sandbox = sandboxFixture(name);
        sandbox.failStop = true;
        sandboxes.set(name, sandbox);
        await onCreate?.();
        return sandbox;
      },
    );
    const request = input(`issue:${randomUUID()}`);
    await expect(service.start(request)).rejects.toMatchObject({
      code: "workspace_start_failed",
      cause: { code: "workspace_initialize_cleanup_failed" },
    });
    const failed = await failedBundle(request.externalId);
    expect(failed.workspace).toMatchObject({
      state: "error",
      error: expect.stringContaining(failed.workspace.id),
    });
    expect(failed.sandbox.status).toBe("running");
    expect(await db.select().from(turns).where(eq(turns.storyId, failed.story.id))).toHaveLength(0);
    // The persisted error identifies the sandbox even when create never returned a handle.
    failed.sandbox.failStop = false;
    await runtime.suspend({
      id: failed.workspace.id,
      externalRef: failed.workspace.id,
      volumeRef: failed.workspace.volumeRef,
      image: request.workspace.image,
    });
    expect(failed.sandbox.status).toBe("stopped");
    expect(failed.sandbox.delete).not.toHaveBeenCalled();
  });
});
