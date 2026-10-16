import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentManifest } from "@facility/agents";
import { generateApiKey, newId, open, seal } from "@facility/core";
import { apiKeys, createDb, migrate, orgs, projects, seed, turns } from "@facility/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createStoryDomain } from "../src/story-domain.js";
import type { AppConfig } from "../src/types.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const builder = parseAgentManifest(
  `---
name: builder
description: Deletion fixture.
engine: codex
model: gpt-5.5
enabled: true
triggers:
  - type: manual
---
Complete the requested work.
`,
  "builder.md",
);

describe("workspace deletion HTTP contract", () => {
  const { db, client } = createDb(databaseUrl);
  const projectId = newId("proj");
  const otherProjectId = newId("proj");
  const otherOrgId = newId("org");
  const foreignProjectId = newId("proj");
  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 27).toString("base64"),
    port: 4400,
    publicUrl: "http://localhost:4400",
    webUrl: "http://localhost:3400",
    workspaceImage: "facility-runner:test",
    workspaceDriver: "docker",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  let root: string;
  let runtime: FakeWorkspaceRuntime;
  let domain: ReturnType<typeof createStoryDomain>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let owner = "";
  let viewer = "";
  let revoked = "";
  let expiredCookie = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    await db
      .insert(orgs)
      .values({ id: otherOrgId, name: "Foreign deletion tenant", slug: randomUUID() });
    await db.insert(projects).values([
      { id: projectId, orgId: "org_local", name: "Deletion", slug: randomUUID() },
      { id: otherProjectId, orgId: "org_local", name: "Other project", slug: randomUUID() },
      { id: foreignProjectId, orgId: otherOrgId, name: "Foreign project", slug: randomUUID() },
    ]);
    for (const kind of ["owner", "viewer", "revoked"] as const) {
      const key = await generateApiKey("fak");
      await db.insert(apiKeys).values({
        id: key.id,
        orgId: "org_local",
        name: kind,
        prefix: key.lookup,
        last4: key.last4,
        hash: key.hash,
        scopeType: "project",
        projectId,
        roleId: kind === "viewer" ? "role_bundled_viewer" : "role_bundled_owner",
        ...(kind === "revoked" ? { revokedAt: new Date() } : {}),
      });
      if (kind === "owner") owner = key.secret;
      if (kind === "viewer") viewer = key.secret;
      if (kind === "revoked") revoked = key.secret;
    }
    root = await mkdtemp(join(tmpdir(), "facility-delete-http-"));
    runtime = new FakeWorkspaceRuntime(root);
    domain = createStoryDomain({ db, config, runtime, enqueue: async () => undefined });
    app = await buildApp(config, { storyDomain: domain, rateLimitMax: 10000 });
    await app.ready();
    const login = await app.inject({ method: "GET", url: "/auth/dev-login" });
    const cookie = login.cookies.find((item) => item.name === "facility_session");
    if (!cookie) throw new Error("session fixture missing");
    const session = JSON.parse(await open(cookie.value, config.secretMasterKey));
    expiredCookie = `facility_session=${await seal(JSON.stringify({ ...session, exp: 1 }), config.secretMasterKey)}`;
  });

  afterAll(async () => {
    await app?.close();
    await client.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function start(orgId = "org_local", project = projectId) {
    return domain.stories.start({
      orgId,
      projectId: project,
      provider: "manual",
      externalId: randomUUID(),
      title: "Delete through HTTP",
      agent: builder,
      message: "Queued work",
      messageDedupeKey: randomUUID(),
      actor: { type: "user", id: "user_local" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
  }

  function request(storyId: string, key = randomUUID(), project = projectId) {
    return {
      method: "DELETE" as const,
      url: `/v1/projects/${project}/workspace-stories/${storyId}/workspace`,
      headers: { authorization: `Bearer ${owner}`, "idempotency-key": key },
      payload: { confirm: true, idempotency_key: key },
    };
  }

  it("cancels queued work and replays successful deletion without destroying twice", async () => {
    const started = await start();
    const destroy = vi.spyOn(runtime, "destroy");
    try {
      const req = request(started.story.id);
      const first = await app.inject(req);
      expect(first.statusCode, first.body).toBe(200);
      const replay = await app.inject(req);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.headers["idempotency-status"]).toBe("replayed");
      expect(replay.json()).toEqual(first.json());
      expect(destroy).toHaveBeenCalledOnce();
      const bundle = await domain.stories.get("org_local", projectId, started.story.id);
      expect(bundle.workspace?.state).toBe("destroyed");
      expect(bundle.turns[0]?.state).toBe("canceled");
      expect(bundle.attention).toEqual([]);
      const fresh = await app.inject(request(started.story.id));
      expect(fresh.statusCode, fresh.body).toBe(200);
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      destroy.mockRestore();
    }
  });

  it("returns 409 for running work and accepts a fresh retry after completion", async () => {
    const started = await start();
    const turn = started.queued.turn;
    if (!turn) throw new Error("queued turn fixture missing");
    await db
      .update(turns)
      .set({ state: "running", startedAt: new Date() })
      .where(eq(turns.id, turn.id));
    const destroy = vi.spyOn(runtime, "destroy");
    try {
      const req = request(started.story.id);
      const blocked = await app.inject(req);
      expect(blocked.statusCode, blocked.body).toBe(409);
      expect(blocked.json().error.code).toBe("workspace_busy");
      expect(destroy).not.toHaveBeenCalled();
      await domain.stories.completeTurn({
        orgId: "org_local",
        projectId,
        turnId: turn.id,
        output: "Done",
        actor: { type: "system", id: "fixture" },
      });
      // 4xx results are replayed by the shared idempotency contract. A new
      // operator attempt must use a new key once the running turn has settled.
      const replay = await app.inject(req);
      expect(replay.statusCode).toBe(409);
      expect(replay.headers["idempotency-status"]).toBe("replayed");
      const retried = await app.inject(request(started.story.id));
      expect(retried.statusCode, retried.body).toBe(200);
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      destroy.mockRestore();
    }
  });

  it("permits the same idempotency key to retry provider cleanup after a 500", async () => {
    const started = await start();
    const destroy = vi
      .spyOn(runtime, "destroy")
      .mockRejectedValueOnce(new Error("provider unavailable"));
    try {
      const req = request(started.story.id);
      const failed = await app.inject(req);
      expect(failed.statusCode, failed.body).toBe(500);
      expect(
        (await domain.stories.get("org_local", projectId, started.story.id)).workspace?.state,
      ).toBe("deleting");
      const retry = await app.inject(req);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(destroy).toHaveBeenCalledTimes(2);
    } finally {
      destroy.mockRestore();
    }
  });

  it("requires confirmation and a matching, valid idempotency key", async () => {
    const started = await start();
    const destroy = vi.spyOn(runtime, "destroy");
    try {
      for (const confirm of [false, "true", null]) {
        const req = request(started.story.id);
        const response = await app.inject({ ...req, payload: { ...req.payload, confirm } });
        expect(response.statusCode, response.body).toBe(400);
      }
      const req = request(started.story.id);
      for (const headers of [
        { authorization: `Bearer ${owner}` },
        { authorization: `Bearer ${owner}`, "idempotency-key": "short" },
        { authorization: `Bearer ${owner}`, "idempotency-key": randomUUID() },
      ]) {
        const response = await app.inject({ ...req, headers });
        expect(response.statusCode, response.body).toBe(400);
      }
      expect(destroy).not.toHaveBeenCalled();
      expect(
        (await domain.stories.get("org_local", projectId, started.story.id)).workspace?.state,
      ).toBe("running");
    } finally {
      destroy.mockRestore();
    }
  });

  it("rejects unauthenticated, malformed, expired, revoked and read-only credentials", async () => {
    const started = await start();
    const destroy = vi.spyOn(runtime, "destroy");
    try {
      for (const [auth, expected] of [
        [{}, 401],
        [{ authorization: "Bearer invalid" }, 401],
        [{ authorization: `Bearer ${revoked}` }, 401],
        [{ cookie: expiredCookie }, 401],
        [{ authorization: `Bearer ${viewer}` }, 403],
      ] as const) {
        const req = request(started.story.id);
        const response = await app.inject({
          ...req,
          headers: { ...auth, "idempotency-key": req.payload.idempotency_key },
        });
        expect(response.statusCode, response.body).toBe(expected);
      }
      expect(destroy).not.toHaveBeenCalled();
      expect(
        (await domain.stories.get("org_local", projectId, started.story.id)).turns[0]?.state,
      ).toBe("queued");
    } finally {
      destroy.mockRestore();
    }
  });

  it("denies both cross-project and cross-tenant deletion without touching their workspaces", async () => {
    const other = await start("org_local", otherProjectId);
    const foreign = await start(otherOrgId, foreignProjectId);
    const destroy = vi.spyOn(runtime, "destroy");
    try {
      for (const [storyId, project] of [
        [other.story.id, otherProjectId],
        [foreign.story.id, foreignProjectId],
        [foreign.story.id, projectId],
      ] as const) {
        const response = await app.inject(request(storyId, randomUUID(), project));
        expect(response.statusCode, response.body).toBe(404);
      }
      expect(destroy).not.toHaveBeenCalled();
      expect(
        (await domain.stories.get("org_local", otherProjectId, other.story.id)).workspace?.state,
      ).toBe("running");
      expect(
        (await domain.stories.get(otherOrgId, foreignProjectId, foreign.story.id)).workspace?.state,
      ).toBe("running");
    } finally {
      destroy.mockRestore();
    }
  });
});
