import { createServer } from "node:http";
import { newId } from "@facility/core";
import { createDb, migrate, previewSandboxes, projects, seed } from "@facility/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  assertPreviewSession,
  createPreviewRecord,
  destroyPreview,
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
        url: `http://facility.test/preview/${preview.id}/`,
      });
      expect(row).not.toHaveProperty("originUrl");
      const anonymous = await app.inject({
        method: "GET",
        url: `/preview/${preview.id}/`,
      });
      expect(anonymous.statusCode).toBe(401);
      const authenticated = await app.inject({
        method: "GET",
        url: `/preview/${preview.id}/`,
        headers: { cookie },
      });
      expect(authenticated.statusCode).toBe(200);
      expect(authenticated.body).toContain(`/preview/${preview.id}/docs`);
      const redirected = await app.inject({
        method: "GET",
        url: `/preview/${preview.id}/redirect`,
        headers: { cookie },
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

      const destroyed = await destroyPreview(db, stored, "destroyed", driver);
      expect(destroyed?.status).toBe("destroyed");
      expect(destroyed?.ref).toBeNull();
      expect(destroyed?.originUrl).toBeNull();
      expect(destroyedRef).toBe("preview-container");

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
