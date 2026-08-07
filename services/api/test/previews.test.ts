import { createServer } from "node:http";
import { newId } from "@facility/core";
import {
  auditEvents,
  createDb,
  migrate,
  orgMembers,
  previewSandboxes,
  projects,
  roles,
  runs,
  seed,
  users,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  assertPreviewSession,
  createPreviewRecord,
  destroyPreview,
  mintPreviewHandoff,
  mintPreviewSession,
  previewCookieName,
  provisionPreview,
  proxyPreviewRequest,
  reconcilePreviews,
  rewritePreviewHtml,
} from "../src/previews.js";
import { type SandboxDriver, SandboxLaunchError } from "../src/sandbox/driver.js";
import type { AppConfig, Principal } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";

async function canConnect() {
  const sqlClient = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await sqlClient`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sqlClient.end().catch(() => undefined);
  }
}

describe("SSO-protected preview sandboxes", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres unreachable; preview tests skipped", () => undefined);
    return;
  }

  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 15).toString("base64"),
    port: 4416,
    publicUrl: "http://facility.test",
    webUrl: "http://app.test",
    previewUrl: "http://facility-previews.test",
    sandboxApiUrl: "http://127.0.0.1:0",
    sandboxGatewayUrl: "http://127.0.0.1:0",
    gatewayUrl: "http://localhost:4410",
    sandboxRunnerImage: "facility-runner:dev",
    sandboxDriver: "docker",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  const { db, client } = createDb(databaseUrl);
  const app = await buildApp(config);
  let orgId = "";
  let projectId = "";
  let cookie = "";
  let userId = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/__test/session",
      payload: { email: `preview-${Date.now()}@example.com` },
    });
    orgId = login.json().orgId;
    userId = login.json().userId;
    cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    projectId =
      (
        await db
          .insert(projects)
          .values({
            id: newId("proj"),
            orgId,
            name: "Preview test",
            slug: `preview-${Date.now()}`,
            settings: {},
          })
          .returning()
      )[0]?.id ?? "";
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("fails closed for API keys and for production without configured SSO", () => {
    const user: Principal = {
      type: "user",
      id: "user",
      orgId,
      permissions: ["runs:read"],
    };
    expect(() => assertPreviewSession(config, { ...user, type: "key" })).toThrowError(
      expect.objectContaining({ code: "preview_session_required", statusCode: 403 }),
    );
    expect(() =>
      assertPreviewSession({ ...config, facilityInsecureDev: false }, user),
    ).toThrowError(expect.objectContaining({ code: "preview_auth_unavailable", statusCode: 503 }));
  });

  it("reuses the run preview record when delivery is replayed", async () => {
    const runId = newId("run");
    await db.insert(runs).values({
      id: runId,
      orgId,
      projectId,
      mode: "builder",
      engine: "codex",
      status: "succeeded",
      trigger: {},
      sandbox: {},
      gh: {},
      createdBy: { type: "user", id: userId },
    });
    const first = await createPreviewRecord(db, {
      orgId,
      projectId,
      runId,
      image: "ghcr.io/example/app:first",
      port: 3000,
      ttlHours: 24,
      createdBy: { type: "agent", id: runId },
    });
    const replay = await createPreviewRecord(db, {
      orgId,
      projectId,
      runId,
      image: "ghcr.io/example/app:replayed",
      port: 3000,
      ttlHours: 24,
      createdBy: { type: "agent", id: runId },
    });
    expect(replay?.id).toBe(first?.id);
    const records = await db
      .select()
      .from(previewSandboxes)
      .where(eq(previewSandboxes.runId, runId));
    expect(records).toHaveLength(1);
    expect(records[0]?.config).toMatchObject({ image: "ghcr.io/example/app:first" });

    await db
      .update(previewSandboxes)
      .set({ status: "failed", error: "preview_boot_failed", updatedAt: new Date() })
      .where(eq(previewSandboxes.id, first?.id as string));
    const retry = await createPreviewRecord(db, {
      orgId,
      projectId,
      runId,
      image: "ghcr.io/example/app:retry-after-failure",
      port: 3000,
      ttlHours: 24,
      createdBy: { type: "agent", id: runId },
    });
    expect(retry?.id).not.toBe(first?.id);
    expect(retry?.config).toMatchObject({ image: "ghcr.io/example/app:retry-after-failure" });

    await db
      .update(previewSandboxes)
      .set({ status: "destroyed", updatedAt: new Date() })
      .where(eq(previewSandboxes.id, retry?.id as string));
    const replacement = await createPreviewRecord(db, {
      orgId,
      projectId,
      runId,
      image: "ghcr.io/example/app:replacement",
      port: 3000,
      ttlHours: 24,
      createdBy: { type: "agent", id: runId },
    });
    expect(replacement?.id).not.toBe(retry?.id);
    expect(replacement?.config).toMatchObject({ image: "ghcr.io/example/app:replacement" });
  });

  it("requeues durable unbound previews and leases launch to one worker", async () => {
    const preview = await createPreviewRecord(db, {
      orgId,
      projectId,
      image: "ghcr.io/example/app:durable-preview",
      port: 3000,
      ttlHours: 24,
      createdBy: { type: "user", id: userId },
    });
    if (!preview) throw new Error("durable preview fixture missing");

    const requeued: string[] = [];
    await expect(
      reconcilePreviews(config, undefined, async (previewId) => {
        requeued.push(previewId);
      }),
    ).resolves.toMatchObject({ requeued: expect.arrayContaining([preview.id]) });

    await db
      .update(previewSandboxes)
      .set({ provisionClaimedAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(previewSandboxes.id, preview.id));
    const staleRequeues: string[] = [];
    await reconcilePreviews(config, undefined, async (previewId) => {
      staleRequeues.push(previewId);
    });
    expect(staleRequeues).toContain(preview.id);

    let launchCount = 0;
    let releaseLaunch: () => void = () => undefined;
    let markLaunchStarted: () => void = () => undefined;
    const launchStarted = new Promise<void>((resolve) => {
      markLaunchStarted = resolve;
    });
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const driver: SandboxDriver = {
      name: "docker",
      launch: async () => {
        launchCount += 1;
        markLaunchStarted();
        await launchGate;
        return { ref: "leased-preview", endpoint: "http://127.0.0.1:3999" };
      },
      status: async () => "running",
      async *logs() {},
      stop: async () => undefined,
      destroy: async () => undefined,
    };
    const first = provisionPreview(config, preview.id, driver);
    await launchStarted;
    const duplicate = await provisionPreview(config, preview.id, driver);
    expect(duplicate).toMatchObject({ id: preview.id, status: "provisioning", ref: null });
    expect(launchCount).toBe(1);
    releaseLaunch();
    await expect(first).resolves.toMatchObject({
      id: preview.id,
      status: "running",
      ref: "leased-preview",
      provisionClaimedAt: null,
    });
  });

  it("recovers a stale AWS launch exactly once instead of starting another task", async () => {
    const preview = await createPreviewRecord(db, {
      orgId,
      projectId,
      image: "ghcr.io/example/app:recover-existing",
      port: 3000,
      ttlHours: 24,
      createdBy: { type: "user", id: userId },
    });
    if (!preview) throw new Error("stale recovery fixture missing");
    await db
      .update(previewSandboxes)
      .set({ driver: "aws", provisionClaimedAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(previewSandboxes.id, preview.id));

    let recoveryCount = 0;
    let launchCount = 0;
    const driver: SandboxDriver = {
      name: "aws",
      recoverLaunch: async (spec) => {
        recoveryCount += 1;
        expect(spec).toEqual({ runId: `preview:${preview.id}`, servicePort: 3000 });
        return { ref: "recovered-task", endpoint: "http://10.0.2.45:3000" };
      },
      launch: async () => {
        launchCount += 1;
        return { ref: "duplicate-task", endpoint: "http://10.0.2.46:3000" };
      },
      status: async () => "running",
      async *logs() {},
      stop: async () => undefined,
      destroy: async () => undefined,
    };

    await expect(provisionPreview(config, preview.id, driver)).resolves.toMatchObject({
      status: "running",
      ref: "recovered-task",
      originUrl: "http://10.0.2.45:3000",
      provisionClaimedAt: null,
    });
    await expect(provisionPreview(config, preview.id, driver)).resolves.toMatchObject({
      status: "running",
      ref: "recovered-task",
    });
    expect(recoveryCount).toBe(1);
    expect(launchCount).toBe(0);
  });

  it("keeps stale recovery retryable when AWS task discovery is denied", async () => {
    const preview = await createPreviewRecord(db, {
      orgId,
      projectId,
      image: "ghcr.io/example/app:recover-denied",
      port: 3000,
      ttlHours: 24,
      createdBy: { type: "user", id: userId },
    });
    if (!preview) throw new Error("recovery denial fixture missing");
    const staleClaim = new Date(Date.now() - 16 * 60_000);
    await db
      .update(previewSandboxes)
      .set({ driver: "aws", provisionClaimedAt: staleClaim })
      .where(eq(previewSandboxes.id, preview.id));

    let denied = true;
    let launchCount = 0;
    const driver: SandboxDriver = {
      name: "aws",
      recoverLaunch: async () => {
        if (denied) throw Object.assign(new Error("not authorized"), { name: "AccessDenied" });
        return { ref: "eventually-recovered", endpoint: "http://10.0.2.47:3000" };
      },
      launch: async () => {
        launchCount += 1;
        return { ref: "must-not-launch", endpoint: "http://10.0.2.48:3000" };
      },
      status: async () => "running",
      async *logs() {},
      stop: async () => undefined,
      destroy: async () => undefined,
    };

    await expect(provisionPreview(config, preview.id, driver)).rejects.toThrow("not authorized");
    const deniedRow = (
      await db.select().from(previewSandboxes).where(eq(previewSandboxes.id, preview.id)).limit(1)
    )[0];
    expect(deniedRow).toMatchObject({
      status: "provisioning",
      ref: null,
      error: "preview_recovery_failed:not authorized",
      provisionClaimedAt: staleClaim,
    });
    expect(launchCount).toBe(0);

    denied = false;
    await expect(provisionPreview(config, preview.id, driver)).resolves.toMatchObject({
      status: "running",
      ref: "eventually-recovered",
    });
    expect(launchCount).toBe(0);
  });

  it("destroys a launch that loses its attach lease to terminal preview state", async () => {
    const preview = await createPreviewRecord(db, {
      orgId,
      projectId,
      image: "ghcr.io/example/app:attach-race",
      port: 3000,
      ttlHours: 24,
      createdBy: { type: "user", id: userId },
    });
    if (!preview) throw new Error("attach race fixture missing");
    let releaseLaunch: () => void = () => undefined;
    let markLaunchStarted: () => void = () => undefined;
    const launchStarted = new Promise<void>((resolve) => {
      markLaunchStarted = resolve;
    });
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const destroyed: string[] = [];
    const driver: SandboxDriver = {
      name: "aws",
      launch: async () => {
        markLaunchStarted();
        await launchGate;
        return { ref: "lost-attach-task", endpoint: "http://10.0.2.49:3000" };
      },
      status: async () => "running",
      async *logs() {},
      stop: async () => undefined,
      destroy: async (ref) => {
        destroyed.push(ref);
      },
    };

    const provisioning = provisionPreview(config, preview.id, driver);
    await launchStarted;
    await db
      .update(previewSandboxes)
      .set({ status: "destroyed", provisionClaimedAt: null })
      .where(eq(previewSandboxes.id, preview.id));
    releaseLaunch();

    await expect(provisioning).resolves.toMatchObject({ status: "destroyed", ref: null });
    expect(destroyed).toEqual(["lost-attach-task"]);
  });

  it("does not destroy the task a recovery worker adopted from a slow launcher", async () => {
    const preview = await createPreviewRecord(db, {
      orgId,
      projectId,
      image: "ghcr.io/example/app:slow-launch-adoption",
      port: 3000,
      ttlHours: 24,
      createdBy: { type: "user", id: userId },
    });
    if (!preview) throw new Error("slow launch adoption fixture missing");

    let releaseLaunch: () => void = () => undefined;
    let markLaunchStarted: () => void = () => undefined;
    const launchStarted = new Promise<void>((resolve) => {
      markLaunchStarted = resolve;
    });
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    let launchCount = 0;
    let recoveryCount = 0;
    const destroyed: string[] = [];
    const adopted = {
      ref: "slow-task-adopted-by-recovery",
      endpoint: "http://10.0.2.52:3000",
    };
    const driver: SandboxDriver = {
      name: "aws",
      launch: async () => {
        launchCount += 1;
        markLaunchStarted();
        await launchGate;
        return adopted;
      },
      recoverLaunch: async () => {
        recoveryCount += 1;
        return adopted;
      },
      status: async () => "running",
      async *logs() {},
      stop: async () => undefined,
      destroy: async (ref) => {
        destroyed.push(ref);
      },
    };

    const original = provisionPreview(config, preview.id, driver);
    await launchStarted;
    await db
      .update(previewSandboxes)
      .set({ provisionClaimedAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(previewSandboxes.id, preview.id));

    await expect(provisionPreview(config, preview.id, driver)).resolves.toMatchObject({
      status: "running",
      ref: adopted.ref,
    });
    releaseLaunch();
    await expect(original).resolves.toMatchObject({ status: "running", ref: adopted.ref });
    expect({ launchCount, recoveryCount, destroyed }).toEqual({
      launchCount: 1,
      recoveryCount: 1,
      destroyed: [],
    });
  });

  it("does not resurrect a terminal preview when post-attach persistence fails", async () => {
    const preview = await createPreviewRecord(db, {
      orgId,
      projectId,
      image: "ghcr.io/example/app:post-attach-failure",
      port: 3000,
      ttlHours: 24,
      createdBy: { type: "user", id: userId },
    });
    if (!preview) throw new Error("post-attach failure fixture missing");
    let releaseStatus: () => void = () => undefined;
    let markStatusStarted: () => void = () => undefined;
    const statusStarted = new Promise<void>((resolve) => {
      markStatusStarted = resolve;
    });
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const destroyed: string[] = [];
    const driver: SandboxDriver = {
      name: "aws",
      launch: async () => ({
        ref: "attached-before-failure",
        endpoint: "http://10.0.2.51:3000",
      }),
      status: async () => {
        markStatusStarted();
        await statusGate;
        throw new Error("describe failed");
      },
      async *logs() {},
      stop: async () => undefined,
      destroy: async (ref) => {
        destroyed.push(ref);
      },
    };

    const provisioning = provisionPreview(config, preview.id, driver);
    await statusStarted;
    await db
      .update(previewSandboxes)
      .set({ status: "destroyed", ref: null, originUrl: null, provisionClaimedAt: null })
      .where(eq(previewSandboxes.id, preview.id));
    releaseStatus();

    await expect(provisioning).rejects.toThrow("describe failed");
    const terminal = (
      await db.select().from(previewSandboxes).where(eq(previewSandboxes.id, preview.id)).limit(1)
    )[0];
    expect(terminal).toMatchObject({ status: "destroyed", ref: null, originUrl: null });
    expect(destroyed).toEqual(["attached-before-failure"]);
  });

  it("reconciles a crash after ref and endpoint attachment without relaunching", async () => {
    const preview = await createPreviewRecord(db, {
      orgId,
      projectId,
      image: "ghcr.io/example/app:attached-before-crash",
      port: 3000,
      ttlHours: 24,
      createdBy: { type: "user", id: userId },
    });
    if (!preview) throw new Error("post-attach crash fixture missing");
    await db
      .update(previewSandboxes)
      .set({
        driver: "aws",
        ref: "attached-task",
        originUrl: "http://10.0.2.50:3000",
        status: "provisioning",
        provisionClaimedAt: null,
      })
      .where(eq(previewSandboxes.id, preview.id));
    let launchCount = 0;
    const driver: SandboxDriver = {
      name: "aws",
      launch: async () => {
        launchCount += 1;
        return { ref: "duplicate" };
      },
      status: async () => "running",
      async *logs() {},
      stop: async () => undefined,
      destroy: async () => undefined,
    };

    await expect(reconcilePreviews(config, driver)).resolves.toMatchObject({
      changed: expect.arrayContaining([preview.id]),
    });
    const recovered = (
      await db.select().from(previewSandboxes).where(eq(previewSandboxes.id, preview.id)).limit(1)
    )[0];
    expect(recovered).toMatchObject({
      status: "running",
      ref: "attached-task",
      originUrl: "http://10.0.2.50:3000",
    });
    expect(launchCount).toBe(0);
  });

  it("provisions a private origin, exposes only the SSO proxy URL, and destroys on demand", async () => {
    let requestedPath = "";
    const server = createServer((_request, response) => {
      requestedPath = _request.url ?? "";
      if (_request.url === "/redirect") {
        const bound = server.address();
        if (!bound || typeof bound === "string") throw new Error("preview fixture unbound");
        response.writeHead(302, { location: `http://127.0.0.1:${bound.port}/docs` });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<a href="/docs">docs</a><script src="/app.js"></script>');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("preview fixture did not bind");
    let destroyedRef = "";
    const driver: SandboxDriver = {
      name: "docker",
      launch: async (spec) => {
        expect(spec.servicePort).toBe(3000);
        expect(spec.env).toEqual({ PORT: "3000", FACILITY_PREVIEW: "1" });
        return { ref: "preview-container", endpoint: `http://127.0.0.1:${address.port}` };
      },
      status: async () => "running",
      async *logs() {},
      stop: async () => undefined,
      destroy: async (ref) => {
        destroyedRef = ref;
      },
    };
    try {
      const preview = await createPreviewRecord(db, {
        orgId,
        projectId,
        image: "ghcr.io/example/app:sha-abc123",
        commitSha: "abc123def456",
        command: ["node", "server.js"],
        port: 3000,
        readinessPath: "/healthz",
        ttlHours: 24,
        createdBy: { type: "user", id: "preview-owner" },
      });
      if (!preview) throw new Error("preview fixture missing");
      const provisioned = await provisionPreview(config, preview.id, driver);
      expect(provisioned).toMatchObject({
        id: preview.id,
        status: "running",
        authMode: "facility_session",
        originUrl: `http://127.0.0.1:${address.port}`,
        config: expect.objectContaining({ readinessPath: "/healthz" }),
        commitSha: "abc123def456",
      });
      const provisionedAudit = (
        await db
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, "preview.provisioned")))
      ).find((event) => (event.target as { id?: string }).id === preview.id);
      expect(provisionedAudit?.payload).toMatchObject({
        driver: "docker",
        status: "running",
        auth_mode: "facility_session",
        queue_delay_ms: expect.any(Number),
        launch_ms: expect.any(Number),
        total_ms: expect.any(Number),
      });

      const listed = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/previews`,
        headers: { cookie },
      });
      expect(listed.statusCode).toBe(200);
      const row = listed.json().find((item: { id: string }) => item.id === preview.id);
      expect(row).toMatchObject({
        status: "running",
        authMode: "facility_session",
        url: `http://app.test/api/v1/projects/${projectId}/previews/${preview.id}/open`,
      });
      expect(row).not.toHaveProperty("originUrl");
      const anonymousOpen = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/previews/${preview.id}/open`,
        headers: { host: "facility.test" },
      });
      expect(anonymousOpen.statusCode).toBe(401);
      const controlOrigin = await app.inject({
        method: "GET",
        url: `/preview/${preview.id}/`,
        headers: { host: "facility.test", cookie },
      });
      expect(controlOrigin.statusCode).toBe(404);
      const encodedControlOrigin = await app.inject({
        method: "GET",
        url: `/%70review/${preview.id}/`,
        headers: { host: "facility.test", cookie },
      });
      expect(encodedControlOrigin.statusCode).toBe(404);
      const encodedControlApiOnPreviewOrigin = await app.inject({
        method: "GET",
        url: `/%76%31/projects/${projectId}/previews`,
        headers: { host: "facility-previews.test", cookie },
      });
      expect(encodedControlApiOnPreviewOrigin.statusCode).toBe(404);
      const opened = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/previews/${preview.id}/open`,
        headers: { host: "facility.test", cookie },
      });
      expect(opened.statusCode).toBe(302);
      expect(opened.headers["cache-control"]).toBe("no-store");
      expect(opened.headers["referrer-policy"]).toBe("no-referrer");
      const handoffUrl = new URL(String(opened.headers.location));
      expect(handoffUrl.origin).toBe("http://facility-previews.test");
      const consumed = await app.inject({
        method: "GET",
        url: `${handoffUrl.pathname}${handoffUrl.search}`,
        headers: { host: "facility-previews.test" },
      });
      expect(consumed.statusCode).toBe(302);
      expect(consumed.headers.location).toBe(`/preview/${preview.id}/`);
      const previewCookie = consumed.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
      expect(consumed.cookies[0]).toMatchObject({
        name: previewCookieName(preview.id),
        httpOnly: true,
        sameSite: "Lax",
        path: `/preview/${preview.id}`,
      });
      const replayed = await app.inject({
        method: "GET",
        url: `${handoffUrl.pathname}${handoffUrl.search}`,
        headers: { host: "facility-previews.test" },
      });
      expect(replayed.statusCode).toBe(401);
      const facilitySessionOnly = await app.inject({
        method: "GET",
        url: `/preview/${preview.id}/`,
        headers: { host: "facility-previews.test", cookie },
      });
      expect(facilitySessionOnly.statusCode).toBe(401);
      const malformedPreviewSession = await app.inject({
        method: "GET",
        url: `/preview/${preview.id}/`,
        headers: {
          host: "facility-previews.test",
          cookie: `${previewCookieName(preview.id)}=not-a-sealed-token`,
        },
      });
      expect(malformedPreviewSession.statusCode).toBe(401);
      const expiredPreviewToken = await mintPreviewSession(
        config,
        { userId, orgId, previewId: preview.id },
        Date.now() - 60 * 60_000,
      );
      const expiredPreviewSession = await app.inject({
        method: "GET",
        url: `/preview/${preview.id}/`,
        headers: {
          host: "facility-previews.test",
          cookie: `${previewCookieName(preview.id)}=${expiredPreviewToken}`,
        },
      });
      expect(expiredPreviewSession.statusCode).toBe(401);
      const expiredHandoff = await mintPreviewHandoff(
        db,
        config,
        { userId, orgId, projectId, previewId: preview.id },
        Date.now() - 60_001,
      );
      const expiredConsume = await app.inject({
        method: "GET",
        url: `/preview-auth/${preview.id}?${new URLSearchParams({ handoff: expiredHandoff })}`,
        headers: { host: "facility-previews.test" },
      });
      expect(expiredConsume.statusCode).toBe(401);
      const authenticated = await app.inject({
        method: "GET",
        url: `/preview/${preview.id}/`,
        headers: { host: "facility-previews.test", cookie: previewCookie },
      });
      expect(authenticated.statusCode).toBe(200);
      expect(authenticated.body).toContain(`/preview/${preview.id}/docs`);
      expect(authenticated.headers["referrer-policy"]).toBe("no-referrer");
      const redirected = await app.inject({
        method: "GET",
        url: `/preview/${preview.id}/redirect`,
        headers: { host: "facility-previews.test", cookie: previewCookie },
      });
      expect(redirected.statusCode).toBe(302);
      expect(redirected.headers.location).toBe(`/preview/${preview.id}/docs`);

      const stored = (
        await db.select().from(previewSandboxes).where(eq(previewSandboxes.id, preview.id)).limit(1)
      )[0];
      if (!stored) throw new Error("stored preview missing");
      const upstream = await proxyPreviewRequest(stored, "", "GET", { accept: "text/html" });
      expect(rewritePreviewHtml(await upstream.body.text(), preview.id)).toContain(
        `href="/preview/${preview.id}/docs"`,
      );
      const absolutePath = await proxyPreviewRequest(
        stored,
        "http://203.0.113.1/should-stay-on-preview-origin",
        "HEAD",
        {},
      );
      await absolutePath.body.dump();
      expect(requestedPath).toBe("/http://203.0.113.1/should-stay-on-preview-origin");

      const crossTenantToken = await mintPreviewSession(config, {
        userId,
        orgId: "org_not_the_preview_owner",
        previewId: preview.id,
      });
      const crossTenant = await app.inject({
        method: "GET",
        url: `/preview/${preview.id}/`,
        headers: {
          host: "facility-previews.test",
          cookie: `${previewCookieName(preview.id)}=${crossTenantToken}`,
        },
      });
      expect(crossTenant.statusCode).toBe(404);

      await db.update(users).set({ status: "inactive" }).where(eq(users.id, userId));
      const deactivated = await app.inject({
        method: "GET",
        url: `/preview/${preview.id}/`,
        headers: { host: "facility-previews.test", cookie: previewCookie },
      });
      expect(deactivated.statusCode).toBe(403);
      await db.update(users).set({ status: "active" }).where(eq(users.id, userId));

      const member = (
        await db
          .select({ roleId: orgMembers.roleId })
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
          .limit(1)
      )[0];
      if (!member) throw new Error("preview member missing");
      const originalRole = (
        await db
          .select({ permissions: roles.permissions })
          .from(roles)
          .where(eq(roles.id, member.roleId))
      )[0];
      await db
        .update(roles)
        .set({ permissions: ["projects:read"] })
        .where(eq(roles.id, member.roleId));
      const permissionRevoked = await app.inject({
        method: "GET",
        url: `/preview/${preview.id}/`,
        headers: { host: "facility-previews.test", cookie: previewCookie },
      });
      expect(permissionRevoked.statusCode).toBe(403);
      await db
        .update(roles)
        .set({ permissions: originalRole?.permissions ?? ["*"] })
        .where(eq(roles.id, member.roleId));

      const openedAudit = (
        await db
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, "preview.opened")))
          .limit(1)
      )[0];
      expect(openedAudit?.target).toEqual({ type: "preview", id: preview.id });

      const corsProbe = await app.inject({
        method: "OPTIONS",
        url: "/v1/me",
        headers: {
          host: "facility.test",
          origin: "http://facility-previews.test",
          "access-control-request-method": "GET",
        },
      });
      expect(corsProbe.headers["access-control-allow-origin"]).toBeUndefined();

      const destroyed = await destroyPreview(db, stored, "destroyed", driver);
      expect(destroyed?.status).toBe("destroyed");
      expect(destroyed?.ref).toBeNull();
      expect(destroyed?.originUrl).toBeNull();
      expect(destroyedRef).toBe("preview-container");
      const destroyedAccess = await app.inject({
        method: "GET",
        url: `/preview/${preview.id}/`,
        headers: { host: "facility-previews.test", cookie: previewCookie },
      });
      expect(destroyedAccess.statusCode).toBe(409);

      const retryable = await createPreviewRecord(db, {
        orgId,
        projectId,
        image: "ghcr.io/example/app:sha-retry",
        port: 3000,
        ttlHours: 24,
        createdBy: { type: "user", id: "preview-owner" },
      });
      if (!retryable) throw new Error("retry preview fixture missing");
      const activeRetryable = (
        await db
          .update(previewSandboxes)
          .set({
            ref: "leaked-until-retry",
            status: "running",
            originUrl: `http://127.0.0.1:${address.port}`,
          })
          .where(eq(previewSandboxes.id, retryable.id))
          .returning()
      )[0];
      if (!activeRetryable) throw new Error("active retry preview fixture missing");
      const failingDriver = { ...driver, destroy: async () => Promise.reject(new Error("busy")) };
      await expect(destroyPreview(db, activeRetryable, "destroyed", failingDriver)).rejects.toThrow(
        "busy",
      );
      const retained = (
        await db
          .select()
          .from(previewSandboxes)
          .where(eq(previewSandboxes.id, retryable.id))
          .limit(1)
      )[0];
      expect(retained).toMatchObject({
        status: "running",
        ref: "leaked-until-retry",
        error: "destroy_failed:busy",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("persists a leaked launch ref and clears it on reconciliation", async () => {
    const preview = await createPreviewRecord(db, {
      orgId,
      projectId,
      image: "ghcr.io/example/app:sha-cleanup-retry",
      port: 3000,
      ttlHours: 24,
      createdBy: { type: "user", id: "preview-owner" },
    });
    if (!preview) throw new Error("preview cleanup fixture missing");
    const leakedRef = "preview-task-that-needs-retry";
    const leakingDriver: SandboxDriver = {
      name: "docker",
      launch: async () => {
        throw new SandboxLaunchError("launch_cleanup_failed", leakedRef);
      },
      status: async () => "lost",
      async *logs() {},
      stop: async () => undefined,
      destroy: async () => undefined,
    };
    await expect(provisionPreview(config, preview.id, leakingDriver)).rejects.toThrow(
      "launch_cleanup_failed",
    );
    const failedAudit = (
      await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, "preview.failed")))
    ).find((event) => (event.target as { id?: string }).id === preview.id);
    expect(failedAudit?.payload).toMatchObject({
      error: "launch_cleanup_failed",
      queue_delay_ms: expect.any(Number),
      launch_ms: expect.any(Number),
      total_ms: expect.any(Number),
    });
    const retained = (
      await db.select().from(previewSandboxes).where(eq(previewSandboxes.id, preview.id)).limit(1)
    )[0];
    expect(retained).toMatchObject({
      status: "failed",
      ref: leakedRef,
      error: "launch_cleanup_failed",
    });

    let destroyedRef = "";
    const cleanupDriver: SandboxDriver = {
      ...leakingDriver,
      launch: async () => ({ ref: "unused" }),
      destroy: async (ref) => {
        destroyedRef = ref;
      },
    };
    await expect(reconcilePreviews(config, cleanupDriver)).resolves.toMatchObject({
      changed: expect.arrayContaining([preview.id]),
    });
    expect(destroyedRef).toBe(leakedRef);
    const reconciled = (
      await db.select().from(previewSandboxes).where(eq(previewSandboxes.id, preview.id)).limit(1)
    )[0];
    expect(reconciled).toMatchObject({ status: "failed", ref: null });
  });
});
