import { randomUUID } from "node:crypto";
import { parseAgentManifest } from "@facility/agents";
import { newId, StoryPreviewConvergenceSchema } from "@facility/core";
import {
  createDb,
  githubPullRequests,
  migrate,
  orgMembers,
  projectRepositories,
  projects,
  reconciliationCursors,
  roles,
  seed,
  stories,
  storyConversations,
  storyDeliveryPullRequests,
  storyDeliveryScopes,
  storyPreviewAttempts,
  storyPreviewConvergences,
  storyPreviewGenerations,
  turns,
  users,
  workspaces,
} from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GithubMirrorService } from "../src/github/mirror.js";
import { StoryPreviewConvergenceService } from "../src/stories/preview-convergence.js";
import { StoryWorkspaceService } from "../src/stories/service.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
const builder = parseAgentManifest(
  `---
name: builder
description: Builds a queued story after preview convergence releases the writer.
engine: codex
model: gpt-5.5
enabled: true
triggers:
  - type: manual
---
Build the story.
`,
  "builder.md",
);

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
      githubUpdatedAt: observedAt,
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
      executionAuthorization: { revision: 1, actor: { type: "user", id: "user_local_admin" } },
      updatedBy: { type: "user" as const, id: "user_local_admin" },
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
      owner: `example-${suffix}`,
    };
  }

  it("coalesces changed heads and fences an older worker from publishing", async () => {
    const base = new Date();
    const { scope, repositoryId } = await fixture(new Date(base.getTime() - 60_000));
    const workspaceId = newId("ws");
    const lastGoodEndpoints = [
      { service: "web", port: 3000, url: "https://last-good.example.test" },
    ];
    await db.insert(workspaces).values({
      id: workspaceId,
      ...scope,
      provider: "fake",
      volumeRef: `fake://${workspaceId}`,
      state: "running",
      setupChecksum: "last-good",
      endpoints: lastGoodEndpoints,
    });
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
        workspaceId,
        setupChecksum: "stale-candidate",
        endpoints: [{ service: "web", port: 3000, url: "https://stale.example.test" }],
      }),
    ).resolves.toMatchObject({ settled: true, superseded: true, enqueue: true });
    expect(
      (
        await db
          .select({ setupChecksum: workspaces.setupChecksum, endpoints: workspaces.endpoints })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1)
      )[0],
    ).toMatchObject({ setupChecksum: "last-good", endpoints: lastGoodEndpoints });
    const secondClaim = await service.claim(scope, new Date(newer.getTime() + 1));
    expect(secondClaim).toMatchObject({ claimed: true, attempt: 2 });
    if (!secondClaim.claimed) throw new Error("Expected second preview claim");
    await expect(
      service.complete(scope, {
        generation: secondClaim.generation,
        leaseToken: secondClaim.leaseToken,
        workspaceId,
        setupChecksum: "current-candidate",
        endpoints: [{ service: "web", port: 3000, url: "https://current.example.test" }],
      }),
    ).resolves.toMatchObject({ settled: true, superseded: false });
    const ready = StoryPreviewConvergenceSchema.parse(await service.read(scope));
    expect(ready).toMatchObject({
      state: "ready",
      deployedGeneration: secondClaim.generation,
      lastGoodGeneration: secondClaim.generation,
      attempt: { state: "succeeded", workspaceId },
    });
    expect(
      (
        await db
          .select({ state: workspaces.state, setupChecksum: workspaces.setupChecksum })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1)
      )[0],
    ).toEqual({ state: "running", setupChecksum: "current-candidate" });

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

  it("queues a new story message until the preview writer releases the workspace", async () => {
    const now = new Date();
    const { scope } = await fixture(now);
    const preview = new StoryPreviewConvergenceService(db, async () => undefined);
    await preview.observe(scope, now);
    const claim = await preview.claim(scope, now);
    if (!claim.claimed) throw new Error("Expected preview writer claim");
    await db
      .update(storyPreviewConvergences)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(storyPreviewConvergences.storyId, scope.storyId));
    const conversationId = newId("sess");
    await db.insert(storyConversations).values({ id: conversationId, ...scope });
    const dispatch = vi.fn(async () => undefined);
    const storiesService = new StoryWorkspaceService(db, new FakeWorkspaceRuntime(), dispatch);
    const queued = await storiesService.queueMessage({
      ...scope,
      body: "Continue after the preview update.",
      dedupeKey: randomUUID(),
      agent: builder,
      actor: { type: "user", id: "user_local_admin" },
      trigger: { type: "manual" },
    });
    expect(queued).toMatchObject({ queued: true, turn: undefined });
    expect(dispatch).not.toHaveBeenCalled();
    const reclaimed = await preview.claim(scope);
    if (!reclaimed.claimed) throw Error("Expected recovery claim");
    expect(reclaimed.requiresComputeFence).toBe(true);
    expect(
      await storiesService.activateNextMessage({
        ...scope,
        agent: builder,
        actor: { type: "user", id: "user_local_admin" },
      }),
    ).toBeUndefined();
    await preview.acknowledgeStopped(scope, reclaimed);
    const activated = await storiesService.activateNextMessage({
      ...scope,
      agent: builder,
      actor: { type: "user", id: "user_local_admin" },
    });
    expect(activated).toMatchObject({ state: "queued", agentName: "builder" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("observes accepted mirror heads and ignores a reordered older GitHub payload", async () => {
    const initial = new Date("2026-10-22T10:00:00.000Z");
    const { scope, repositoryId, owner } = await fixture(initial);
    const convergence = new StoryPreviewConvergenceService(db, async () => undefined);
    await convergence.observe(scope, initial);
    const mirror = new GithubMirrorService(
      db,
      async () => {
        throw new Error("Full mirror synchronization is not used in this test");
      },
      undefined,
      (id, number) => convergence.observePull(id, number),
    );
    const payload = (headSha: string, updatedAt: string) => ({
      repository: { full_name: `${owner}/app`, name: "app", owner: { login: owner } },
      pull_request: {
        number: 7,
        title: "Complete preview",
        body: "",
        state: "open",
        draft: false,
        html_url: `https://github.com/${owner}/app/pull/7`,
        user: { login: "maintainer" },
        head: { ref: "feature/preview", sha: headSha },
        base: { ref: "main" },
        created_at: initial.toISOString(),
        updated_at: updatedAt,
      },
    });
    const accepted = await mirror.handleWebhook({
      id: "newer",
      orgId: scope.orgId,
      eventType: "pull_request",
      payload: payload("b".repeat(40), "2026-10-22T11:00:00.000Z"),
    });
    expect(accepted.mirrored).toBe(1);
    expect((await convergence.read(scope))?.desired.repositories[0]?.headSha).toBe("b".repeat(40));
    const reordered = await mirror.handleWebhook({
      id: "older",
      orgId: scope.orgId,
      eventType: "pull_request",
      payload: payload("c".repeat(40), "2026-10-22T10:30:00.000Z"),
    });
    expect(reordered.mirrored).toBe(0);
    expect((await convergence.read(scope))?.desired.repositories[0]?.headSha).toBe("b".repeat(40));
    expect(
      (
        await db
          .select({ headSha: githubPullRequests.headSha })
          .from(githubPullRequests)
          .where(eq(githubPullRequests.repositoryId, repositoryId))
          .limit(1)
      )[0]?.headSha,
    ).toBe("b".repeat(40));
  });

  it("expires abandoned leases, rejects their late settlement, and exposes bounded failures", async () => {
    const now = new Date();
    const { scope } = await fixture(now);
    const enqueue = vi.fn(async () => undefined);
    const service = new StoryPreviewConvergenceService(db, enqueue, 1_000);
    await service.observe(scope, now);
    const abandoned = await service.claim(scope, now);
    if (!abandoned.claimed) throw new Error("Expected abandoned claim");
    await expect(
      service.renew(
        scope,
        { generation: abandoned.generation, leaseToken: abandoned.leaseToken },
        new Date(now.getTime() + 500),
      ),
    ).resolves.toEqual(new Date(now.getTime() + 1_500));
    await expect(service.claim(scope, new Date(now.getTime() + 1_001))).resolves.toMatchObject({
      claimed: false,
      reason: "leased",
    });
    const replacement = await service.claim(scope, new Date(now.getTime() + 1_501));
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
    await expect(service.claim(scope, new Date(now.getTime() + 1_500))).resolves.toEqual({
      claimed: false,
      reason: "blocked",
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

  it("fences an active preview when workspace suspension wins and resumes the latest generation", async () => {
    const now = new Date();
    const { scope } = await fixture(now);
    const enqueue = vi.fn(async () => undefined);
    const fence = vi.fn(async () => undefined);
    const service = new StoryPreviewConvergenceService(db, enqueue, undefined, fence);
    await service.observe(scope, now);
    const claim = await service.claim(scope, now);
    if (!claim.claimed) throw new Error("Expected preview claim");
    await expect(service.suspend(scope, undefined, new Date(now.getTime() + 1))).resolves.toBe(
      true,
    );
    expect(fence).toHaveBeenCalledExactlyOnceWith(scope);
    expect(await service.read(scope)).toMatchObject({
      state: "suspended",
      attempt: { state: "blocked", cause: { code: "preview_suspended" } },
    });
    await expect(
      service.complete(scope, {
        generation: claim.generation,
        leaseToken: claim.leaseToken,
      }),
    ).resolves.toEqual({ settled: false, enqueue: false });
    await expect(service.resume(scope, new Date(now.getTime() + 2))).resolves.toBe(true);
    expect((await service.read(scope))?.state).toBe("pending");
    expect(enqueue).toHaveBeenLastCalledWith("stories.preview-convergence", scope);
  });

  it("retains the writer while suspension fencing is pending or unconfirmed", async () => {
    const { scope } = await fixture();
    let entered!: () => void;
    const fencing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let rejectFence!: (cause: Error) => void;
    const pendingFence = new Promise<void>((_resolve, reject) => {
      rejectFence = reject;
    });
    const fence = vi.fn(async () => {
      entered();
      await pendingFence;
    });
    const service = new StoryPreviewConvergenceService(db, async () => undefined, undefined, fence);
    await service.observe(scope);
    const claim = await service.claim(scope);
    if (!claim.claimed) throw new Error("Expected preview claim");
    const suspension = service.suspend(scope);
    const rejected = expect(suspension).rejects.toMatchObject({
      code: "preview_compute_stop_unconfirmed",
    });
    try {
      await fencing;
      expect((await service.read(scope))?.state).toBe("applying");
      const storiesService = new StoryWorkspaceService(db, new FakeWorkspaceRuntime());
      await db.insert(storyConversations).values({ ...scope, id: newId("sess") });
      const queued = await storiesService.queueMessage({
        ...scope,
        agent: builder,
        body: "Continue after suspension",
        dedupeKey: randomUUID(),
        actor: { type: "user", id: "user_local_admin" },
        trigger: { type: "manual" },
      });
      expect(queued.turn).toBeUndefined();
    } finally {
      rejectFence(new Error("Provider unavailable"));
      await rejected;
    }
    expect((await service.read(scope))?.state).toBe("applying");
    expect(await service.resume(scope)).toBe(false);
    expect(await service.retry(scope)).toBe(false);
    expect(await service.renew(scope, claim)).not.toBeNull();
    fence.mockImplementation(async () => undefined);
    expect(await service.suspend(scope)).toBe(true);
    expect((await service.read(scope))?.state).toBe("suspended");
  });

  it("refuses to release an active writer without a configured provider fence", async () => {
    const { scope } = await fixture();
    const service = new StoryPreviewConvergenceService(db, async () => undefined);
    await service.observe(scope);
    expect((await service.claim(scope)).claimed).toBe(true);
    await expect(service.suspend(scope)).rejects.toMatchObject({
      code: "preview_compute_stop_unconfirmed",
    });
    expect((await service.read(scope))?.state).toBe("applying");
  });

  it("never binds a revoked or expired worker to restored compute", async () => {
    const now = new Date();
    const { scope } = await fixture(now);
    const service = new StoryPreviewConvergenceService(
      db,
      async () => undefined,
      1000,
      async () => undefined,
    );
    await service.observe(scope, now);
    const old = await service.claim(scope, now);
    if (!old.claimed) throw new Error("Expected preview claim");
    const wake = vi.fn(async () => "compute");
    expect(await service.bindCompute(scope, old, wake, new Date(now.getTime() + 1001))).toBeNull();
    await service.suspend(scope);
    await service.resume(scope);
    const current = await service.claim(scope);
    if (!current.claimed) throw new Error("Expected restored preview claim");
    expect(await service.bindCompute(scope, old, wake)).toBeNull();
    expect(wake).not.toHaveBeenCalled();
    expect(await service.bindCompute(scope, current, wake)).toBe("compute");
    expect(wake).toHaveBeenCalledOnce();
  });

  it("rejects expired success and failure even before another worker reclaims", async () => {
    const now = new Date();
    const { scope } = await fixture(now);
    const service = new StoryPreviewConvergenceService(db, async () => undefined, 1000);
    await service.observe(scope, now);
    const claim = await service.claim(scope, now);
    if (!claim.claimed) throw Error("Missing claim");
    const late = new Date(now.getTime() + 1001);
    expect(await service.complete(scope, claim, late)).toEqual({ settled: false, enqueue: false });
    expect(
      await service.fail(
        scope,
        { ...claim, outcome: "failed", code: "late", message: "late" },
        late,
      ),
    ).toEqual({ settled: false, enqueue: false });
    expect((await service.read(scope))?.deployedGeneration).toBeNull();
  });

  it("advances the same-generation watermark and rejects delayed intermediate heads", async () => {
    const now = new Date(Date.now() + 1000);
    const { scope, repositoryId } = await fixture(now);
    const service = new StoryPreviewConvergenceService(db, async () => undefined);
    const first = await service.observe(scope, now);
    await db
      .update(githubPullRequests)
      .set({ syncedAt: new Date(now.getTime() + 3000) })
      .where(eq(githubPullRequests.repositoryId, repositoryId));
    await service.observe(scope, new Date(now.getTime() + 3000));
    await db
      .update(githubPullRequests)
      .set({ headSha: "b".repeat(40), syncedAt: new Date(now.getTime() + 2000) })
      .where(eq(githubPullRequests.repositoryId, repositoryId));
    expect(await service.observe(scope)).toMatchObject({ recorded: true, changed: false });
    expect((await service.read(scope))?.desired.generation).toBe(
      first.recorded ? first.generation : null,
    );
  });

  it("withdraws execution without deleting history or releasing an active writer prematurely", async () => {
    const now = new Date();
    const { scope } = await fixture(now);
    const service = new StoryPreviewConvergenceService(db, async () => undefined);
    await service.observe(scope, now);
    const claim = await service.claim(scope, now);
    if (!claim.claimed) throw Error("Missing claim");
    await db
      .update(storyDeliveryScopes)
      .set({ declaredComplete: false, updatedAt: new Date(now.getTime() + 1) })
      .where(eq(storyDeliveryScopes.storyId, scope.storyId));
    expect(await service.observe(scope)).toMatchObject({ recorded: false });
    expect((await service.read(scope))?.state).toBe("applying");
    expect(await service.claim(scope, now)).toMatchObject({ claimed: false, reason: "leased" });
    expect(await service.complete(scope, claim)).toMatchObject({
      settled: true,
      superseded: true,
      enqueue: false,
    });
    expect((await service.read(scope))?.state).toBe("blocked");
    await service.retry(scope);
    expect(await service.claim(scope)).toMatchObject({ claimed: false, reason: "unconfigured" });
    expect(
      await db
        .select()
        .from(storyPreviewGenerations)
        .where(eq(storyPreviewGenerations.storyId, scope.storyId)),
    ).toHaveLength(1);
  });

  it("advances durable observation pages past a thousand unchanged scopes", async () => {
    const { scope } = await fixture();
    const prefix = `zz_reconcile_${randomUUID()}_`;
    const ids = Array.from({ length: 1001 }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);
    await db.insert(stories).values(
      ids.map((id) => ({
        id,
        orgId: scope.orgId,
        projectId: scope.projectId,
        provider: "manual",
        externalId: id,
        title: "Unchanged scope",
        createdBy: { type: "user", id: "user_local_admin" },
      })),
    );
    await db.insert(storyDeliveryScopes).values(
      ids.map((storyId) => ({
        orgId: scope.orgId,
        projectId: scope.projectId,
        storyId,
        revision: 1,
        declaredComplete: false,
        updatedBy: { type: "user" as const, id: "user_local_admin" },
      })),
    );
    await db
      .insert(reconciliationCursors)
      .values({ name: "preview-observations", lastId: prefix })
      .onConflictDoUpdate({ target: reconciliationCursors.name, set: { lastId: prefix } });
    const service = new StoryPreviewConvergenceService(db, async () => undefined);
    const observe = vi
      .spyOn(service, "observe")
      .mockResolvedValue({ recorded: false, reason: "incomplete" } as never);
    await service.reconcileObserved();
    expect(observe).toHaveBeenCalledTimes(1000);
    expect(observe.mock.calls.some(([s]) => s.storyId === ids[1000])).toBe(false);
    await service.reconcileObserved();
    expect(observe.mock.calls.some(([s]) => s.storyId === ids[1000])).toBe(true);
  });
  it("requires execution delegation for the current scope and rechecks revoked authorizers", async () => {
    const { scope } = await fixture();
    await db
      .update(storyDeliveryScopes)
      .set({ executionAuthorization: null })
      .where(eq(storyDeliveryScopes.storyId, scope.storyId));
    const enqueue = vi.fn(async () => undefined);
    const service = new StoryPreviewConvergenceService(db, enqueue);
    await service.observe(scope);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await service.claim(scope)).toMatchObject({ claimed: false, reason: "blocked" });
    const roleId = newId("role"),
      userId = newId("user");
    await db
      .insert(roles)
      .values({ id: roleId, orgId: scope.orgId, name: roleId, permissions: ["projects:write"] });
    await db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, status: "active" });
    await db.insert(orgMembers).values({ id: newId("member"), orgId: scope.orgId, userId, roleId });
    const actor = { type: "user" as const, id: userId };
    await expect(service.authorize(scope, actor, 1)).rejects.toMatchObject({ statusCode: 403 });
    await db
      .update(roles)
      .set({ permissions: ["workspaces:execute"] })
      .where(eq(roles.id, roleId));
    await service.authorize(scope, actor, 1);
    await service.observe(scope);
    expect(enqueue).toHaveBeenCalled();
    const claim = await service.claim(scope);
    if (!claim.claimed) throw Error("Expected authorized claim");
    await db
      .update(roles)
      .set({ permissions: ["projects:write"] })
      .where(eq(roles.id, roleId));
    expect(await service.renew(scope, claim)).toBeNull();
    expect(await service.complete(scope, claim)).toMatchObject({ settled: true, superseded: true });
    expect((await service.read(scope))?.state).toBe("blocked");
    await db
      .update(roles)
      .set({ permissions: ["workspaces:execute"] })
      .where(eq(roles.id, roleId));
    await db
      .update(storyDeliveryScopes)
      .set({ revision: 2 })
      .where(eq(storyDeliveryScopes.storyId, scope.storyId));
    enqueue.mockClear();
    await service.observe(scope);
    expect(enqueue).not.toHaveBeenCalled();
    await expect(service.authorize(scope, actor, 1)).rejects.toMatchObject({
      code: "preview_delivery_changed",
    });
    await service.authorize(scope, actor, 2);
    await service.observe(scope);
    expect(await service.claim(scope)).toMatchObject({ claimed: true });
  });
});
