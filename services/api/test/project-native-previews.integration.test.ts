import { randomUUID } from "node:crypto";
import { generateApiKey, newId } from "@facility/core";
import {
  apiKeys,
  createDb,
  migrate,
  orgs,
  projects,
  roles,
  stories,
  workspaces,
} from "@facility/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { readStoryLifecycle } from "../src/stories/lifecycle.js";
import { createStoryDomain } from "../src/story-domain.js";
import type { AppConfig } from "../src/types.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import {
  nativePreviewsEnabledForProject,
  nativePreviewsEnabledForWorkspace,
  projectNativePreviewsEnabled,
} from "../src/workspaces/project-native-previews.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
const { db, client } = createDb(databaseUrl);
const orgId = newId("org"),
  otherOrgId = newId("org");
const projectId = newId("proj"),
  otherProjectId = newId("proj"),
  foreignProjectId = newId("proj");
const storyId = newId("story"),
  workspaceId = newId("ws");
const writerRole = newId("role"),
  readerRole = newId("role");
const config: AppConfig = {
  databaseUrl,
  secretMasterKey: Buffer.alloc(32, 15).toString("base64"),
  port: 4400,
  publicUrl: "https://api.facility.test",
  webUrl: "https://facility.test",
  previewUrl: "https://preview.other.test",
  workspaceImage: "test",
  workspaceDriver: "vercel",
  nativePreviews: true,
  facilityInsecureDev: true,
  logLevel: "silent",
};
const domain = createStoryDomain({
  db,
  config,
  runtime: new FakeWorkspaceRuntime(),
  enqueue: async () => undefined,
});
let app: Awaited<ReturnType<typeof buildApp>>;
let writer: string, reader: string;
async function key(roleId: string) {
  const generated = await generateApiKey("fak");
  await db.insert(apiKeys).values({
    id: generated.id,
    orgId,
    roleId,
    projectId,
    scopeType: "project",
    name: "project-preview-test",
    prefix: generated.lookup,
    last4: generated.last4,
    hash: generated.hash,
  });
  return generated.secret;
}
beforeAll(async () => {
  await migrate(databaseUrl);
  await db.insert(orgs).values([orgId, otherOrgId].map((id) => ({ id, name: id, slug: id })));
  await db.insert(projects).values([
    {
      id: projectId,
      orgId,
      name: "Pilot",
      slug: projectId,
      settings: { existing: { keep: true } },
    },
    { id: otherProjectId, orgId, name: "Untouched", slug: otherProjectId },
    { id: foreignProjectId, orgId: otherOrgId, name: "Foreign", slug: foreignProjectId },
  ]);
  await db.insert(roles).values([
    {
      id: writerRole,
      orgId,
      name: "Preview project writer",
      permissions: ["projects:read", "projects:write"],
    },
    { id: readerRole, orgId, name: "Preview project reader", permissions: ["projects:read"] },
  ]);
  writer = await key(writerRole);
  reader = await key(readerRole);
  await db.insert(stories).values({
    id: storyId,
    orgId,
    projectId,
    provider: "manual",
    externalId: storyId,
    title: "Pilot",
    status: "working",
    createdBy: { type: "key", id: "test" },
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    orgId,
    projectId,
    storyId,
    provider: "vercel",
    externalRef: workspaceId,
    volumeRef: workspaceId,
    state: "running",
    endpoints: [{ service: "web", port: 3000, url: "https://pilot.vercel.run", access: "native" }],
  });
  app = await buildApp(config, { storyDomain: domain });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await client.end();
});
function patch(
  payload: Record<string, unknown>,
  target = projectId,
  token = writer,
  requestId = randomUUID(),
) {
  return app.inject({
    method: "PATCH",
    url: `/v1/projects/${target}`,
    headers: { authorization: `Bearer ${token}`, "idempotency-key": requestId },
    payload,
  });
}
it("defaults existing projects off and atomically changes only the requested preference", async () => {
  const initial = await app.inject({
    url: `/v1/projects/${projectId}`,
    headers: { authorization: `Bearer ${writer}` },
  });
  expect(initial.statusCode).toBe(200);
  expect(initial.json().nativePreviews).toEqual({ enabled: false, available: true });
  const requestId = randomUUID();
  const result = await patch({ nativePreviewsEnabled: true }, projectId, writer, requestId);
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({
    nativePreviews: { enabled: true, available: true },
    settings: { existing: { keep: true }, nativePreviewsEnabled: true },
  });
  expect(
    (await patch({ nativePreviewsEnabled: true }, projectId, writer, requestId)).json(),
  ).toEqual(result.json());
  expect(await nativePreviewsEnabledForWorkspace(db, workspaceId)).toBe(true);
  expect(await nativePreviewsEnabledForWorkspace(db, "ws_missing")).toBe(false);
  expect(await nativePreviewsEnabledForProject(db, { orgId, projectId: otherProjectId })).toBe(
    false,
  );
  expect(await nativePreviewsEnabledForProject(db, { orgId: otherOrgId, projectId })).toBe(false);
  expect((await patch({ nativePreviewsEnabled: false })).json().nativePreviews.enabled).toBe(false);
  expect(await nativePreviewsEnabledForWorkspace(db, workspaceId)).toBe(false);
});
it("rejects readers, cross-project keys and cross-tenant targets", async () => {
  for (const [target, token, status] of [
    [projectId, reader, 403],
    [otherProjectId, writer, 404],
    [foreignProjectId, writer, 404],
  ] as const) {
    expect((await patch({ nativePreviewsEnabled: true }, target, token)).statusCode).toBe(status);
  }
  expect(await nativePreviewsEnabledForProject(db, { orgId, projectId: otherProjectId })).toBe(
    false,
  );
});
it("requires a literal boolean and rejects ambiguous settings updates", async () => {
  for (const value of ["true", 1, null, {}, []]) {
    expect(projectNativePreviewsEnabled({ nativePreviewsEnabled: value })).toBe(false);
    expect((await patch({ nativePreviewsEnabled: value })).statusCode).toBe(400);
    expect((await patch({ settings: { nativePreviewsEnabled: value } })).statusCode).toBe(400);
  }
  expect((await patch({ nativePreviewsEnabled: true, settings: {} })).statusCode).toBe(400);
});
it("publishes lifecycle origins only while both project opt-in and installation capability are on", async () => {
  const scope = { orgId, projectId, storyId };
  const read = (available: boolean) =>
    readStoryLifecycle(db, domain.backlog, [], scope, new Date(), available);
  await patch({ nativePreviewsEnabled: true });
  expect((await read(true)).workspace?.sites).toHaveLength(1);
  expect((await read(false)).workspace?.sites).toEqual([]);
  const enabled = await read(true);
  await patch({ nativePreviewsEnabled: false });
  const disabled = await read(true);
  expect(disabled.workspace?.sites).toEqual([]);
  expect(disabled.revision).not.toBe(enabled.revision);
});
it("can save a preference while installation support is off, without making it active", async () => {
  const disabled = await buildApp({ ...config, nativePreviews: false }, { storyDomain: domain });
  try {
    const response = await disabled.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}`,
      headers: { authorization: `Bearer ${writer}`, "idempotency-key": randomUUID() },
      payload: { nativePreviewsEnabled: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().nativePreviews).toEqual({ enabled: true, available: false });
  } finally {
    await disabled.close();
  }
  await db.update(projects).set({ settings: {} }).where(eq(projects.id, projectId));
});
