import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { parseAgentManifest } from "@facility/agents";
import { generateApiKey, newId } from "@facility/core";
import {
  apiKeys,
  createDb,
  migrate,
  orgs,
  projects,
  seed,
  stories,
  storyConversations,
  storyInputFiles,
  storyMessages,
  turns,
  workspaces,
} from "@facility/db";
import { FacilityClient } from "@facility/sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createStoryDomain } from "../src/story-domain.js";
import { buildPrompt } from "../src/turns/prompt.js";
import type { AppConfig } from "../src/types.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const { db, client } = createDb(databaseUrl);
const config: AppConfig = {
  databaseUrl,
  secretMasterKey: Buffer.alloc(32, 9).toString("base64"),
  port: 4400,
  publicUrl: "http://localhost:4400",
  webUrl: "http://localhost:3400",
  workspaceImage: "fixture",
  workspaceDriver: "docker",
  facilityInsecureDev: true,
  logLevel: "silent",
};
const agent = parseAgentManifest(
  `---\nname: architect\ndescription: Fixture\nengine: codex\nmodel: gpt-5.5\nenabled: true\ntriggers:\n  - type: manual\n---\nRead authorized input files only.`,
  "architect.md",
);

describe("story input file HTTP and domain boundaries", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let root: string;
  let domain: ReturnType<typeof createStoryDomain>;
  let runtime: FakeWorkspaceRuntime;
  const enqueue = vi.fn();
  const projectId = newId("proj"),
    otherProjectId = newId("proj");
  let secret = "",
    otherSecret = "",
    viewerSecret = "",
    otherOrgSecret = "",
    keyId = "";
  const scope = { orgId: "org_local", projectId, storyId: newId("story") };
  const otherScope = { ...scope, storyId: newId("story") };
  const base = () => `/v1/projects/${projectId}/workspace-stories/${scope.storyId}/input-files`;
  const bytes = Buffer.from('{"safe":"synthetic private fixture","not":"customer data"}');
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  function auth(value = secret) {
    return { authorization: `Bearer ${value}` };
  }
  async function prepare(overrides: Record<string, unknown> = {}, target = scope) {
    const response = await app.inject({
      method: "POST",
      url: base().replace(scope.storyId, target.storyId),
      headers: auth(),
      payload: {
        name: "fixture.json",
        size: bytes.length,
        sha256,
        mediaType: "application/json",
        idempotency_key: `fixture-${randomUUID()}`,
        ...overrides,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function upload(prepared: Awaited<ReturnType<typeof prepare>>, value = bytes) {
    return app.inject({
      method: "PUT",
      url: prepared.upload.path,
      headers: prepared.upload.headers,
      payload: value,
    });
  }
  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    root = await mkdtemp(join(tmpdir(), "facility-input-http-"));
    runtime = new FakeWorkspaceRuntime(root);
    domain = createStoryDomain({
      db,
      config,
      runtime,
      enqueue: async (...args) => {
        enqueue(...args);
      },
    });
    app = await buildApp(config, { storyDomain: domain });
    const suffix = randomUUID().slice(0, 8);
    const otherOrgId = newId("org");
    await db
      .insert(orgs)
      .values({ id: otherOrgId, name: "Synthetic other tenant", slug: `input-tenant-${suffix}` });
    const otherKey = await generateApiKey("fak");
    otherOrgSecret = otherKey.secret;
    await db.insert(apiKeys).values({
      id: otherKey.id,
      orgId: otherOrgId,
      name: "synthetic tenant fixture",
      prefix: otherKey.lookup,
      last4: otherKey.last4,
      hash: otherKey.hash,
      roleId: "role_bundled_owner",
      scopeType: "org",
    });
    await db.insert(projects).values([
      { id: projectId, orgId: "org_local", name: "Input fixtures", slug: `input-${suffix}` },
      {
        id: otherProjectId,
        orgId: "org_local",
        name: "Other input project",
        slug: `input-other-${suffix}`,
      },
    ]);
    for (const s of [scope, otherScope]) {
      await db.insert(stories).values({
        ...s,
        id: s.storyId,
        provider: "manual",
        externalId: `input-${s.storyId}`,
        title: "Synthetic input fixture",
        branch: "facility/fixture",
        createdBy: { type: "user", id: "fixture" },
      });
      await db.insert(storyConversations).values({ ...s, id: newId("sess") });
      const handle = await runtime.create({ id: newId("ws"), image: "fixture" });
      await db.insert(workspaces).values({
        ...s,
        id: handle.id,
        provider: "fake",
        externalRef: handle.externalRef,
        volumeRef: handle.volumeRef,
        state: "running",
        environment: { image: "fixture", variables: {} },
      });
    }
    const keys = await Promise.all([
      generateApiKey("fak"),
      generateApiKey("fak"),
      generateApiKey("fak"),
    ]);
    [secret, otherSecret, viewerSecret] = keys.map((k) => k.secret) as [string, string, string];
    if (!keys[0]) throw new Error("expected fixture API key");
    keyId = keys[0].id;
    await db.insert(apiKeys).values(
      keys.map((key, index) => ({
        id: key.id,
        orgId: "org_local",
        name: "synthetic fixture key",
        prefix: key.lookup,
        last4: key.last4,
        hash: key.hash,
        roleId: index === 2 ? "role_bundled_viewer" : "role_bundled_owner",
        scopeType: "project",
        projectId: index === 1 ? otherProjectId : projectId,
      })),
    );
    await app.ready();
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await client.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("uploads exact binary bytes without queuing an agent and consumes the grant", async () => {
    const prepared = await prepare();
    expect(enqueue).not.toHaveBeenCalled();
    const response = await upload(prepared);
    expect(response.statusCode, response.body).toBe(200);
    expect((await upload(prepared)).statusCode).toBe(409);
    const download = await app.inject({
      method: "GET",
      url: prepared.upload.path,
      headers: auth(),
    });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.rawPayload).toEqual(bytes);
    expect(download.headers["content-type"]).toBe("application/octet-stream");
    expect(download.headers["cache-control"]).toContain("no-store");
    const list = await app.inject({ method: "GET", url: base(), headers: auth(viewerSecret) });
    expect(list.json().items).toContainEqual(
      expect.objectContaining({ id: prepared.file.id, state: "available" }),
    );
    expect(list.body).not.toContain(prepared.upload.headers["x-facility-file-token"]);
    expect(list.body).not.toContain(bytes.toString());
    expect(await db.select().from(turns).where(eq(turns.storyId, scope.storyId))).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("publishes the binary wire contract from the running API", () => {
    const document = app.swagger() as { paths?: Record<string, unknown> };
    expect(
      document.paths?.[
        "/v1/projects/{projectId}/workspace-stories/{storyId}/input-files/{fileId}/content"
      ],
    ).toMatchObject({
      put: {
        requestBody: {
          required: true,
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
      },
      get: {
        responses: {
          200: {
            content: {
              "application/octet-stream": { schema: { type: "string", format: "binary" } },
            },
          },
        },
      },
    });
  });
  it("round-trips non-JSON content through the SDK and real Fastify upload/download handlers", async () => {
    const value = Buffer.from([0, 255, 128, 1]);
    const prepared = await prepare({
      size: value.length,
      sha256: createHash("sha256").update(value).digest("hex"),
    });
    const client = new FacilityClient({
      baseUrl: "http://facility.local",
      apiKey: secret,
      maxRetries: 0,
      fetch: async (input, init) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => {
          headers[key] = value;
        });
        const response = await app.inject({
          method: init?.method === "PUT" ? "PUT" : "GET",
          url: new URL(String(input)).pathname,
          headers,
          payload: init?.body instanceof ArrayBuffer ? Buffer.from(init.body) : undefined,
        });
        const outputHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers))
          if (value !== undefined) outputHeaders[key] = String(value);
        return new Response(new Uint8Array(response.rawPayload), {
          status: response.statusCode,
          headers: outputHeaders,
        });
      },
    });
    const path =
      `/v1/projects/${projectId}/workspace-stories/${scope.storyId}/input-files/${prepared.file.id}/content` as const;
    expect(await client.put(path, value, { headers: prepared.upload.headers })).toMatchObject({
      file: { state: "available" },
    });
    expect(Buffer.from(await client.get(path))).toEqual(value);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated, read-only, other-project and other-story mutations", async () => {
    expect((await app.inject({ method: "POST", url: base(), payload: {} })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: base(), headers: auth(viewerSecret), payload: {} }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: base(), headers: auth(otherSecret) })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: base(), headers: auth(otherOrgSecret) })).statusCode,
    ).toBe(404);
    const prepared = await prepare();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: prepared.upload.path,
          headers: { "content-type": "application/octet-stream" },
          payload: bytes,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: prepared.upload.path.replace(scope.storyId, otherScope.storyId),
          headers: prepared.upload.headers,
          payload: bytes,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: prepared.upload.path.replace(scope.storyId, otherScope.storyId),
          headers: auth(),
        })
      ).statusCode,
    ).toBe(404);
  });
  it("retains failed cleanup reservations until a physical discard removes staging", async () => {
    const prepared = await prepare();
    const original = runtime.exec.bind(runtime);
    let stage = "",
      fail = true;
    const exec = vi.spyOn(runtime, "exec").mockImplementation(async (target, command) => {
      if (command.args?.[2] === "cleanup" && command.args[4] === prepared.file.id && fail) {
        fail = false;
        stage = String(command.args[5]);
        return { exitCode: 1, stdout: "", stderr: "synthetic cleanup failure", durationMs: 1 };
      }
      return original(target, command);
    });
    try {
      expect((await upload(prepared)).statusCode).toBe(503);
      expect(
        (await db.select().from(storyInputFiles).where(eq(storyInputFiles.id, prepared.file.id)))[0]
          ?.state,
      ).toBe("failed");
      expect(await readFile(stage)).toEqual(bytes);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `${base()}/${prepared.file.id}`,
            headers: auth(),
          })
        ).statusCode,
      ).toBe(200);
      await expect(readFile(stage)).rejects.toThrow();
      expect(
        (await db.select().from(storyInputFiles).where(eq(storyInputFiles.id, prepared.file.id)))[0]
          ?.state,
      ).toBe("removed");
    } finally {
      exec.mockRestore();
    }
  });
  it("checks size/hash, expiry, idempotency and live credential revocation", async () => {
    const key = `duplicate-${randomUUID()}`;
    const first = await prepare({ idempotency_key: key });
    expect((await prepare({ idempotency_key: key })).file.id).toBe(first.file.id);
    expect((await upload(first, Buffer.from("bad"))).statusCode).toBe(400);
    await db
      .update(storyInputFiles)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(storyInputFiles.id, first.file.id));
    expect((await upload(first)).statusCode).toBe(401);
    const revoked = await prepare();
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, keyId));
    expect((await upload(revoked)).statusCode).toBe(403);
    await db.update(apiKeys).set({ revokedAt: null }).where(eq(apiKeys.id, keyId));
    for (const name of ["../escape", "/tmp/file", "bad\\file", "bad\nname"])
      expect(
        (
          await app.inject({
            method: "POST",
            url: base(),
            headers: auth(),
            payload: {
              name,
              size: bytes.length,
              sha256,
              mediaType: "text/plain",
              idempotency_key: randomUUID(),
            },
          })
        ).statusCode,
      ).toBe(400);
  });
  it("references only available files, queues once, and keeps contents out of the prompt", async () => {
    const pending = await prepare();
    const message = {
      ...scope,
      agent,
      actor: { type: "service" as const, id: keyId },
      body: "Read the attached fixture",
      dedupeKey: randomUUID(),
      trigger: { type: "mcp" as const },
      attachmentIds: [pending.file.id],
    };
    await expect(domain.stories.queueMessage(message)).rejects.toMatchObject({
      code: "input_file_unavailable",
    });
    expect((await upload(pending)).statusCode).toBe(200);
    const sent = await domain.stories.queueMessage(message);
    const duplicate = await domain.stories.queueMessage(message);
    expect(duplicate.message.id).toBe(sent.message.id);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [story] = await db.select().from(stories).where(eq(stories.id, scope.storyId));
    if (!story || !sent.turn) throw new Error("expected queued story and turn");
    const prompt = buildPrompt(
      agent,
      story,
      null,
      [sent.message],
      sent.turn.id,
      [],
      (sent.message.metadata as { attachments: never[] }).attachments,
    );
    expect(prompt).toContain(`/workspace/.facility/inputs/${pending.file.id}`);
    expect(prompt).not.toContain(bytes.toString());
    const removed = await app.inject({
      method: "DELETE",
      url: `${base()}/${pending.file.id}`,
      headers: auth(),
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: pending.upload.path, headers: auth() })).statusCode,
    ).toBe(404);
    await expect(
      domain.stories.queueMessage({ ...message, dedupeKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "input_file_unavailable" });
    expect(
      (await db.select().from(storyMessages).where(eq(storyMessages.id, sent.message.id)))[0]
        ?.metadata,
    ).toHaveProperty("attachments");
  });
  it("metadata reads never wake sleeping compute; upload resumes only with explicit consent", async () => {
    const normal = await prepare();
    const [row] = await db.select().from(workspaces).where(eq(workspaces.storyId, scope.storyId));
    if (!row?.externalRef) throw new Error("expected prepared workspace");
    const locator = {
      id: row.id,
      externalRef: row.externalRef,
      volumeRef: row.volumeRef,
      image: "fixture",
    };
    await runtime.suspend(locator);
    const wake = vi.spyOn(runtime, "wake");
    expect((await app.inject({ method: "GET", url: base(), headers: auth() })).statusCode).toBe(
      200,
    );
    expect(wake).not.toHaveBeenCalled();
    expect((await upload(normal)).statusCode).toBe(503);
    expect(wake).not.toHaveBeenCalled();
    const allowed = await prepare({ resume: true });
    expect((await upload(allowed)).statusCode).toBe(200);
    expect(wake).toHaveBeenCalledOnce();
    wake.mockRestore();
  });
  it("consumes grants before buffering, rejects replay and bounds octet-stream bodies", async () => {
    const race = await prepare();
    const responses = await Promise.all([upload(race), upload(race)]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const invalid = await prepare();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: invalid.upload.path,
          headers: { ...invalid.upload.headers, "x-facility-file-token": "é".repeat(43) },
          payload: bytes,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: invalid.upload.path,
          headers: { ...invalid.upload.headers, "content-type": "text/plain" },
          payload: "not octet stream",
        })
      ).statusCode,
    ).toBe(415);
    expect((await upload(invalid)).statusCode).toBe(409);
    const small = await prepare({ size: 1 });
    expect((await upload(small, bytes)).statusCode).toBe(413);
    expect((await upload(small, Buffer.from("x"))).statusCode).toBe(409);
    const chunked = await prepare({ size: 1 });
    const overflow = await app.inject({
      method: "PUT",
      url: chunked.upload.path,
      headers: chunked.upload.headers,
      payload: Readable.from([Buffer.from("x"), Buffer.from("y")]),
    });
    expect(overflow.statusCode).toBe(413);
    const large = await prepare({
      name: "bounded.bin",
      size: 25 * 1024 * 1024,
      sha256: "a".repeat(64),
      mediaType: "application/octet-stream",
    });
    expect((await upload(large, Buffer.alloc(25 * 1024 * 1024 + 1))).statusCode).toBe(413);
    expect(
      (await db.select().from(storyInputFiles).where(eq(storyInputFiles.id, large.file.id)))[0]
        ?.state,
    ).toBe("failed");
    expect(
      (await app.inject({ method: "DELETE", url: `${base()}/${large.file.id}`, headers: auth() }))
        .statusCode,
    ).toBe(200);
  });
  it("serializes removal against an in-flight write and never resurrects the file", async () => {
    const prepared = await prepare();
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = runtime.writeInputFile.bind(runtime);
    const write = vi.spyOn(runtime, "writeInputFile").mockImplementationOnce(async (...args) => {
      entered();
      await barrier;
      return original(...args);
    });
    const writing = upload(prepared);
    await started;
    const removing = app.inject({
      method: "DELETE",
      url: `${base()}/${prepared.file.id}`,
      headers: auth(),
    });
    release();
    expect((await writing).statusCode).toBe(200);
    expect((await removing).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: prepared.upload.path, headers: auth() })).statusCode,
    ).toBe(404);
    write.mockRestore();
  });
  it("bounds reservations, releases discarded quota, and releases only the destroyed story", async () => {
    const reservations = [];
    for (let index = 0; index < 4; index++)
      reservations.push(
        await prepare(
          {
            name: `quota-${index}.bin`,
            size: 25 * 1024 * 1024,
            sha256: "b".repeat(64),
            mediaType: "application/octet-stream",
          },
          otherScope,
        ),
      );
    const targetBase = base().replace(scope.storyId, otherScope.storyId);
    expect(
      (
        await app.inject({
          method: "POST",
          url: targetBase,
          headers: auth(),
          payload: {
            name: "overflow",
            size: 1,
            sha256: "a".repeat(64),
            idempotency_key: randomUUID(),
          },
        })
      ).statusCode,
    ).toBe(413);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `${targetBase}/${reservations[0].file.id}`,
          headers: auth(),
        })
      ).statusCode,
    ).toBe(200);
    await prepare({ name: "quota-released.bin" }, otherScope);
    await domain.stories.deleteWorkspace({
      ...otherScope,
      actor: { type: "service", id: keyId },
      confirm: true,
    });
    const removed = await db
      .select()
      .from(storyInputFiles)
      .where(eq(storyInputFiles.storyId, otherScope.storyId));
    expect(removed.every((file) => file.state === "removed")).toBe(true);
    const retained = await db
      .select()
      .from(storyInputFiles)
      .where(eq(storyInputFiles.storyId, scope.storyId));
    expect(retained.some((file) => file.state === "available")).toBe(true);
  });
});
