import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentManifest } from "@facility/agents";
import { newId } from "@facility/core";
import {
  attentionItems,
  createDb,
  migrate,
  orgs,
  projects,
  stories,
  storyMessages,
  turns,
  workspaces,
} from "@facility/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StoryServiceError, StoryWorkspaceService } from "../src/stories/service.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";

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

const builder = parseAgentManifest(
  `---
name: builder
description: Implements a story in its persistent workspace.
engine: codex
model: gpt-5.5
enabled: true
options:
  reasoning_effort: high
triggers:
  - type: manual
---
Work through the requested story, verify it, and report the result.
`,
  "builder.md",
);

describe("persistent story workspace lifecycle", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; story workspace tests skipped", () =>
      undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const root = await mkdtemp(join(tmpdir(), "facility-story-workspaces-"));
  const runtime = new FakeWorkspaceRuntime(root);
  const dispatched: string[] = [];
  const service = new StoryWorkspaceService(db, runtime, async (turn) => {
    dispatched.push(turn.id);
  });
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org");
  const projectId = newId("proj");
  const otherOrgId = newId("org");
  const otherProjectId = newId("proj");

  beforeAll(async () => {
    await migrate(databaseUrl);
    await db.insert(orgs).values([
      { id: orgId, name: "Story lifecycle", slug: `story-lifecycle-${suffix}`, settings: {} },
      { id: otherOrgId, name: "Other tenant", slug: `other-tenant-${suffix}`, settings: {} },
    ]);
    await db.insert(projects).values([
      {
        id: projectId,
        orgId,
        name: "Story lifecycle",
        slug: `story-lifecycle-${suffix}`,
        settings: {},
      },
      {
        id: otherProjectId,
        orgId: otherOrgId,
        name: "Other project",
        slug: `other-project-${suffix}`,
        settings: {},
      },
    ]);
  });

  afterAll(async () => {
    await client.end();
    await rm(root, { recursive: true, force: true });
  });

  function startInput(externalId: string, dedupeKey = `${externalId}:start`) {
    return {
      orgId,
      projectId,
      provider: "github" as const,
      externalId,
      title: `Story ${externalId}`,
      agent: builder,
      message: "Implement this story",
      messageDedupeKey: dedupeKey,
      actor: { type: "user" as const, id: "user_test" },
      workspace: {
        image: "facility-runner:test",
        ports: [{ service: "web", port: 3000 }],
      },
    };
  }

  it("starts idempotently and serializes messages behind the active turn", async () => {
    const externalId = `issue-${randomUUID()}`;
    const first = await service.start(startInput(externalId));
    const second = await service.start(startInput(externalId));

    expect(second.story.id).toBe(first.story.id);
    expect(second.workspace?.id).toBe(first.workspace?.id);
    expect(second.queued.message.id).toBe(first.queued.message.id);
    expect(dispatched.filter((id) => id === first.queued.turn?.id)).toHaveLength(1);

    const queued = await service.queueMessage({
      orgId,
      projectId,
      storyId: first.story.id,
      body: "Also update the documentation",
      dedupeKey: `${externalId}:follow-up`,
      agent: builder,
      actor: { type: "user", id: "user_test" },
      trigger: { type: "manual" },
    });
    expect(queued.queued).toBe(true);
    expect(queued.turn).toBeUndefined();
    expect(await db.select().from(turns).where(eq(turns.storyId, first.story.id))).toHaveLength(1);
    expect(await service.conversation(orgId, projectId, first.story.id)).toHaveLength(2);
  });

  it("keeps the worktree and native session state across archive, compute replacement, restore, and merge", async () => {
    const result = await service.start(startInput(`issue-${randomUUID()}`));
    const workspace = result.workspace;
    if (!workspace?.externalRef) throw new Error("workspace fixture missing");
    const locator = {
      id: workspace.id,
      image: "facility-runner:test",
      ports: [{ service: "web", port: 3000 }],
      externalRef: workspace.externalRef,
      volumeRef: workspace.volumeRef,
    };
    await runtime.exec(locator, {
      command: "sh",
      args: [
        "-lc",
        "mkdir -p repos/app .facility/claude .facility/codex && printf commit-a > repos/app/HEAD && printf claude-session > .facility/claude/session && printf codex-session > .facility/codex/session",
      ],
    });

    await service.archive(orgId, projectId, result.story.id);
    await runtime.replaceCompute(locator);
    const restored = await service.restore(orgId, projectId, result.story.id);
    expect(restored.story.status).toBe("working");
    expect(await runtime.read(locator, "repos/app/HEAD")).toBe("commit-a");
    expect(await runtime.read(locator, ".facility/claude/session")).toBe("claude-session");
    expect(await runtime.read(locator, ".facility/codex/session")).toBe("codex-session");

    const merged = await service.markMerged({
      orgId,
      projectId,
      storyId: result.story.id,
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.example/pulls/42",
      branch: "facility/story-42",
    });
    expect(merged.story.status).toBe("done");
    expect(merged.workspace?.state).toBe("sleeping");
    expect(await runtime.read(locator, "repos/app/HEAD")).toBe("commit-a");
  });

  it("does not let a late turn result override archive or merge", async () => {
    const archived = await service.start(startInput(`issue-${randomUUID()}`));
    const archivedTurnId = archived.queued.turn?.id;
    if (!archivedTurnId) throw new Error("expected an archived story turn");
    await service.archive(orgId, projectId, archived.story.id);
    await service.failTurn({
      orgId,
      projectId,
      turnId: archivedTurnId,
      error: "compute stopped after archive",
    });
    await expect(service.get(orgId, projectId, archived.story.id)).resolves.toMatchObject({
      story: { status: "archived" },
    });

    const merged = await service.start(startInput(`issue-${randomUUID()}`));
    const mergedTurnId = merged.queued.turn?.id;
    if (!mergedTurnId) throw new Error("expected a merged story turn");
    await service.markMerged({
      orgId,
      projectId,
      storyId: merged.story.id,
      pullRequestNumber: 84,
      pullRequestUrl: "https://github.example/pulls/84",
      branch: "facility/story-84",
    });
    await service.completeTurn({
      orgId,
      projectId,
      turnId: mergedTurnId,
      output: "finished while the merge event was being handled",
      actor: { type: "system", id: "codex:test" },
    });
    await expect(service.get(orgId, projectId, merged.story.id)).resolves.toMatchObject({
      story: { status: "done" },
    });
  });

  it("fails closed across tenants and the database rejects a cross-tenant workspace", async () => {
    const result = await service.start(startInput(`issue-${randomUUID()}`));
    await expect(service.get(otherOrgId, otherProjectId, result.story.id)).rejects.toMatchObject({
      code: "story_not_found",
      statusCode: 404,
    });
    await expect(
      db.insert(workspaces).values({
        id: newId("ws"),
        orgId: otherOrgId,
        projectId: otherProjectId,
        storyId: result.story.id,
        provider: "fake",
        volumeRef: "/cross-tenant",
        state: "destroyed",
        destroyedAt: new Date(),
      }),
    ).rejects.toMatchObject({
      cause: { code: "23503", constraint_name: "workspaces_story_scope_fk" },
    });
  });

  it("requires explicit confirmation and only deletion destroys durable state", async () => {
    const result = await service.start(startInput(`issue-${randomUUID()}`));
    const workspace = result.workspace;
    if (!workspace?.externalRef) throw new Error("workspace fixture missing");
    const locator = {
      id: workspace.id,
      image: "facility-runner:test",
      externalRef: workspace.externalRef,
      volumeRef: workspace.volumeRef,
    };
    await runtime.exec(locator, { command: "sh", args: ["-lc", "printf durable > marker"] });

    await expect(
      service.deleteWorkspace({
        orgId,
        projectId,
        storyId: result.story.id,
        actor: { type: "user", id: "user_test" },
        confirm: false,
      }),
    ).rejects.toBeInstanceOf(StoryServiceError);
    expect(await runtime.read(locator, "marker")).toBe("durable");

    const deleted = await service.deleteWorkspace({
      orgId,
      projectId,
      storyId: result.story.id,
      actor: { type: "user", id: "user_test" },
      confirm: true,
    });
    expect(deleted.story.deletedAt).toBeInstanceOf(Date);
    expect(deleted.workspace?.state).toBe("destroyed");
    expect((await runtime.inspect(locator)).state).toBe("destroyed");
    expect(
      await db.select().from(storyMessages).where(eq(storyMessages.storyId, result.story.id)),
    ).toHaveLength(1);

    await expect(
      service.deleteWorkspace({
        orgId,
        projectId,
        storyId: result.story.id,
        actor: { type: "user", id: "user_test" },
        confirm: true,
      }),
    ).resolves.toMatchObject({ story: { id: result.story.id } });
  });

  it("records runtime failures as visible attention instead of losing the story", async () => {
    class FailingRuntime extends FakeWorkspaceRuntime {
      override async create(): Promise<never> {
        throw new Error("provider unavailable");
      }
    }
    const failing = new StoryWorkspaceService(db, new FailingRuntime(join(root, "failing")));
    const externalId = `issue-${randomUUID()}`;
    await expect(failing.start(startInput(externalId))).rejects.toMatchObject({
      code: "workspace_start_failed",
      statusCode: 503,
    });
    const story = (
      await db.select().from(stories).where(eq(stories.externalId, externalId)).limit(1)
    )[0];
    expect(story?.status).toBe("attention");
    if (!story) throw new Error("expected failed story");
    expect(
      await db.select().from(attentionItems).where(eq(attentionItems.storyId, story.id)),
    ).toHaveLength(1);
  });
});
