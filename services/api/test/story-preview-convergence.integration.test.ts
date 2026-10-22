import { randomUUID } from "node:crypto";
import { newId, StoryPreviewConvergenceSchema } from "@facility/core";
import {
  createDb,
  githubPullRequests,
  migrate,
  projectRepositories,
  projects,
  seed,
  stories,
  storyConversations,
  storyDeliveryPullRequests,
  storyDeliveryScopes,
  storyPreviewAttempts,
  storyPreviewGenerations,
  turns,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { StoryPreviewConvergenceService } from "../src/stories/preview-convergence.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";

describe("durable story preview convergence", () => {
  const { db, client } = createDb(databaseUrl);

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: false });
  });

  afterAll(async () => client.end());

  async function fixture(observedAt = new Date()) {
    const suffix = randomUUID().slice(0, 8);
    const projectId = newId("proj");
    const repositoryId = newId("repo");
    const storyId = newId("story");
    await db.insert(projects).values({
      id: projectId,
      orgId: "org_local",
      name: `Preview ${suffix}`,
      slug: `preview-${suffix}`,
    });
    await db.insert(projectRepositories).values({
      id: repositoryId,
      orgId: "org_local",
      projectId,
      owner: `example-${suffix}`,
      name: "app",
      defaultBranch: "main",
      role: "primary",
    });
    await db.insert(githubPullRequests).values({
      id: newId("ghp"),
      orgId: "org_local",
      projectId,
      repositoryId,
      number: 7,
      title: "Complete preview",
      state: "open",
      headRef: "feature/preview",
      baseRef: "main",
      headSha: "a".repeat(40),
      htmlUrl: `https://github.com/example-${suffix}/app/pull/7`,
      syncedAt: observedAt,
    });
    await db.insert(stories).values({
      id: storyId,
      orgId: "org_local",
      projectId,
      provider: "manual",
      externalId: storyId,
      title: "Complete preview",
      createdBy: { type: "user", id: "user_local_admin" },
    });
    await db.insert(storyDeliveryScopes).values({
      orgId: "org_local",
      projectId,
      storyId,
      revision: 1,
      declaredComplete: true,
      updatedBy: { type: "user", id: "user_local_admin" },
    });
    await db.insert(storyDeliveryPullRequests).values({
      orgId: "org_local",
      projectId,
      storyId,
      repositoryId,
      pullNumber: 7,
      required: true,
      isPrimary: true,
    });
    return {
      scope: { orgId: "org_local", projectId, storyId },
      repositoryId,
      conversationId: newId("msg"),
    };
  }

  it("coalesces changed heads and fences an older worker from publishing", async () => {
    const base = new Date();
    const { scope, repositoryId } = await fixture(new Date(base.getTime() - 60_000));
    const enqueue = vi.fn(async () => undefined);
    const service = new StoryPreviewConvergenceService(db, enqueue);

    const first = await service.observe(scope, base);
    expect(first).toMatchObject({ recorded: true, changed: true, enqueue: true });
    if (!first.recorded) throw new Error("Expected recorded preview generation");
    expect(first.generation).toMatch(/^[a-f0-9]{64}$/);
    const firstClaim = await service.claim(scope, base);
    expect(firstClaim).toMatchObject({ claimed: true, attempt: 1 });
    if (!firstClaim.claimed) throw new Error("Expected first preview claim");

    const newer = new Date(base.getTime() + 60_000);
    await db
      .update(githubPullRequests)
      .set({ headSha: "b".repeat(40), syncedAt: newer })
      .where(
        and(eq(githubPullRequests.repositoryId, repositoryId), eq(githubPullRequests.number, 7)),
      );
    const changed = await service.observe(scope, newer);
    expect(changed).toMatchObject({ recorded: true, changed: true, enqueue: false });
    if (!changed.recorded) throw new Error("Expected changed preview generation");
    expect(changed.generation).not.toBe(first.generation);
    const whileApplying = StoryPreviewConvergenceSchema.parse(await service.read(scope));
    expect(whileApplying.state).toBe("applying");
    expect(whileApplying.desired.generation).toBe(changed.generation);

    await expect(
      service.complete(scope, {
        generation: firstClaim.generation,
        leaseToken: firstClaim.leaseToken,
        workspaceId: "ws_old",
      }),
    ).resolves.toMatchObject({ settled: true, superseded: true, enqueue: true });
    const secondClaim = await service.claim(scope, new Date(newer.getTime() + 1));
    expect(secondClaim).toMatchObject({ claimed: true, attempt: 2 });
    if (!secondClaim.claimed) throw new Error("Expected second preview claim");
    await expect(
      service.complete(scope, {
        generation: secondClaim.generation,
        leaseToken: secondClaim.leaseToken,
        workspaceId: "ws_current",
      }),
    ).resolves.toMatchObject({ settled: true, superseded: false });
    const ready = StoryPreviewConvergenceSchema.parse(await service.read(scope));
    expect(ready).toMatchObject({
      state: "ready",
      deployedGeneration: secondClaim.generation,
      lastGoodGeneration: secondClaim.generation,
      attempt: { state: "succeeded", workspaceId: "ws_current" },
    });

    // A late observation of the older head records history but cannot roll back desired state.
    await db
      .update(githubPullRequests)
      .set({ headSha: "a".repeat(40), syncedAt: new Date(base.getTime() - 30_000) })
      .where(
        and(eq(githubPullRequests.repositoryId, repositoryId), eq(githubPullRequests.number, 7)),
      );
    await expect(service.observe(scope, base)).resolves.toMatchObject({
      recorded: true,
      changed: false,
      enqueue: false,
    });
    expect((await service.read(scope))?.desired.generation).toBe(secondClaim.generation);
    expect(
      await db
        .select()
        .from(storyPreviewGenerations)
        .where(eq(storyPreviewGenerations.storyId, scope.storyId)),
    ).toHaveLength(2);
  });

  it("waits for the active story writer and recovers the latest desired generation", async () => {
    const now = new Date();
    const { scope } = await fixture(now);
    const enqueue = vi.fn(async () => undefined);
    const service = new StoryPreviewConvergenceService(db, enqueue);
    await service.observe(scope, now);
    const conversationId = newId("msg");
    const turnId = newId("turn");
    await db.insert(storyConversations).values({ id: conversationId, ...scope });
    await db.insert(turns).values({
      id: turnId,
      ...scope,
      conversationId,
      agentName: "builder",
      manifestHash: "writer",
      manifest: {},
      engine: "codex",
      model: "test",
      state: "running",
      triggerType: "message",
      createdBy: { type: "user", id: "user_local_admin" },
    });

    const waiting = await service.claim(scope, now);
    expect(waiting).toMatchObject({ claimed: false, reason: "writer_active" });
    expect((await service.read(scope))?.state).toBe("waiting");
    await db
      .update(turns)
      .set({ state: "succeeded", endedAt: new Date(now.getTime() + 1) })
      .where(eq(turns.id, turnId));
    expect(await service.recover(new Date(now.getTime() + 20_000))).toBeGreaterThanOrEqual(1);
    const claimed = await service.claim(scope, new Date(now.getTime() + 20_001));
    expect(claimed).toMatchObject({ claimed: true });
  });

  it("expires abandoned leases, rejects their late settlement, and exposes bounded failures", async () => {
    const now = new Date();
    const { scope } = await fixture(now);
    const enqueue = vi.fn(async () => undefined);
    const service = new StoryPreviewConvergenceService(db, enqueue, 1_000);
    await service.observe(scope, now);
    const abandoned = await service.claim(scope, now);
    if (!abandoned.claimed) throw new Error("Expected abandoned claim");
    const replacement = await service.claim(scope, new Date(now.getTime() + 1_001));
    expect(replacement).toMatchObject({ claimed: true, attempt: 2 });
    if (!replacement.claimed) throw new Error("Expected replacement claim");
    await expect(
      service.complete(scope, {
        generation: abandoned.generation,
        leaseToken: abandoned.leaseToken,
      }),
    ).resolves.toEqual({ settled: false, enqueue: false });
    const retryAt = new Date(now.getTime() + 60_000);
    await expect(
      service.fail(scope, {
        generation: replacement.generation,
        leaseToken: replacement.leaseToken,
        outcome: "blocked",
        code: "preview_dirty_overlap",
        message: "A local edit overlaps a required preview commit.",
        retryAt,
        details: { paths: ["src/example.ts"] },
      }),
    ).resolves.toMatchObject({ settled: true, superseded: false });
    expect(await service.read(scope)).toMatchObject({
      state: "blocked",
      deployedGeneration: null,
      lastGoodGeneration: null,
      error: { code: "preview_dirty_overlap", retryAt: retryAt.toISOString() },
      attempt: {
        number: 2,
        state: "blocked",
        cause: { code: "preview_dirty_overlap", paths: ["src/example.ts"] },
      },
    });
    expect(
      await db
        .select()
        .from(storyPreviewAttempts)
        .where(eq(storyPreviewAttempts.storyId, scope.storyId)),
    ).toHaveLength(2);
    await expect(service.retry(scope, new Date(now.getTime() + 2_000))).resolves.toBe(true);
    expect((await service.read(scope))?.state).toBe("pending");
  });
});
