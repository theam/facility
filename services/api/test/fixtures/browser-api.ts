import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { newId } from "@facility/core";
import { createDb, migrate, orgMembers, roles, seed, workspaces } from "@facility/db";
import { and, eq } from "drizzle-orm";
import { AgentCatalogService } from "../../src/agents/catalog.js";
import { buildApp } from "../../src/app.js";
import { createStoryDomain } from "../../src/story-domain.js";
import type { AppConfig } from "../../src/types.js";
import { FakeWorkspaceRuntime } from "../../src/workspaces/fake.js";
import { parseProjectManifest } from "../../src/workspaces/project-environment.js";

// A test-only executable: real HTTP authorization, routes, PostgreSQL and
// lifecycle services; only external catalog/manifest reads and execution are fake.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must point to a disposable local test database");
const database = new URL(databaseUrl);
if (
  !["localhost", "127.0.0.1"].includes(database.hostname) ||
  !["/facility_test", "/facility_ws"].includes(database.pathname)
) {
  throw new Error("Refusing a non-local or non-test database");
}
process.env.NODE_ENV = "test";
await migrate(databaseUrl);
await seed(databaseUrl, { includeDemoData: true });
const { db, client } = createDb(databaseUrl);
const root = await mkdtemp(join(tmpdir(), "facility-browser-"));
const runtime = new FakeWorkspaceRuntime(root);
const initialized = new Set<string>();
const execute = promisify(execFile);
const config: AppConfig = {
  databaseUrl,
  secretMasterKey: Buffer.alloc(32, 19).toString("base64"),
  port: 4492,
  publicUrl: "http://127.0.0.1:4492",
  webUrl: "http://127.0.0.1:3492",
  workspaceImage: "fixture",
  workspaceDriver: "docker",
  facilityInsecureDev: false,
  logLevel: "silent",
};
const domain = createStoryDomain({
  db,
  config,
  runtime,
  enqueue: async (_queue, data) => {
    const orgId = String(data.orgId);
    const projectId = String(data.projectId);
    const turnId = String(data.turnId);
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.orgId, orgId), eq(workspaces.projectId, projectId)));
    if (!workspace?.externalRef) throw new Error("Missing fixture workspace");
    await runtime.wake({
      id: workspace.id,
      volumeRef: workspace.volumeRef,
      externalRef: workspace.externalRef,
      image: "fixture",
    });
    // Seed only on the first turn. A later turn must fail if state disappeared,
    // rather than silently recreating the same markers and hiding data loss.
    const firstTurn = !initialized.has(workspace.id);
    if (firstTurn) await execute("git", ["init", "--quiet", workspace.volumeRef]);
    for (const path of ["untracked.txt", ".facility/claude/session", ".facility/codex/session"]) {
      const target = join(workspace.volumeRef, path);
      if (firstTurn) await writeFile(target, `retained:${path}`, { flag: "wx" });
      else if ((await readFile(target, "utf8")) !== `retained:${path}`)
        throw new Error(`Lost fixture state: ${path}`);
    }
    initialized.add(workspace.id);
    await db.update(workspaces).set({ state: "running" }).where(eq(workspaces.id, workspace.id));
    await domain.stories.completeTurn({
      orgId,
      projectId,
      turnId,
      output: "Fixture turn completed",
      actor: { type: "system", id: "fixture-engine" },
    });
  },
});
domain.catalog = new AgentCatalogService(db, {
  load: async () => ({
    commitSha: "a".repeat(40),
    sources: [
      {
        file: ".agents/builder.md",
        source:
          "---\nname: builder\ndescription: Browser test agent\nengine: codex\nmodel: fixture\nenabled: true\ntriggers:\n  - type: ui\n---\nComplete the fixture turn.\n",
      },
    ],
  }),
});
domain.projectManifests.load = async () =>
  parseProjectManifest(
    "version: 1\nrepositories:\n  primary: github.com/fixture/app\n  related: []\nenvironment:\n  start: 'true'\n  services: {}\n",
  );
const app = await buildApp(config, { storyDomain: domain, rateLimitMax: 10_000 });
const sessions = new Map<string, { orgId: string; projectId: string }>();
app.post("/__fixture/setup", { config: { public: true } }, async () => {
  const id = randomUUID();
  const login = await app.inject({
    method: "POST",
    url: "/__test/session",
    payload: { email: `${id}@example.test` },
  });
  if (login.statusCode !== 200) throw new Error(login.body);
  const { orgId, userId } = login.json();
  const cookie = login.cookies.find((item) => item.name === "facility_session");
  if (!cookie) throw new Error("No session cookie");
  const created = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: { cookie: `${cookie.name}=${cookie.value}` },
    payload: { name: "Browser lifecycle", slug: `browser-${id}` },
  });
  if (created.statusCode !== 200) throw new Error(created.body);
  const roleId = newId("role");
  await db.insert(roles).values({
    id: roleId,
    orgId,
    name: `executor-${id}`,
    permissions: ["org:read", "projects:read", "projects:write", "workspaces:execute"],
  });
  await db
    .update(orgMembers)
    .set({ roleId })
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
  sessions.set(id, { orgId, projectId: created.json().id });
  return {
    fixtureId: id,
    projectId: created.json().id,
    cookie: { name: cookie.name, value: cookie.value },
  };
});
app.get<{ Params: { id: string } }>(
  "/__fixture/:id/files",
  { config: { public: true } },
  async (request) => {
    const scope = sessions.get(request.params.id);
    if (!scope) throw new Error("Unknown fixture");
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.orgId, scope.orgId), eq(workspaces.projectId, scope.projectId)));
    if (!workspace) return { files: null };
    const files = await Promise.all(
      ["untracked.txt", ".facility/claude/session", ".facility/codex/session"].map(async (path) => {
        try {
          return await readFile(join(workspace.volumeRef, path), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      }),
    );
    return {
      workspaceId: workspace.id,
      volumeRef: workspace.volumeRef,
      state: workspace.state,
      files,
    };
  },
);
await app.listen({ host: "127.0.0.1", port: 4492 });
async function close() {
  await app.close();
  await client.end();
  await rm(root, { recursive: true, force: true });
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
