import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateApiKey, newId, open, seal } from "@facility/core";
import {
  apiKeys,
  auditEvents,
  createDb,
  migrate,
  orgs,
  projects,
  seed,
  stories,
  workspaceEvents,
  workspaces,
} from "@facility/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import {
  ProjectEnvironmentService,
  parseProjectManifest,
} from "../src/workspaces/project-environment.js";
import { WorkspaceVariablesService } from "../src/workspaces/variables.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";

describe("workspace variables: authenticated API, encryption, and process delivery", () => {
  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID();
  const projectId = newId("proj");
  const storyId = newId("story");
  const workspaceId = newId("ws");
  const otherOrg = newId("org");
  const otherProject = newId("proj");
  const otherStory = newId("story");
  const otherWorkspace = newId("ws");
  const masterKey = Buffer.alloc(32, 17).toString("base64");
  const service = new WorkspaceVariablesService(db, masterKey);
  const scope = { orgId: "org_local", projectId, workspaceId };
  const path = `/v1/projects/${projectId}/workspace-stories/${storyId}/environment/variables`;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie = "";
  let viewer = "";
  let scoped = "";
  let expired = "";
  let revoked = "";
  let root = "";
  let revision = "";
  const secret = `private-workspace-value-${suffix}`;

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    await db.insert(orgs).values({ id: otherOrg, name: "Other", slug: `vars-${suffix}` });
    await db.insert(projects).values([
      { id: projectId, orgId: "org_local", name: "Vars", slug: `vars-${suffix}` },
      { id: otherProject, orgId: otherOrg, name: "Other", slug: `vars-other-${suffix}` },
    ]);
    await db.insert(stories).values([
      {
        id: storyId,
        orgId: "org_local",
        projectId,
        provider: "manual",
        externalId: suffix,
        title: "Variables",
        createdBy: {},
      },
      {
        id: otherStory,
        orgId: otherOrg,
        projectId: otherProject,
        provider: "manual",
        externalId: suffix,
        title: "Other",
        createdBy: {},
      },
    ]);
    await db.insert(workspaces).values([
      {
        id: workspaceId,
        orgId: "org_local",
        projectId,
        storyId,
        provider: "fake",
        externalRef: workspaceId,
        volumeRef: "retained",
        state: "running",
        setupChecksum: "retained-checksum",
        environment: { image: "runner:test", ports: [] },
      },
      {
        id: otherWorkspace,
        orgId: otherOrg,
        projectId: otherProject,
        storyId: otherStory,
        provider: "fake",
        volumeRef: "other",
        environment: { image: "runner:test" },
      },
    ]);
    for (const kind of ["viewer", "scoped", "revoked"] as const) {
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
      if (kind === "viewer") viewer = key.secret;
      if (kind === "scoped") scoped = key.secret;
      if (kind === "revoked") revoked = key.secret;
    }
    app = await buildApp(
      {
        databaseUrl,
        secretMasterKey: masterKey,
        port: 4400,
        publicUrl: "http://localhost:4400",
        webUrl: "http://localhost:3400",
        workspaceImage: "runner:test",
        workspaceDriver: "docker",
        facilityInsecureDev: true,
        logLevel: "silent",
      },
      { rateLimitMax: 10000 },
    );
    await app.ready();
    cookie = (await app.inject({ method: "GET", url: "/auth/dev-login" })).cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const sealedSession = cookie.split("facility_session=")[1]?.split(";")[0];
    if (!sealedSession) throw new Error("Fixture session is missing");
    const session = JSON.parse(await open(sealedSession, masterKey));
    expired = `facility_session=${await seal(JSON.stringify({ ...session, exp: 1 }), masterKey)}`;
    root = await mkdtemp(join(tmpdir(), "facility-vars-"));
  });
  afterAll(async () => {
    await app?.close();
    await client.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("stores encrypted values, exposes names only, and replays without leaking secrets", async () => {
    const request = {
      method: "PATCH" as const,
      url: path,
      headers: { cookie, "idempotency-key": `variables-${suffix}` },
      payload: {
        revision: "",
        variables: { WORKOS_API_KEY: secret, PUBLIC_LABEL: "example", EMPTY: "" },
      },
    };
    const result = await app.inject(request);
    expect(result.statusCode).toBe(200);
    revision = result.json().revision;
    expect(result.body).not.toContain(secret);
    expect((await app.inject(request)).json()).toEqual(result.json());
    const read = await app.inject({
      method: "GET",
      url: path,
      headers: { authorization: `Bearer ${viewer}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.body).not.toContain(secret);
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(await service.values(scope)).toEqual({
      WORKOS_API_KEY: secret,
      PUBLIC_LABEL: "example",
      EMPTY: "",
    });
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(JSON.stringify(row?.environment)).not.toContain(secret);
    expect(row?.setupChecksum).toBe("retained-checksum");
    expect(
      JSON.stringify(
        await db.select().from(auditEvents).where(eq(auditEvents.projectId, projectId)),
      ),
    ).not.toContain(secret);
    const detail = await app.inject({
      method: "GET",
      url: path.replace("/environment/variables", ""),
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain("managedVariables");
    expect(detail.body).not.toContain(secret);
  });

  it("denies anonymous, viewer, expired, revoked, cross-project and cross-tenant writes", async () => {
    for (const [headers, expected] of [
      [{}, 401],
      [{ authorization: `Bearer ${viewer}` }, 403],
      [{ cookie: expired }, 401],
      [{ authorization: `Bearer ${revoked}` }, 401],
    ] as const) {
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: path,
            headers,
            payload: { revision, variables: { KEY: "denied" } },
          })
        ).statusCode,
      ).toBe(expected);
    }
    const foreignPath = `/v1/projects/${otherProject}/workspace-stories/${otherStory}/environment/variables`;
    expect(
      (
        await app.inject({
          method: "GET",
          url: foreignPath,
          headers: { authorization: `Bearer ${scoped}` },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: foreignPath,
          headers: { cookie },
          payload: { revision: "", variables: { KEY: "denied" } },
        })
      ).statusCode,
    ).toBe(404);
    await expect(service.values({ ...scope, orgId: otherOrg })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("rejects stale revisions, malformed inputs, and reserved runtime overrides", async () => {
    for (const [payload, expected] of [
      [{ revision: "old", variables: { KEY: "stale" } }, 409],
      [{ revision, variables: { FACILITY_PREVIEW_GATEWAY_TOKEN: "unsafe" } }, 400],
      [{ revision, variables: { KEY: "nul\0" } }, 400],
      [{ revision, dotenv: "# no variables" }, 400],
    ] as const) {
      expect(
        (await app.inject({ method: "PATCH", url: path, headers: { cookie }, payload })).statusCode,
      ).toBe(expected);
    }
    expect((await service.values(scope)).WORKOS_API_KEY).toBe(secret);
  });

  it("delivers overrides to app starts and browser tests, redacts logs and never repeats setup", async () => {
    const shared = await service.updateProject(
      { orgId: scope.orgId, projectId },
      {
        revision: "",
        variables: { SHARED_PROCESS_KEY: "shared-process-secret", SHORT_KEY: "xyz" },
      },
    );
    const runtime = new FakeWorkspaceRuntime(root);
    const workspace = await runtime.create({ id: workspaceId, image: "runner:test" });
    await mkdir(join(workspace.volumeRef, "repos/acme/app"), { recursive: true });
    await writeFile(join(workspace.volumeRef, "repos/acme/app/retained-data"), "unchanged");
    const manifest = parseProjectManifest(
      `version: 1\nrepositories:\n  primary: github.com/acme/app\nenvironment:\n  setup: exit 99\n  start: printf '%s' "$WORKOS_API_KEY $SHORT_KEY"\n  browser_test: printf '%s' "$WORKOS_API_KEY $SHORT_KEY"\n  secrets: [WORKOS_API_KEY]\n  services: {}\n`,
    );
    const environment = new ProjectEnvironmentService(
      db,
      runtime,
      undefined,
      () => "operator-default",
      (s) => service.values(s),
    );
    const input = {
      orgId: scope.orgId,
      projectId,
      workspace,
      manifest,
      credentials: {
        gitIdentity: { name: "bot", email: "bot@example.com" },
        repositories: [
          { owner: "acme", name: "app", defaultBranch: "main", role: "primary" as const },
        ],
        environment: {},
        expiresAt: new Date(Date.now() + 3600000),
      },
    };
    const prepared = await environment.startPrepared({
      ...input,
      setupChecksum: "retained-checksum",
    });
    expect(prepared.processEnvironment.WORKOS_API_KEY).toBe(secret);
    expect(prepared.processEnvironment.PUBLIC_LABEL).toBe("example");
    expect(prepared.processEnvironment.SHARED_PROCESS_KEY).toBe("shared-process-secret");
    expect(prepared.secretNames).toContain("SHARED_PROCESS_KEY");
    expect(prepared.secretNames).toContain("PUBLIC_LABEL");
    const tested = await environment.runBrowserTest({ ...input, storyId });
    expect(JSON.stringify(tested)).not.toContain(secret);
    const events = await db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, workspaceId));
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain("xyz");
    expect(events.some((e) => e.type === "environment.setup")).toBe(false);
    expect(await readFile(join(workspace.volumeRef, "repos/acme/app/retained-data"), "utf8")).toBe(
      "unchanged",
    );
    await service.updateProject(
      { orgId: scope.orgId, projectId },
      { revision: shared.revision, variables: { SHARED_PROCESS_KEY: null, SHORT_KEY: null } },
    );
  });

  it("shares encrypted project defaults with existing and future workspaces and preserves overrides", async () => {
    const projectPath = `/v1/projects/${projectId}/environment/variables`;
    const defaults = {
      revision: (await service.projectMetadata({ orgId: scope.orgId, projectId })).revision,
      variables: { SHARED_KEY: "project-secret", WORKOS_API_KEY: "project-workos" },
    };
    const request = {
      method: "PATCH" as const,
      url: projectPath,
      headers: { cookie, "idempotency-key": `project-vars-${suffix}` },
      payload: defaults,
    };
    const response = await app.inject(request);
    expect(response.statusCode).toBe(200);
    expect((await app.inject(request)).json()).toEqual(response.json());
    expect(response.body).not.toContain("project-secret");
    expect(await service.values(scope)).toMatchObject({
      SHARED_KEY: "project-secret",
      WORKOS_API_KEY: secret,
    });
    expect((await service.metadata(scope)).inherited_variables.map((v) => v.name)).toContain(
      "SHARED_KEY",
    );
    const futureId = newId("ws");
    const futureStory = newId("story");
    await db.insert(stories).values({
      id: futureStory,
      orgId: "org_local",
      projectId,
      provider: "manual",
      externalId: `future-${suffix}`,
      title: "Future workspace",
      createdBy: {},
    });
    await db.insert(workspaces).values({
      id: futureId,
      storyId: futureStory,
      orgId: "org_local",
      projectId,
      provider: "fake",
      volumeRef: "future",
      state: "running",
      environment: {},
    });
    const future = { ...scope, workspaceId: futureId };
    expect(await service.values(future)).toEqual(defaults.variables);
    const update = await service.updateProject(
      { orgId: scope.orgId, projectId },
      { revision: response.json().revision, variables: { SHARED_KEY: "rotated-project" } },
    );
    expect((await service.values(scope)).SHARED_KEY).toBe("rotated-project");
    expect((await service.values(future)).SHARED_KEY).toBe("rotated-project");
    const override = await service.update(future, {
      revision: "",
      variables: { SHARED_KEY: "workspace-only" },
    });
    expect((await service.values(future)).SHARED_KEY).toBe("workspace-only");
    await service.update(future, { revision: override.revision, variables: { SHARED_KEY: null } });
    expect((await service.values(future)).SHARED_KEY).toBe("rotated-project");
    const [storedProject] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(JSON.stringify(storedProject?.environmentSecrets)).not.toContain("rotated-project");
    for (const url of [`/v1/projects/${projectId}`, "/v1/projects"]) {
      const read = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(read.statusCode).toBe(200);
      const details = Array.isArray(read.json())
        ? read.json().find((p: { id: string }) => p.id === projectId)
        : read.json();
      expect(details).toBeDefined();
      expect(details).not.toHaveProperty("environmentSecrets");
      expect(read.body).not.toContain("managedVariables");
      expect(read.body).not.toContain("rotated-project");
    }
    const settings = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}`,
      headers: { cookie },
      payload: { settings: { environmentSecrets: {} } },
    });
    expect(settings.statusCode).toBe(200);
    expect((await service.values(future)).SHARED_KEY).toBe("rotated-project");
    const read = await app.inject({
      method: "GET",
      url: projectPath,
      headers: { authorization: `Bearer ${viewer}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.body).not.toContain("rotated-project");
    for (const [headers, expected] of [
      [{}, 401],
      [{ authorization: `Bearer ${viewer}` }, 403],
      [{ cookie: expired }, 401],
      [{ authorization: `Bearer ${revoked}` }, 401],
    ] as const) {
      expect(
        (await app.inject({ method: "PATCH", url: projectPath, headers, payload: defaults }))
          .statusCode,
      ).toBe(expected);
    }
    for (const headers of [{ cookie }, { authorization: `Bearer ${scoped}` }]) {
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/v1/projects/${otherProject}/environment/variables`,
            headers,
            payload: defaults,
          })
        ).statusCode,
      ).toBe(404);
    }
    for (const [payload, expected] of [
      [defaults, 409],
      [{ revision: update.revision, variables: { GITHUB_TOKEN: "denied" } }, 400],
    ] as const) {
      expect(
        (await app.inject({ method: "PATCH", url: projectPath, headers: { cookie }, payload }))
          .statusCode,
      ).toBe(expected);
    }
    await db
      .update(projects)
      .set({ environmentSecrets: storedProject?.environmentSecrets })
      .where(eq(projects.id, otherProject));
    await expect(
      service.projectValues({ orgId: otherOrg, projectId: otherProject }),
    ).rejects.toMatchObject({ code: "environment_unavailable" });
    await db
      .update(workspaces)
      .set({ environment: storedProject?.environmentSecrets })
      .where(eq(workspaces.id, futureId));
    await expect(service.values(future)).rejects.toMatchObject({ code: "environment_unavailable" });
    await db.update(workspaces).set({ environment: {} }).where(eq(workspaces.id, futureId));
    await db.update(projects).set({ environmentSecrets: {} }).where(eq(projects.id, otherProject));
    const races = await Promise.allSettled([
      service.updateProject(
        { orgId: scope.orgId, projectId },
        { revision: update.revision, variables: { SHARED_KEY: null, WORKOS_API_KEY: null } },
      ),
      service.updateProject(
        { orgId: scope.orgId, projectId },
        { revision: update.revision, variables: { SHARED_KEY: null, WORKOS_API_KEY: null } },
      ),
    ]);
    expect(races.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await service.values(future)).toEqual({});
    expect((await service.values(scope)).WORKOS_API_KEY).toBe(secret);
  });

  it("serializes simultaneous edits and rejects modified ciphertext", async () => {
    const results = await Promise.allSettled([
      service.update(scope, { revision, variables: { RACE_A: "first" } }),
      service.update(scope, { revision, variables: { RACE_B: "second" } }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toMatchObject({
      code: "environment_revision_conflict",
    });
    revision = (await service.metadata(scope)).revision;
    await db
      .update(workspaces)
      .set({
        environment: {
          managedVariables: {
            revision: "tampered",
            sealed: "not-a-valid-ciphertext",
            updatedAt: new Date().toISOString(),
          },
        },
      })
      .where(eq(workspaces.id, otherWorkspace));
    await expect(
      service.metadata({ orgId: otherOrg, projectId: otherProject, workspaceId: otherWorkspace }),
    ).rejects.toMatchObject({ code: "environment_unavailable" });
  });

  it("replaces and deletes values and rejects ciphertext moved to another tenant", async () => {
    const result = await app.inject({
      method: "PATCH",
      url: path,
      headers: { cookie },
      payload: { revision, dotenv: 'WORKOS_API_KEY="rotated"\nNEW_VALUE="one\\ntwo"' },
    });
    expect(result.statusCode).toBe(200);
    revision = result.json().revision;
    expect((await service.values(scope)).NEW_VALUE).toBe("one\ntwo");
    const removed = await service.update(scope, { revision, variables: { WORKOS_API_KEY: null } });
    expect(removed.variables.map((v) => v.name)).not.toContain("WORKOS_API_KEY");
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!row) throw new Error("Workspace fixture is missing");
    await db
      .update(workspaces)
      .set({ environment: row.environment })
      .where(eq(workspaces.id, otherWorkspace));
    await expect(
      service.values({ orgId: otherOrg, projectId: otherProject, workspaceId: otherWorkspace }),
    ).rejects.toMatchObject({ code: "environment_unavailable" });
    await db.update(workspaces).set({ state: "destroyed" }).where(eq(workspaces.id, workspaceId));
    await expect(
      service.update(scope, { revision: removed.revision, variables: { KEY: "denied" } }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
