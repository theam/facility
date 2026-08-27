import { createHmac, generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { hashKey, newId, open, seal } from "@facility/core";
import {
  actionTypes,
  agentDefs,
  analysisSandboxProfileId,
  auditEvents,
  budgets,
  builderSandboxProfileId,
  conversationMessages,
  conversations,
  createDb,
  defaultSandboxProfileId,
  ghIssues,
  githubInstallations,
  inboundEvents,
  insertAuditEvent,
  integrations,
  kbSpaces,
  llmRequests,
  migrate,
  orgMembers,
  orgs,
  platformIssues,
  poTasks,
  projects,
  proposalEvents,
  proposals,
  providerCredentials,
  registryItems,
  registryVersions,
  repos,
  roles,
  runEvents,
  runs,
  sandboxProfiles,
  schedulerWatermarks,
  seed,
  steerMessages,
  userIdentities,
  users,
  verifyAuditChain,
  webhookDeliveries,
} from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp, mintSessionCookie } from "../src/app.js";
import { registerAssistantTurn, releaseAssistantTurn } from "../src/assistant/turn-registry.js";
import type { GithubClientFactory } from "../src/github/client.js";
import { validateProjectKb } from "../src/harness.js";
import { deliverPendingWebhooks } from "../src/integrations/outbound.js";
import { ensureGithubUser } from "../src/routes/auth.js";
import { runAgentSchedules } from "../src/schedules.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const masterKey = Buffer.alloc(32, 9).toString("base64");
const githubAppTestKey = generateKeyPairSync("rsa", { modulusLength: 1024 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

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

function sourceFilesContaining(root: URL, text: string): string[] {
  const matches: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, root);
    if (entry.isDirectory()) {
      matches.push(...sourceFilesContaining(child, text));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      const content = readFileSync(child, "utf8");
      if (content.includes(text)) matches.push(child.pathname);
    }
  }
  return matches;
}

// A stand-in GitHub App factory so task_creation executions can be exercised
// end-to-end without a real installation. Production has no such factory unless
// GitHub is configured, so unconfigured deployments still fail closed.
function fakeGithubFactory(onCreate?: () => Promise<void> | void): GithubClientFactory {
  const octokit = {
    rest: {
      issues: {
        create: async () => {
          await onCreate?.();
          return {
            data: { number: 1, html_url: "https://github.com/facility/repo/issues/1" },
          };
        },
      },
    },
  };
  return (async () => octokit) as unknown as GithubClientFactory;
}

function fakeGuardGithubFactory(observed: {
  issue?: Record<string, unknown>;
  labels?: Record<string, unknown>[];
}): GithubClientFactory {
  const octokit = {
    rest: {
      issues: {
        listForRepo: async () => ({ data: [] }),
        createLabel: async (args: Record<string, unknown>) => {
          observed.labels = [...(observed.labels ?? []), args];
          return { data: {} };
        },
        create: async (args: Record<string, unknown>) => {
          observed.issue = args;
          return { data: { number: 73, html_url: "https://github.test/guard/issues/73" } };
        },
      },
    },
  };
  return (async () => octokit) as unknown as GithubClientFactory;
}

describe("api", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    const databaseExpectation = process.env.CI ? it : it.skip;
    databaseExpectation("Postgres is reachable at DATABASE_URL for the API integration suite", () =>
      expect(reachable).toBe(true),
    );
    return;
  }

  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: masterKey,
    port: 4400,
    publicUrl: "http://localhost:4400",
    sandboxApiUrl: "http://localhost:4400",
    sandboxGatewayUrl: "http://localhost:4410",
    gatewayUrl: "http://localhost:4410",
    sandboxRunnerImage: "facility-runner:dev",
    sandboxDriver: "docker",
    webUrl: "http://localhost:3000",
    facilityInsecureDev: true,
    logLevel: process.env.FACILITY_TEST_LOG_LEVEL ?? "silent",
  };
  const { db, client } = createDb(databaseUrl);
  // The suite exercises hundreds of authenticated calls through one injected
  // client/IP. Rate limiting has isolated plugin coverage; keep integration
  // scenarios independent from one another here.
  const app = await buildApp(config, { rateLimitMax: 10_000 });
  let cookie = "";
  let approverCookie = "";
  let orgId = "";
  const ownerRole = "role_bundled_owner";
  const viewerRole = "role_bundled_viewer";
  let projectId = "";

  it("returns 503 when the health dependency check fails", async () => {
    const unavailable = await buildApp({
      ...config,
      databaseUrl: "postgres://facility:facility@127.0.0.1:1/facility",
    });
    try {
      await unavailable.ready();
      const response = await unavailable.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false, version: "0.3.0", db: "down" });
    } finally {
      await unavailable.close();
    }
  });

  it("enforces the configured production rate limit", async () => {
    const limited = await buildApp(config, { rateLimitMax: 1 });
    try {
      await limited.ready();
      expect((await limited.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      const blocked = await limited.inject({ method: "GET", url: "/health" });
      expect(blocked.statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/__test/session",
      payload: { email: `api-${Date.now()}@example.com` },
    });
    expect(login.statusCode).toBe(200);
    cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    orgId = login.json().orgId;
    const approverLogin = await app.inject({
      method: "POST",
      url: "/__test/session",
      payload: { email: `api-approver-${Date.now()}@example.com` },
    });
    expect(approverLogin.statusCode).toBe(200);
    approverCookie = approverLogin.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    // Every integration file uses the seeded dev org. This suite deliberately
    // mutates and repairs the audit chain, so isolate it from receipts and audit
    // rows left by an earlier file or a prior local run as one atomic fixture reset.
    await db.update(runs).set({ receipt: null }).where(eq(runs.orgId, orgId));
    await db.delete(auditEvents).where(eq(auditEvents.orgId, orgId));
    const setupProject = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "API Setup Project",
          slug: `api-setup-${Date.now()}`,
          settings: {},
        })
        .returning()
    )[0];
    projectId = setupProject?.id ?? "";
  });

  it("publishes a complete external OpenAPI contract", () => {
    const document = app.swagger() as unknown as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            summary?: string;
            tags?: string[];
            security?: Array<Record<string, string[]>>;
            requestBody?: unknown;
            responses?: Record<string, unknown>;
            parameters?: Array<{ name?: string; in?: string }>;
            "x-facility-permission"?: string | string[];
          }
        >
      >;
      tags?: Array<{ name: string; description: string }>;
      components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
    };
    expect(Object.keys(document.paths).some((path) => path.startsWith("/internal/"))).toBe(false);
    expect(document.paths["/__test/session"]).toBeUndefined();
    expect(document.components?.schemas?.ErrorResponse).toBeDefined();
    expect(document.components?.securitySchemes).toMatchObject({
      bearerAuth: { type: "http", scheme: "bearer" },
      sessionCookie: { type: "apiKey", in: "cookie", name: "facility_session" },
      facilitySignature: {
        type: "apiKey",
        in: "header",
        name: "X-Facility-Signature",
      },
    });

    const operationIds: string[] = [];
    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        expect(operation.operationId, `${method} ${path} operationId`).toBeTruthy();
        expect(operation.summary, `${method} ${path} summary`).toBeTruthy();
        expect(operation.tags?.length, `${method} ${path} tags`).toBeGreaterThan(0);
        expect(operation.responses?.["400"], `${method} ${path} error response`).toBeDefined();
        expect(
          Object.keys(operation.responses ?? {}).some((status) => /^[23]/.test(status)),
          `${method} ${path} success response`,
        ).toBe(true);
        operationIds.push(operation.operationId ?? "");
      }
    }
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(
      Object.entries(document.paths).reduce(
        (count, [path, item]) =>
          count +
          (path.startsWith("/v1/")
            ? Object.keys(item).filter((method) =>
                ["get", "post", "put", "patch", "delete"].includes(method),
              ).length
            : 0),
        0,
      ),
    ).toBe(140);
    expect(document.paths["/v1/projects"]?.get?.security).toEqual([
      { bearerAuth: [] },
      { sessionCookie: [] },
    ]);
    expect(document.paths["/v1/projects"]?.get?.["x-facility-permission"]).toBe("projects:read");
    expect(document.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Projects", description: expect.any(String) }),
        expect.objectContaining({ name: "Runs", description: expect.any(String) }),
        expect.objectContaining({ name: "Webhooks", description: expect.any(String) }),
      ]),
    );
    expect(document.paths["/v1/projects"]?.post?.parameters).toContainEqual(
      expect.objectContaining({ name: "Idempotency-Key", in: "header" }),
    );
    expect(document.paths["/health"]?.get?.security).toEqual([]);
    expect(
      document.paths["/v1/projects/{projectId}/previews/{previewId}/open"]?.get?.[
        "x-facility-permission"
      ],
    ).toBe("runs:read");
    expect(document.paths["/preview-auth/{previewId}"]?.get?.security).toEqual([]);
    expect(document.paths["/v1/runs/{runId}/kb-checkpoint"]?.post?.security).toEqual([
      { runnerToken: [] },
    ]);
    expect(document.paths["/v1/runs/{runId}/transcript"]?.get?.responses?.["200"]).toMatchObject({
      content: { "application/x-ndjson": { schema: { type: "string" } } },
    });
    expect(document.paths["/v1/runs/{runId}/stream"]?.get?.responses?.["200"]).toMatchObject({
      content: { "text/event-stream": { schema: { type: "string" } } },
    });
    expect(document.paths["/v1/projects/{projectId}/conversations"]?.post?.summary).toBe(
      "Create conversation",
    );
    expect(document.paths["/v1/projects/{projectId}/issues/{number}/trigger"]?.post).toMatchObject({
      summary: "Trigger issue",
      tags: ["GitHub"],
    });
    expect(
      document.paths["/v1/projects/{projectId}/pulls/{number}/closing-issues"]?.post,
    ).toMatchObject({
      summary: "Attach pull request to issue",
      tags: ["GitHub"],
      "x-facility-permission": "repos:write",
    });
    expect(
      document.paths["/v1/projects/{projectId}/pulls/{number}/closing-issues/{issueNumber}"]
        ?.delete,
    ).toMatchObject({
      summary: "Detach pull request from issue",
      tags: ["GitHub"],
      "x-facility-permission": "repos:write",
    });
    expect(document.paths["/v1/projects/{projectId}/stories/{number}"]?.get).toMatchObject({
      summary: "Get story",
      tags: ["Projects"],
    });
    expect(document.paths["/v1/webhook-deliveries/{deliveryId}/retry"]?.post?.tags).toEqual([
      "Integrations",
    ]);
    expect(document.paths["/webhooks/inbound/{integrationId}"]?.post).toMatchObject({
      security: [{ facilitySignature: [] }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object" } } },
      },
    });
    expect(document.paths["/webhooks/inbound/{integrationId}"]?.post?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "X-Facility-Timestamp", in: "header", required: true }),
        expect.objectContaining({ name: "X-Facility-Delivery", in: "header", required: true }),
        expect.objectContaining({ name: "X-Facility-Event", in: "header", required: true }),
      ]),
    );
  });

  it("keeps the committed SDK OpenAPI contract equivalent to the live API", () => {
    const path = fileURLToPath(new URL("../../../packages/sdk/openapi.json", import.meta.url));
    const committed = JSON.parse(readFileSync(path, "utf8"));
    const live = app.swagger() as unknown as {
      paths: unknown;
      components?: unknown;
    };
    expect(committed.paths).toEqual(live.paths);
    expect(committed.components).toEqual(live.components);
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  async function createProjectWithAgent(name: string) {
    const project = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name, slug: `${name.toLowerCase().replaceAll(" ", "-")}-${Date.now()}` },
    });
    expect(project.statusCode).toBe(200);
    const agent = (
      await db
        .select()
        .from(agentDefs)
        .where(and(eq(agentDefs.projectId, project.json().id), eq(agentDefs.name, "architect")))
        .limit(1)
    )[0];
    expect(agent).toBeTruthy();
    if (!agent) throw new Error("agent fixture missing");
    return { projectId: project.json().id as string, agent };
  }

  it("internal test session resolves /v1/me", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().org.slug).toBe("the-agile-monkeys");
  });

  it("preserves the machine code for an intentionally unconfigured production integration", async () => {
    const response = await app.inject({ method: "GET", url: "/auth/login" });
    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({
      error: {
        code: "auth_unconfigured",
        message: "Login is not configured",
      },
    });
  });

  it("requires an explicit invitation and exact GitHub installation access", async () => {
    const rollback = new Error("rollback github admission test");
    await expect(
      db.transaction(async (tx) => {
        const uninvitedEmail = `uninvited-${Date.now()}@blocked.example`;
        await expect(
          ensureGithubUser(tx as unknown as Parameters<typeof ensureGithubUser>[0], {
            provider: "github",
            githubUserId: `90${Date.now()}`,
            login: "uninvited",
            email: uninvitedEmail,
            emailVerified: true,
            verifiedEmails: [uninvitedEmail],
            installations: [{ installationId: 900001, accountId: 800001 }],
          }),
        ).rejects.toMatchObject({ statusCode: 403, code: "not_invited" });

        const invitedId = newId("user");
        const invitedEmail = `invited-${Date.now()}@example.com`;
        const personalEmail = `personal-${Date.now()}@example.net`;
        const inactiveEmail = `inactive-${Date.now()}@example.net`;
        const installationId = 700_000 + Math.floor(Math.random() * 10_000);
        const accountId = 800_000 + Math.floor(Math.random() * 10_000);
        await tx.insert(users).values([
          { id: invitedId, email: invitedEmail, status: "active" },
          { id: newId("user"), email: inactiveEmail, status: "inactive" },
        ]);
        await tx
          .insert(orgMembers)
          .values({ id: newId("member"), orgId, userId: invitedId, roleId: viewerRole });
        await tx.insert(githubInstallations).values({
          id: newId("int"),
          orgId,
          installationId,
          accountId,
          accountLogin: "facility-test",
          targetType: "Organization",
        });
        await expect(
          ensureGithubUser(tx as unknown as Parameters<typeof ensureGithubUser>[0], {
            provider: "github",
            githubUserId: String(600_000 + Date.now()),
            login: "invited",
            email: personalEmail,
            emailVerified: true,
            verifiedEmails: [personalEmail, inactiveEmail, invitedEmail],
            installations: [{ installationId, accountId: accountId + 1 }],
          }),
        ).rejects.toMatchObject({ statusCode: 403, code: "installation_access_required" });
        expect(
          (await tx.select().from(userIdentities).where(eq(userIdentities.userId, invitedId)))
            .length,
        ).toBe(0);
        const admitted = await ensureGithubUser(
          tx as unknown as Parameters<typeof ensureGithubUser>[0],
          {
            provider: "github",
            githubUserId: String(600_000 + Date.now()),
            login: "invited",
            email: personalEmail,
            emailVerified: true,
            verifiedEmails: [personalEmail, inactiveEmail, invitedEmail],
            installations: [{ installationId, accountId }],
          },
        );
        expect(admitted.orgId).toBe(orgId);
        expect(
          (await tx.select().from(userIdentities).where(eq(userIdentities.userId, invitedId)))
            .length,
        ).toBe(1);
        expect(
          (await tx.select().from(users).where(eq(users.id, invitedId)).limit(1))[0]?.email,
        ).toBe(invitedEmail);

        const ambiguousEmail = `ambiguous-${Date.now()}@example.com`;
        await tx.insert(users).values([
          { id: newId("user"), email: ambiguousEmail, status: "active" },
          { id: newId("user"), email: ambiguousEmail.toUpperCase(), status: "active" },
        ]);
        await expect(
          ensureGithubUser(tx as unknown as Parameters<typeof ensureGithubUser>[0], {
            provider: "github",
            githubUserId: String(700_000 + Date.now()),
            login: "ambiguous",
            email: ambiguousEmail,
            emailVerified: true,
            verifiedEmails: [ambiguousEmail],
            installations: [{ installationId, accountId }],
          }),
        ).rejects.toMatchObject({ statusCode: 403, code: "identity_conflict" });
        throw rollback;
      }),
    ).rejects.toThrow(rollback.message);
  });

  it("rolls back GitHub identity binding when profile synchronization fails", async () => {
    const rollback = new Error("rollback github identity atomicity test");
    await expect(
      db.transaction(async (tx) => {
        const invitedId = newId("user");
        const invitedEmail = `atomic-${Date.now()}@example.com`;
        const providerSubject = String(800_000 + Date.now());
        const installationId = 900_000 + Math.floor(Math.random() * 10_000);
        const accountId = 910_000 + Math.floor(Math.random() * 10_000);
        await tx.insert(users).values({ id: invitedId, email: invitedEmail, status: "active" });
        await tx
          .insert(orgMembers)
          .values({ id: newId("member"), orgId, userId: invitedId, roleId: viewerRole });
        await tx.insert(githubInstallations).values({
          id: newId("int"),
          orgId,
          installationId,
          accountId,
          accountLogin: "facility-atomicity-test",
          targetType: "Organization",
        });
        await tx.execute(sql`select set_config('facility.test_fail_user_id', ${invitedId}, true)`);
        await tx.execute(sql`
          create or replace function pg_temp.fail_facility_profile_sync()
          returns trigger
          language plpgsql
          as $$
          begin
            if new.id = current_setting('facility.test_fail_user_id', true) then
              raise exception 'forced profile sync failure';
            end if;
            return new;
          end;
          $$
        `);
        await tx.execute(sql`
          create trigger fail_facility_profile_sync
          before update on users
          for each row execute function pg_temp.fail_facility_profile_sync()
        `);

        await expect(
          ensureGithubUser(tx as unknown as Parameters<typeof ensureGithubUser>[0], {
            provider: "github",
            githubUserId: providerSubject,
            login: "atomicity-test",
            email: invitedEmail,
            emailVerified: true,
            verifiedEmails: [invitedEmail],
            installations: [{ installationId, accountId }],
          }),
        ).rejects.toThrow();
        expect(
          await tx
            .select()
            .from(userIdentities)
            .where(eq(userIdentities.providerSubject, providerSubject)),
        ).toHaveLength(0);
        throw rollback;
      }),
    ).rejects.toThrow(rollback.message);
  });

  it("denies viewer key project mutation with needed permission", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "viewer", roleId: viewerRole },
    });
    const secret = issued.json().secret;
    const denied = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${secret}` },
      payload: { name: "Denied", slug: `denied-${Date.now()}` },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.details.needed).toBe("projects:write");
  });

  it("issues, uses, and revokes an API key", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "owner", roleId: ownerRole },
    });
    expect(issued.json().secret).toMatch(/^fak_/);
    const secret = issued.json().secret;
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(me.statusCode).toBe(200);
    await app.inject({
      method: "DELETE",
      url: `/v1/keys/${issued.json().id}`,
      headers: { cookie },
    });
    const revoked = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(revoked.statusCode).toBe(401);
  });

  it("performs project CRUD", async () => {
    const slug = `project-${Date.now()}`;
    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Project", slug },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().builderPlanPolicy).toBe("optional");
    projectId = created.json().id;
    const projectSpaces = await db
      .select()
      .from(kbSpaces)
      .where(and(eq(kbSpaces.orgId, orgId), eq(kbSpaces.projectId, projectId)));
    expect(projectSpaces).toHaveLength(1);
    expect(await validateProjectKb(db, orgId, projectId)).toMatchObject({
      ok: true,
      errors: [],
    });
    const projectAgents = await db
      .select({ name: agentDefs.name, sandboxProfileId: agentDefs.sandboxProfileId })
      .from(agentDefs)
      .where(and(eq(agentDefs.orgId, orgId), eq(agentDefs.projectId, projectId)));
    const profileByAgent = new Map(
      projectAgents.map((agent) => [agent.name, agent.sandboxProfileId]),
    );
    for (const name of ["architect", "codex-architect", "review", "security-sweep"]) {
      expect(profileByAgent.get(name), name).toBe(analysisSandboxProfileId(orgId));
    }
    for (const name of ["builder", "codex-builder", "address-review", "ci-doctor"]) {
      expect(profileByAgent.get(name), name).toBe(builderSandboxProfileId(orgId));
    }
    for (const name of ["project-owner", "learning"]) {
      expect(profileByAgent.get(name), name).toBe(defaultSandboxProfileId(orgId));
    }
    const analysisProfile = (
      await db
        .select()
        .from(sandboxProfiles)
        .where(eq(sandboxProfiles.id, analysisSandboxProfileId(orgId)))
        .limit(1)
    )[0];
    expect(analysisProfile?.setup).toMatchObject({
      nested_docker: false,
      provisioning: "deps_only",
    });
    const builderProfile = (
      await db
        .select()
        .from(sandboxProfiles)
        .where(eq(sandboxProfiles.id, builderSandboxProfileId(orgId)))
        .limit(1)
    )[0];
    expect(builderProfile?.setup).toMatchObject({
      nested_docker: true,
      provisioning: "deps_only",
    });
    let listedProject = false;
    for (let offset = 0; !listedProject; offset += 100) {
      const listed = await app.inject({
        method: "GET",
        url: `/v1/projects?limit=100&offset=${offset}`,
        headers: { cookie },
      });
      const page = listed.json() as Array<{ id: string }>;
      listedProject = page.some((row) => row.id === projectId);
      if (page.length < 100) break;
    }
    expect(listedProject).toBe(true);
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}`,
      headers: { cookie },
      payload: { description: "updated" },
    });
    expect(patched.json().description).toBe("updated");
  });

  it("replays idempotent creates and rejects key reuse with different input", async () => {
    const slug = `idempotent-project-${Date.now()}`;
    const key = `project-create-${Date.now()}`;
    const request = {
      method: "POST" as const,
      url: "/v1/projects",
      headers: { cookie, "idempotency-key": key },
      payload: { name: "Idempotent Project", slug },
    };
    const created = await app.inject(request);
    expect(created.statusCode).toBe(200);
    expect(created.headers["idempotency-status"]).toBe("created");
    const replayed = await app.inject(request);
    expect(replayed.statusCode).toBe(200);
    expect(replayed.headers["idempotency-status"]).toBe("replayed");
    expect(replayed.json()).toEqual(created.json());
    expect(await db.select().from(projects).where(eq(projects.slug, slug))).toHaveLength(1);

    const reused = await app.inject({
      ...request,
      payload: { name: "Different Project", slug: `${slug}-different` },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe("idempotency_key_reused");

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Duplicate Slug", slug },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("conflict");
  });

  it("replays one-time API-key secrets without creating duplicate credentials", async () => {
    const name = `idempotent-secret-${Date.now()}`;
    const idempotencyKey = `key-create-${Date.now()}`;
    const request = {
      method: "POST" as const,
      url: "/v1/keys",
      headers: { cookie, "idempotency-key": idempotencyKey },
      payload: { name, roleId: viewerRole },
    };
    const created = await app.inject(request);
    const replayed = await app.inject(request);

    expect(created.statusCode).toBe(200);
    expect(created.json().secret).toMatch(/^fak_/);
    expect(replayed.statusCode).toBe(200);
    expect(replayed.headers["idempotency-status"]).toBe("replayed");
    expect(replayed.json()).toEqual(created.json());
    const listed = await app.inject({ method: "GET", url: "/v1/keys", headers: { cookie } });
    expect(listed.json().filter((key: { name: string }) => key.name === name)).toHaveLength(1);
  });

  it("publishes registry drafts and keeps active content immutable", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/registry/items",
      headers: { cookie },
      payload: { scope: "org", kind: "skill", name: `skill-${Date.now()}`, content: "v1" },
    });
    const version = created.json().versions[0];
    const published = await app.inject({
      method: "POST",
      url: `/v1/registry/versions/${version.id}/publish`,
      headers: { cookie },
    });
    expect(published.statusCode).toBe(200);
    const republish = await app.inject({
      method: "POST",
      url: `/v1/registry/versions/${version.id}/publish`,
      headers: { cookie },
    });
    expect(republish.statusCode).toBe(400);
    const row = (
      await db.select().from(registryVersions).where(eq(registryVersions.id, version.id)).limit(1)
    )[0];
    expect(row?.content).toBe("v1");
  });

  it("publishing a new version deprecates the prior active version of the item", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/registry/items",
      headers: { cookie },
      payload: { scope: "org", kind: "skill", name: `supersede-${Date.now()}`, content: "v1" },
    });
    const itemId = created.json().id;
    const v1 = created.json().versions[0];
    await app.inject({
      method: "POST",
      url: `/v1/registry/versions/${v1.id}/publish`,
      headers: { cookie },
    });
    const v2 = (
      await app.inject({
        method: "POST",
        url: `/v1/registry/items/${itemId}/versions`,
        headers: { cookie },
        payload: { content: "v2" },
      })
    ).json();
    const pub2 = await app.inject({
      method: "POST",
      url: `/v1/registry/versions/${v2.id}/publish`,
      headers: { cookie },
    });
    expect(pub2.statusCode).toBe(200);
    // The item now has exactly one active version (v2); v1 was superseded.
    const [v1row] = await db.select().from(registryVersions).where(eq(registryVersions.id, v1.id));
    const [v2row] = await db.select().from(registryVersions).where(eq(registryVersions.id, v2.id));
    expect(v1row?.status).toBe("deprecated");
    expect(v2row?.status).toBe("active");
  });

  it("rejects unsafe BYO provider base URLs on write", async () => {
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: { cookie },
      payload: {
        provider: "anthropic",
        name: `metadata-${Date.now()}`,
        baseUrl: "https://169.254.169.254/latest/meta-data",
        secret: "secret",
      },
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe("invalid_provider_base_url");

    const allowed = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: { cookie },
      payload: {
        provider: "openai",
        name: `openai-${Date.now()}`,
        baseUrl: "http://localhost:4411/v1",
        secret: "secret",
      },
    });
    expect(allowed.statusCode).toBe(200);
    await db.delete(providerCredentials).where(eq(providerCredentials.id, allowed.json().id));
  });

  it("stores a normalized Claude Code OAuth token without returning it", async () => {
    const token = "sk-ant-oat01-platform-integration-token";
    const created = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: { cookie },
      payload: {
        provider: "anthropic",
        name: `claude-subscription-${Date.now()}`,
        authMode: "oauth",
        secret: `export CLAUDE_CODE_OAUTH_TOKEN="${token}"`,
      },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ provider: "anthropic", authMode: "oauth" });
    expect(created.json()).not.toHaveProperty("secret");

    const [stored] = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.id, created.json().id));
    expect(stored?.authMode).toBe("oauth");
    expect(await open(stored?.sealedSecret ?? "", masterKey)).toBe(token);

    const listed = await app.inject({ method: "GET", url: "/v1/providers", headers: { cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toContainEqual(
      expect.objectContaining({ id: created.json().id, authMode: "oauth" }),
    );

    await db.delete(providerCredentials).where(eq(providerCredentials.id, created.json().id));
  });

  it.each([
    {
      name: "non-Anthropic provider",
      payload: { provider: "openai", authMode: "oauth", secret: "sk-ant-oat01-valid-looking" },
      code: "oauth_provider_unsupported",
    },
    {
      name: "custom upstream URL",
      payload: {
        provider: "anthropic",
        authMode: "oauth",
        baseUrl: "https://api.anthropic.com/v1",
        secret: "sk-ant-oat01-valid-looking",
      },
      code: "oauth_base_url_forbidden",
    },
    {
      name: "multiline token",
      payload: {
        provider: "anthropic",
        authMode: "oauth",
        secret: "sk-ant-oat01-valid-looking\ninjected",
      },
      code: "invalid_provider_secret",
    },
  ])("rejects Claude Code OAuth for a $name", async ({ payload, code }) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: { cookie },
      payload: { name: `oauth-denied-${Date.now()}-${Math.random()}`, ...payload },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe(code);
  });

  it("requires a resolved agent before enqueuing a run", async () => {
    const target = await createProjectWithAgent("Run Resolution");
    const before = (await db.select().from(runs).where(eq(runs.projectId, target.projectId)))
      .length;
    const dispatched: { queue: string; data: Record<string, unknown> }[] = [];
    const originalEnqueue = app.enqueue;
    app.enqueue = async (queue: string, data: Record<string, unknown>) => {
      dispatched.push({ queue, data });
      return `job_${dispatched.length}`;
    };
    try {
      const absent = await app.inject({
        method: "POST",
        url: `/v1/projects/${target.projectId}/runs`,
        headers: { cookie },
        payload: { mode: "builder", engine: "codex" },
      });
      expect(absent.statusCode).toBe(400);
      expect(absent.json().error.code).toBe("agent_required");

      const unknown = await app.inject({
        method: "POST",
        url: `/v1/projects/${target.projectId}/runs`,
        headers: { cookie },
        payload: {
          mode: "builder",
          engine: "codex",
          trigger: { agentName: "missing-agent" },
        },
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().error.code).toBe("agent_required");
      expect(dispatched).toHaveLength(0);
      expect(await db.select().from(runs).where(eq(runs.projectId, target.projectId))).toHaveLength(
        before,
      );

      const run = await app.inject({
        method: "POST",
        url: `/v1/projects/${target.projectId}/runs`,
        headers: { cookie },
        payload: {
          mode: "builder",
          engine: "codex",
          trigger: { agentName: target.agent.name, message: "Exercise agent resolution" },
        },
      });
      expect(run.statusCode).toBe(200);
      expect(run.json().agentDefId).toBe(target.agent.id);
      expect(dispatched).toEqual([
        { queue: "runs.dispatch", data: { runId: run.json().id, orgId } },
      ]);

      const runById = await app.inject({
        method: "POST",
        url: `/v1/projects/${target.projectId}/runs`,
        headers: { cookie },
        payload: {
          mode: "builder",
          engine: "codex",
          agentDefId: target.agent.id,
          trigger: { message: "Exercise id-based agent resolution" },
        },
      });
      expect(runById.statusCode).toBe(200);
      expect(runById.json().agentDefId).toBe(target.agent.id);
      expect(dispatched).toHaveLength(2);

      const events = await app.inject({
        method: "GET",
        url: `/v1/runs/${run.json().id}/events`,
        headers: { cookie },
      });
      expect(events.json()[0].type).toBe("queued");
      await db.insert(runEvents).values(
        Array.from({ length: 129 }, (_, index) => ({
          orgId,
          runId: run.json().id,
          seq: index + 2,
          type: "fixture",
          data: { index },
        })),
      );
      const tail = await app.inject({
        method: "GET",
        url: `/v1/runs/${run.json().id}/events?tail=3`,
        headers: { cookie },
      });
      expect(tail.statusCode).toBe(200);
      expect(tail.json().map((event: { seq: number }) => event.seq)).toEqual([128, 129, 130]);
      const stream = await app.inject({
        method: "GET",
        url: `/v1/runs/${run.json().id}/stream?idleMs=50`,
        headers: { cookie },
      });
      expect(stream.body).toContain("event: heartbeat");
      expect(stream.body).toContain("id: 130\nevent: run_event");
    } finally {
      app.enqueue = originalEnqueue;
    }
  });

  it("rejects cross-org project IDs on key, budget, and registry writes", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const foreignOrgId = newId("org");
    const foreignProjectId = newId("proj");
    await db.insert(orgs).values({
      id: foreignOrgId,
      name: "Foreign Org",
      slug: `foreign-${suffix}`,
      settings: {},
    });
    await db.insert(projects).values({
      id: foreignProjectId,
      orgId: foreignOrgId,
      name: "Foreign Project",
      slug: `foreign-project-${suffix}`,
      settings: {},
    });
    const foreignRole = (
      await db
        .insert(roles)
        .values({
          id: newId("key"),
          orgId: foreignOrgId,
          name: `foreign-role-${suffix}`,
          permissions: ["org:read"],
        })
        .returning()
    )[0];

    const rolePatch = await app.inject({
      method: "PATCH",
      url: `/v1/roles/${foreignRole?.id}`,
      headers: { cookie },
      payload: { description: "cross-tenant mutation" },
    });
    expect(rolePatch.statusCode).toBe(404);
    const roleDelete = await app.inject({
      method: "DELETE",
      url: `/v1/roles/${foreignRole?.id}`,
      headers: { cookie },
    });
    expect(roleDelete.statusCode).toBe(200);
    expect(
      (
        await db
          .select()
          .from(roles)
          .where(eq(roles.id, foreignRole?.id ?? ""))
      ).length,
    ).toBe(1);

    const key = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: `foreign-key-${suffix}`, roleId: ownerRole, projectId: foreignProjectId },
    });
    expect(key.statusCode).toBe(400);
    expect(key.json().error.code).toBe("project_not_in_org");

    const budget = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { cookie },
      payload: {
        scope: "project",
        projectId: foreignProjectId,
        period: "daily",
        limitCents: 100,
        mode: "hard",
      },
    });
    expect(budget.statusCode).toBe(400);
    expect(budget.json().error.code).toBe("project_not_in_org");

    const registry = await app.inject({
      method: "POST",
      url: "/v1/registry/items",
      headers: { cookie },
      payload: {
        scope: "project",
        projectId: foreignProjectId,
        kind: "skill",
        name: `foreign-skill-${suffix}`,
        content: "body",
      },
    });
    expect(registry.statusCode).toBe(400);
    expect(registry.json().error.code).toBe("project_not_in_org");

    const sameOrgKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: `same-org-key-${suffix}`, roleId: ownerRole, projectId },
    });
    expect(sameOrgKey.statusCode).toBe(200);
  });

  it("forbids a project-scoped principal from creating an org-wide budget and rejects bad enums", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const projectKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: `proj-budget-key-${suffix}`, roleId: ownerRole, projectId },
    });
    expect(projectKey.statusCode).toBe(200);
    // A project-scoped principal must not create an org-wide budget (it would cap
    // the whole org's spend, since the gateway ignores projectId for org budgets).
    const orgBudget = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { authorization: `Bearer ${projectKey.json().secret}` },
      payload: { scope: "org", period: "monthly", limitCents: 1000, mode: "hard" },
    });
    expect(orgBudget.statusCode).toBe(403);
    expect(orgBudget.json().error.code).toBe("forbidden_budget_scope");
    // Unenforceable enum values are rejected up front, not silently stored.
    const badMode = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { cookie },
      payload: { scope: "org", period: "monthly", limitCents: 1000, mode: "medium" },
    });
    expect(badMode.statusCode).toBe(400);
    const badPeriod = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { cookie },
      payload: { scope: "org", period: "hourly", limitCents: 1000, mode: "hard" },
    });
    expect(badPeriod.statusCode).toBe(400);
    // PATCH must not be a back door: a project principal cannot widen an existing
    // budget to org scope, and bad enums are rejected there too.
    const projectBudget = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { authorization: `Bearer ${projectKey.json().secret}` },
      payload: { scope: "project", period: "monthly", limitCents: 500, mode: "soft" },
    });
    expect(projectBudget.statusCode).toBe(200);
    const widen = await app.inject({
      method: "PATCH",
      url: `/v1/budgets/${projectBudget.json().id}`,
      headers: { authorization: `Bearer ${projectKey.json().secret}` },
      payload: { scope: "org" },
    });
    expect(widen.statusCode).toBe(403);
    expect(widen.json().error.code).toBe("forbidden_budget_scope");
    const patchBadMode = await app.inject({
      method: "PATCH",
      url: `/v1/budgets/${projectBudget.json().id}`,
      headers: { authorization: `Bearer ${projectKey.json().secret}` },
      payload: { mode: "medium" },
    });
    expect(patchBadMode.statusCode).toBe(400);

    // Scope coherence: agent budgets need an agent def; project/agent budgets need
    // a project; and widening a project budget to org (by an org principal) nulls
    // the project so it becomes a true org-wide budget.
    const agentNoAgent = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { cookie },
      payload: { scope: "agent_def", projectId, period: "daily", limitCents: 10, mode: "hard" },
    });
    expect(agentNoAgent.statusCode).toBe(400);
    expect(agentNoAgent.json().error.code).toBe("budget_agent_required");
    const projectNoProject = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { cookie },
      payload: { scope: "project", period: "daily", limitCents: 10, mode: "hard" },
    });
    expect(projectNoProject.statusCode).toBe(400);
    expect(projectNoProject.json().error.code).toBe("budget_project_required");
    const orgOwned = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { cookie },
      payload: { scope: "project", projectId, period: "daily", limitCents: 10, mode: "hard" },
    });
    expect(orgOwned.statusCode).toBe(200);
    const widened = await app.inject({
      method: "PATCH",
      url: `/v1/budgets/${orgOwned.json().id}`,
      headers: { cookie },
      payload: { scope: "org" },
    });
    expect(widened.statusCode).toBe(200);
    expect(widened.json().scope).toBe("org");
    expect(widened.json().projectId).toBeNull();

    // Relational coherence: an agent budget must name an agent def that lives in
    // the budget's project — a foreign/unknown agent id is rejected.
    const agentForeign = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { cookie },
      payload: {
        scope: "agent_def",
        projectId,
        agentDefId: newId("agent"),
        period: "daily",
        limitCents: 10,
        mode: "hard",
      },
    });
    expect(agentForeign.statusCode).toBe(400);
    expect(agentForeign.json().error.code).toBe("agent_not_in_project");
  });

  it("rejects agent references outside the agent project", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const projectA = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Agent Ref A",
          slug: `agent-ref-a-${suffix}`,
          settings: {},
        })
        .returning()
    )[0];
    const projectB = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Agent Ref B",
          slug: `agent-ref-b-${suffix}`,
          settings: {},
        })
        .returning()
    )[0];
    if (!projectA || !projectB) throw new Error("project setup failed");
    const contractA = (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId: projectA.id,
          kind: "contract",
          name: `contract-a-${suffix}`,
        })
        .returning()
    )[0];
    const contractB = (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId: projectB.id,
          kind: "contract",
          name: `contract-b-${suffix}`,
        })
        .returning()
    )[0];
    const sandboxA = (
      await db
        .insert(sandboxProfiles)
        .values({
          id: newId("sbx"),
          orgId,
          projectId: projectA.id,
          name: `sandbox-a-${suffix}`,
          driver: "docker",
          image: "node:22",
        })
        .returning()
    )[0];
    const sandboxB = (
      await db
        .insert(sandboxProfiles)
        .values({
          id: newId("sbx"),
          orgId,
          projectId: projectB.id,
          name: `sandbox-b-${suffix}`,
          driver: "docker",
          image: "node:22",
        })
        .returning()
    )[0];
    if (!contractA || !contractB || !sandboxA || !sandboxB) throw new Error("agent setup failed");

    const crossContract = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectA.id}/agents`,
      headers: { cookie },
      payload: {
        name: `cross-contract-${suffix}`,
        engine: "codex",
        model: {},
        contractItemId: contractB.id,
      },
    });
    expect(crossContract.statusCode).toBe(400);
    expect(crossContract.json().error.code).toBe("reference_not_in_project");

    const created = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectA.id}/agents`,
      headers: { cookie },
      payload: {
        name: `agent-ok-${suffix}`,
        engine: "codex",
        model: {},
        contractItemId: contractA.id,
        sandboxProfileId: sandboxA.id,
      },
    });
    expect(created.statusCode).toBe(200);

    const invalidSchedule = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectA.id}/agents/${created.json().id}`,
      headers: { cookie },
      payload: { triggers: [{ type: "schedule", config: { cron: "not a cron" } }] },
    });
    expect(invalidSchedule.statusCode).toBe(400);
    expect(invalidSchedule.json().error.code).toBe("invalid_schedule");

    const crossSandbox = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectA.id}/agents/${created.json().id}`,
      headers: { cookie },
      payload: { sandboxProfileId: sandboxB.id },
    });
    expect(crossSandbox.statusCode).toBe(400);
    expect(crossSandbox.json().error.code).toBe("reference_not_in_project");
  });

  it("returns org-wide paginated runs with project metadata", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const projectA = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Runs Page A",
          slug: `runs-page-a-${suffix}`,
          settings: {},
        })
        .returning()
    )[0];
    const projectB = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Runs Page B",
          slug: `runs-page-b-${suffix}`,
          settings: {},
        })
        .returning()
    )[0];
    if (!projectA || !projectB) throw new Error("project setup failed");
    const oldRunId = newId("run");
    const newRunId = newId("run");
    const status = `runs_page_${suffix.replace(/[^a-z0-9]/g, "_")}`;
    await db.insert(runs).values([
      {
        id: oldRunId,
        orgId,
        projectId: projectA.id,
        mode: "builder",
        engine: "codex",
        status,
        queuedAt: new Date("2999-01-01T00:00:00Z"),
        createdBy: { type: "test", id: "api" },
      },
      {
        id: newRunId,
        orgId,
        projectId: projectB.id,
        mode: "builder",
        engine: "codex",
        status,
        queuedAt: new Date("2999-01-02T00:00:00Z"),
        createdBy: { type: "test", id: "api" },
      },
    ]);
    const page = await app.inject({
      method: "GET",
      url: `/v1/runs?status=${status}&limit=1&offset=0`,
      headers: { cookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toHaveLength(1);
    expect(page.json()[0]).toMatchObject({
      id: newRunId,
      project: { id: projectB.id, name: projectB.name, slug: projectB.slug },
    });
    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/runs?status=${status}&limit=1&offset=1`,
      headers: { cookie },
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json()[0]?.id).toBe(oldRunId);
  });

  it("validates HITL payloads and appends decision ledger events", async () => {
    const type = (
      await db
        .insert(actionTypes)
        .values({
          id: newId("act"),
          orgId,
          name: `test_action_${Date.now()}`,
          payloadSchema: { type: "object", required: ["answer"] },
          resolver: { type: "permission", config: {} },
          executor: { type: "none", config: {} },
          defaultTtlHours: 1,
        })
        .returning()
    )[0];
    const bad = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { cookie },
      payload: { actionTypeId: type?.id, payload: {}, contextMd: "ctx" },
    });
    expect(bad.statusCode).toBe(400);
    const proposal = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { cookie },
      payload: { actionTypeId: type?.id, payload: { answer: true }, contextMd: "ctx" },
    });
    const decided = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposal.json().id}/decide`,
      headers: { cookie: approverCookie },
      payload: { decision: "approve", note: "ok" },
    });
    expect(decided.json().state).toBe("approved");
    const loaded = await app.inject({
      method: "GET",
      url: `/v1/proposals/${proposal.json().id}`,
      headers: { cookie },
    });
    expect(loaded.json().events.map((event: { seq: number }) => event.seq)).toEqual([1, 2]);
  });

  it("records the assistant agent as requester so its own user can approve", async () => {
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    const principalMe = me.json().principal as { type: string; id: string };
    const type = (
      await db
        .insert(actionTypes)
        .values({
          id: newId("act"),
          orgId,
          name: `agent_opened_${Date.now()}`,
          payloadSchema: { type: "object", required: [] },
          resolver: { type: "permission", config: {} },
          executor: { type: "none", config: {} },
          defaultTtlHours: 1,
        })
        .returning()
    )[0];
    const assistantRun = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId,
          mode: "assistant",
          engine: "inline",
          status: "running",
          trigger: { type: "conversation" },
          createdBy: { type: principalMe.type, id: principalMe.id },
        })
        .returning()
    )[0];
    if (!assistantRun) throw new Error("run fixture failed");
    const token = registerAssistantTurn(assistantRun.id);

    // Valid in-process binding → the AGENT is the requester; the same human
    // who drove the assistant may approve (dual control = human ≠ agent).
    const agentOpened = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: {
        cookie,
        "x-facility-assistant-run": assistantRun.id,
        "x-facility-assistant-token": token,
      },
      payload: { projectId, actionTypeId: type?.id, payload: {}, contextMd: "agent-opened" },
    });
    expect(agentOpened.statusCode, agentOpened.body).toBe(200);
    const loaded = await app.inject({
      method: "GET",
      url: `/v1/proposals/${agentOpened.json().id}`,
      headers: { cookie },
    });
    const openEvent = loaded.json().events[0];
    expect(openEvent.actor).toEqual({ type: "agent", id: assistantRun.id });
    expect(openEvent.data.onBehalfOf).toEqual({ type: principalMe.type, id: principalMe.id });
    const selfDecide = await app.inject({
      method: "POST",
      url: `/v1/proposals/${agentOpened.json().id}/decide`,
      headers: { cookie },
      payload: { decision: "approve" },
    });
    expect(selfDecide.statusCode, selfDecide.body).toBe(200);

    // Fails closed: a wrong token records the human as requester, and
    // self-approval keeps today's 403.
    const badToken = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: {
        cookie,
        "x-facility-assistant-run": assistantRun.id,
        "x-facility-assistant-token": "forged",
      },
      payload: { projectId, actionTypeId: type?.id, payload: {}, contextMd: "forged-token" },
    });
    expect(badToken.statusCode).toBe(200);
    const denied = await app.inject({
      method: "POST",
      url: `/v1/proposals/${badToken.json().id}/decide`,
      headers: { cookie },
      payload: { decision: "approve" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("same_principal_approval_denied");
    releaseAssistantTurn(assistantRun.id);
  });

  it("resolves issue_update proposals by action-type name and dispatches the executor", async () => {
    // By NAME with lazy ensure — no seeded row required, no id round-trip.
    const proposed = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { cookie },
      payload: {
        projectId,
        actionType: "issue_update",
        payload: { issueNumber: 7, title: "Sharper title", bodyMd: "New body." },
        contextMd: "Issue update proposal for #7: scope refined per S004",
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(200);
    expect(proposed.json().actionType).toBe("issue_update");
    const decided = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposed.json().id}/decide`,
      headers: { cookie: approverCookie },
      payload: { decision: "approve" },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    // The executor branch ran (not unsupported_action_type): with no GitHub
    // repo configured in this suite it fails at the repo lookup, honestly.
    expect(decided.json().state).toBe("execution_failed");
    const loaded = await app.inject({
      method: "GET",
      url: `/v1/proposals/${proposed.json().id}`,
      headers: { cookie },
    });
    const failure = loaded
      .json()
      .events.find((event: { type: string }) => event.type === "execution_failed");
    expect(failure?.data?.error).toContain("issue_update_missing_repo");
  });

  it("activates a learned skill only after a separate human approves it", async () => {
    const skillAction = (
      await db
        .select()
        .from(actionTypes)
        .where(and(eq(actionTypes.orgId, orgId), eq(actionTypes.name, "skill_proposal")))
        .limit(1)
    )[0];
    if (!skillAction) throw new Error("skill proposal action missing");
    const name = `review-invariant-${Date.now()}`;
    const proposed = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { cookie },
      payload: {
        projectId,
        actionTypeId: skillAction.id,
        payload: {
          name,
          content: "Always preserve an existing failing regression test as evidence.",
          evidence_refs: ["github://theam/facility/pull/1#discussion_r1"],
        },
        contextMd: "Observed across three rejected changes.",
      },
    });
    expect(proposed.statusCode).toBe(200);
    expect(proposed.json().state).toBe("open");
    expect(
      await db
        .select()
        .from(registryItems)
        .where(and(eq(registryItems.orgId, orgId), eq(registryItems.name, name))),
    ).toHaveLength(0);

    const approved = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposed.json().id}/decide`,
      headers: { cookie: approverCookie },
      payload: { decision: "approve" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().state).toBe("executed");
    const item = (
      await db
        .select()
        .from(registryItems)
        .where(
          and(
            eq(registryItems.orgId, orgId),
            eq(registryItems.projectId, projectId),
            eq(registryItems.kind, "skill"),
            eq(registryItems.name, name),
          ),
        )
        .limit(1)
    )[0];
    const version = item
      ? (
          await db
            .select()
            .from(registryVersions)
            .where(eq(registryVersions.itemId, item.id))
            .limit(1)
        )[0]
      : null;
    expect(item?.latestVersion).toBe(1);
    expect(version).toMatchObject({ status: "active", version: 1 });
  });

  it("turns an approved guard candidate into a task for the architect/builder loop", async () => {
    const suffix = Date.now();
    const guardProject = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Learned guard", slug: `learned-guard-${suffix}` },
    });
    const installation = (
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId,
          installationId: Math.floor(Math.random() * 2_000_000_000) + 1,
          accountLogin: `learned-guard-${suffix}`,
          targetType: "Organization",
        })
        .returning()
    )[0];
    await db.insert(repos).values({
      id: newId("repo"),
      orgId,
      projectId: guardProject.json().id,
      installationId: installation?.id,
      owner: `learned-guard-${suffix}`,
      name: "repo",
      defaultBranch: "main",
    });
    const guardAction = (
      await db
        .select()
        .from(actionTypes)
        .where(and(eq(actionTypes.orgId, orgId), eq(actionTypes.name, "guard_candidate")))
        .limit(1)
    )[0];
    if (!guardAction) throw new Error("guard candidate action missing");
    const proposed = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { cookie },
      payload: {
        projectId: guardProject.json().id,
        actionTypeId: guardAction.id,
        payload: {
          title: "No skipped delivery checks",
          content: "```js\nexport default { run() { return []; } };\n```",
          evidence_refs: ["receipt://run_failed/checks"],
        },
        contextMd: "A skipped check repeatedly produced undeliverable builder runs.",
      },
    });
    const observed: Parameters<typeof fakeGuardGithubFactory>[0] = {};
    const previousFactory = app.githubClientFactory;
    app.githubClientFactory = fakeGuardGithubFactory(observed);
    try {
      const approved = await app.inject({
        method: "POST",
        url: `/v1/proposals/${proposed.json().id}/decide`,
        headers: { cookie: approverCookie },
        payload: { decision: "approve" },
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().state).toBe("executed");
      expect(observed.issue).toMatchObject({
        title: "[Facility learning] No skipped delivery checks",
        labels: ["facility-learning", "type:task"],
      });
      expect(String(observed.issue?.body)).toContain("Run `/architect`");
      expect(String(observed.issue?.body)).toContain("then use `/builder`");
      expect(String(observed.issue?.body)).toContain("facility-learning-fingerprint");
      expect(observed.labels?.map((label) => label.name)).toEqual([
        "facility-learning",
        "type:task",
      ]);
    } finally {
      app.githubClientFactory = previousFactory;
    }
  });

  it("dispatches an approved platform plan to the linked builder", async () => {
    const { projectId: planProjectId, agent: baseAgent } =
      await createProjectWithAgent("Plan Dispatch");
    const repoOwner = `plan-owner-${Date.now()}`;
    const planRepo = (
      await db
        .insert(repos)
        .values({
          id: newId("repo"),
          orgId,
          projectId: planProjectId,
          owner: repoOwner,
          name: "plan-dispatch",
          defaultBranch: "main",
          renderAnswers: {
            execution_lane: {
              architect: "platform",
              builder: "platform",
              "codex-builder": "platform",
            },
          },
          fingerprintStatus: "ok",
          fingerprint: { files: [] },
          fingerprintVerifiedAt: new Date(),
        })
        .returning()
    )[0];
    const builder = (
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId: planProjectId,
          name: "builder",
          engine: baseAgent.engine,
          model: baseAgent.model,
          contractItemId: baseAgent.contractItemId,
          harnessItemId: baseAgent.harnessItemId,
          triggers: [{ type: "command", command: "builder" }],
          sandboxProfileId: baseAgent.sandboxProfileId,
          permissions: baseAgent.permissions,
        })
        .returning()
    )[0];
    const architectRun = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId: planProjectId,
          mode: "codex-architect",
          engine: "codex",
          status: "succeeded",
          trigger: { type: "github_comment", issue: { number: 42 } },
          gh: { owner: repoOwner, repo: "plan-dispatch", issueNumber: 42 },
          createdBy: { type: "user", id: "architect-requester" },
        })
        .returning()
    )[0];
    const planAcceptance = (
      await db
        .select()
        .from(actionTypes)
        .where(and(eq(actionTypes.orgId, orgId), eq(actionTypes.name, "plan_acceptance")))
        .limit(1)
    )[0];
    if (!planRepo || !builder || !architectRun || !planAcceptance) {
      throw new Error("plan fixtures missing");
    }
    const createInternalPlanProposal = async (
      runId: string,
      contextMd: string,
      payload: Record<string, unknown> = {},
    ) => {
      const id = newId("prop");
      await db.insert(proposals).values({
        id,
        orgId,
        projectId: planProjectId,
        runId,
        actionTypeId: planAcceptance.id,
        payload,
        contextMd,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await db.insert(proposalEvents).values({
        orgId,
        proposalId: id,
        seq: 1,
        type: "open",
        actor: { type: "agent", id: runId },
        data: { source: "architect_run" },
      });
      return { statusCode: 200, json: () => ({ id }) };
    };
    await db
      .update(repos)
      .set({ fingerprintStatus: "pending_merge" })
      .where(eq(repos.id, planRepo.id));
    const unverifiedPolicy = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${planProjectId}`,
      headers: { cookie },
      payload: { builderPlanPolicy: "required" },
    });
    expect(unverifiedPolicy.statusCode).toBe(409);
    expect(unverifiedPolicy.json().error.code).toBe("builder_plan_platform_lane_required");
    await db
      .update(repos)
      .set({ fingerprintStatus: "ok", fingerprintVerifiedAt: new Date() })
      .where(eq(repos.id, planRepo.id));
    await db
      .update(agentDefs)
      .set({
        name: "delivery-specialist",
        triggers: [{ type: "command", command: "/builder" }],
      })
      .where(eq(agentDefs.id, builder.id));
    const activeLegacyBuilder = await app.inject({
      method: "POST",
      url: `/v1/projects/${planProjectId}/runs`,
      headers: { cookie },
      payload: {
        agentDefId: builder.id,
        trigger: { type: "manual", message: "Persist the admitted Builder identity" },
      },
    });
    expect(activeLegacyBuilder.statusCode).toBe(200);
    expect(activeLegacyBuilder.json().mode).toBe("builder");
    await db.update(agentDefs).set({ triggers: [] }).where(eq(agentDefs.id, builder.id));
    const activeRunPolicy = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${planProjectId}`,
      headers: { cookie },
      payload: { builderPlanPolicy: "required" },
    });
    expect(activeRunPolicy.statusCode).toBe(409);
    expect(activeRunPolicy.json().error.code).toBe("builder_plan_active_runs_present");
    await db
      .update(runs)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(runs.id, activeLegacyBuilder.json().id));
    const opaqueLegacyRun = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId: planProjectId,
          agentDefId: builder.id,
          mode: "delivery-specialist",
          engine: builder.engine,
          trigger: { type: "manual", source: "pre-immutable-admission" },
          createdBy: { type: "user", id: "legacy-fixture" },
        })
        .returning({ id: runs.id })
    )[0];
    const opaqueLegacyPolicy = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${planProjectId}`,
      headers: { cookie },
      payload: { builderPlanPolicy: "required" },
    });
    expect(opaqueLegacyPolicy.statusCode).toBe(409);
    expect(opaqueLegacyPolicy.json().error.code).toBe("builder_plan_active_runs_present");
    await db
      .update(runs)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(runs.id, opaqueLegacyRun?.id ?? ""));
    await db
      .update(agentDefs)
      .set({ triggers: [{ type: "command", command: "builder" }] })
      .where(eq(agentDefs.id, builder.id));
    const requiredPolicy = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${planProjectId}`,
      headers: { cookie },
      payload: { builderPlanPolicy: "required" },
    });
    expect(requiredPolicy.statusCode).toBe(200);
    expect(requiredPolicy.json().builderPlanPolicy).toBe("required");

    await db
      .update(repos)
      .set({ fingerprintStatus: "pending", fingerprintVerifiedAt: null })
      .where(eq(repos.id, planRepo.id));
    const requiredSettingsDuringDrift = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${planProjectId}`,
      headers: { cookie },
      payload: {
        builderPlanPolicy: "required",
        settings: { gateRegression: "lane-drift" },
      },
    });
    expect(requiredSettingsDuringDrift.statusCode).toBe(200);
    expect(requiredSettingsDuringDrift.json().settings).toEqual({ gateRegression: "lane-drift" });
    await db
      .update(repos)
      .set({ fingerprintStatus: "ok", fingerprintVerifiedAt: new Date() })
      .where(eq(repos.id, planRepo.id));
    const activeRequiredRun = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId: planProjectId,
          mode: "architect",
          engine: "codex",
          trigger: { type: "manual", message: "Keep required settings editable" },
          createdBy: { type: "user", id: "fixture" },
        })
        .returning({ id: runs.id })
    )[0];
    const requiredSettingsWithActiveRun = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${planProjectId}`,
      headers: { cookie },
      payload: {
        builderPlanPolicy: "required",
        settings: { gateRegression: "active-run" },
      },
    });
    expect(requiredSettingsWithActiveRun.statusCode).toBe(200);
    expect(requiredSettingsWithActiveRun.json().settings).toEqual({ gateRegression: "active-run" });
    await db
      .update(runs)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(runs.id, activeRequiredRun?.id ?? ""));

    const beforeDenied = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.orgId, orgId), eq(runs.projectId, planProjectId)));
    const missingPlan = await app.inject({
      method: "POST",
      url: `/v1/projects/${planProjectId}/runs`,
      headers: { cookie },
      payload: {
        agentDefId: builder.id,
        trigger: { type: "manual", message: "Do not bypass Gate 1" },
      },
    });
    expect(missingPlan.statusCode).toBe(409);
    expect(missingPlan.json().error.code).toBe("builder_plan_required");
    const missingPlanAndObjective = await app.inject({
      method: "POST",
      url: `/v1/projects/${planProjectId}/runs`,
      headers: { cookie },
      payload: { agentDefId: builder.id },
    });
    expect(missingPlanAndObjective.statusCode).toBe(409);
    expect(missingPlanAndObjective.json().error.code).toBe("builder_plan_required");
    expect(
      await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.orgId, orgId), eq(runs.projectId, planProjectId))),
    ).toHaveLength(beforeDenied.length);
    const optionalPolicy = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${planProjectId}`,
      headers: { cookie },
      payload: { builderPlanPolicy: "optional" },
    });
    expect(optionalPolicy.statusCode).toBe(200);

    const forgedPlanRun = await app.inject({
      method: "POST",
      url: `/v1/projects/${planProjectId}/runs`,
      headers: { cookie },
      payload: {
        mode: "builder",
        engine: builder.engine,
        agentDefId: builder.id,
        trigger: { source: "plan_acceptance", proposalId: "prop_forged" },
      },
    });
    expect(forgedPlanRun.statusCode).toBe(400);
    expect(forgedPlanRun.json().error.code).toBe("reserved_trigger_source");

    const reservedPlanProposal = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { cookie },
      payload: {
        projectId: planProjectId,
        runId: architectRun.id,
        actionTypeId: planAcceptance.id,
        payload: {},
        contextMd: "Approve the implementation plan",
      },
    });
    expect(reservedPlanProposal.statusCode).toBe(403);
    expect(reservedPlanProposal.json().error.code).toBe("reserved_action_type");
    const reservedNamedPlan = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { cookie },
      payload: {
        projectId: planProjectId,
        runId: architectRun.id,
        actionType: "plan_acceptance",
        payload: {},
        contextMd: "Attempt the reserved action by name",
      },
    });
    expect(reservedNamedPlan.statusCode).toBe(403);
    expect(reservedNamedPlan.json().error.code).toBe("reserved_action_type");
    const proposal = await createInternalPlanProposal(
      architectRun.id,
      "Approve the implementation plan",
    );
    expect(proposal.statusCode).toBe(200);
    const approved = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposal.json().id}/decide`,
      headers: { cookie: approverCookie },
      payload: { decision: "approve" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().state).toBe("executed");

    const builderRuns = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.orgId, orgId),
          eq(runs.projectId, planProjectId),
          eq(runs.mode, "codex-builder"),
          sql`${runs.trigger} @> ${JSON.stringify({
            source: "plan_acceptance",
            proposalId: proposal.json().id,
          })}::jsonb`,
        ),
      );
    expect(builderRuns).toHaveLength(1);
    expect(builderRuns[0]?.mode).toBe("codex-builder");
    const codexBuilder = (
      await db
        .select()
        .from(agentDefs)
        .where(
          and(
            eq(agentDefs.orgId, orgId),
            eq(agentDefs.projectId, planProjectId),
            eq(agentDefs.name, "codex-builder"),
          ),
        )
        .limit(1)
    )[0];
    if (!codexBuilder) throw new Error("codex builder fixture missing");
    expect(builderRuns[0]).toMatchObject({
      agentDefId: codexBuilder.id,
      engine: codexBuilder.engine,
      gh: architectRun.gh,
      trigger: {
        approvedPlan: "Approve the implementation plan",
        architectTrigger: architectRun.trigger,
      },
    });
    const queued = await db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, builderRuns[0]?.id ?? ""));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: "queued",
      data: { source: "plan_acceptance", architectRunId: architectRun.id },
    });

    // Optional projects preserve the legacy resume shape: provenance is used
    // only for the policy preflight and is not copied into the new row, where
    // the plan-acceptance uniqueness indexes would reject it.
    await db
      .update(runs)
      .set({ status: "failed", engine: "claude_code", engineSessionId: "plan-resume-session" })
      .where(eq(runs.id, builderRuns[0]?.id ?? ""));
    const resumedPlanRun = await app.inject({
      method: "POST",
      url: `/v1/runs/${builderRuns[0]?.id}/resume`,
      headers: { cookie },
      payload: { message: "Continue the optional legacy run" },
    });
    expect(resumedPlanRun.statusCode).toBe(200);
    expect(resumedPlanRun.json().trigger).toMatchObject({
      type: "resume",
      resumeOf: builderRuns[0]?.id,
    });
    expect(resumedPlanRun.json().trigger).not.toHaveProperty("source");
    expect(resumedPlanRun.json().trigger).not.toHaveProperty("proposalId");

    const duplicateProposal = await createInternalPlanProposal(
      architectRun.id,
      "A duplicate approval for the same architect plan",
    );
    const duplicateApproval = await app.inject({
      method: "POST",
      url: `/v1/proposals/${duplicateProposal.json().id}/decide`,
      headers: { cookie: approverCookie },
      payload: { decision: "approve" },
    });
    expect(duplicateApproval.statusCode).toBe(200);
    expect(duplicateApproval.json().state).toBe("executed");
    expect(
      await db
        .select()
        .from(runs)
        .where(
          sql`${runs.trigger} @> ${JSON.stringify({
            source: "plan_acceptance",
            architectRunId: architectRun.id,
          })}::jsonb`,
        ),
    ).toHaveLength(1);

    // A retry must reuse the architect-plan-linked run even if the configured
    // builder definition changed after the original dispatch.
    await db.update(agentDefs).set({ enabled: false }).where(eq(agentDefs.id, codexBuilder.id));
    await db.insert(agentDefs).values({
      id: newId("agent"),
      orgId,
      projectId: planProjectId,
      name: "codex-builder",
      engine: codexBuilder.engine,
      model: codexBuilder.model,
      contractItemId: codexBuilder.contractItemId,
      harnessItemId: codexBuilder.harnessItemId,
      triggers: [{ type: "command", command: "codex-builder" }],
      sandboxProfileId: codexBuilder.sandboxProfileId,
      permissions: codexBuilder.permissions,
    });
    await db
      .update(proposals)
      .set({ state: "execution_failed" })
      .where(eq(proposals.id, proposal.json().id));
    const retried = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposal.json().id}/execute`,
      headers: { cookie },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().state).toBe("executed");
    const retriedBuilderRuns = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.orgId, orgId),
          sql`${runs.trigger} @> ${JSON.stringify({
            source: "plan_acceptance",
            proposalId: proposal.json().id,
          })}::jsonb`,
        ),
      );
    expect(retriedBuilderRuns).toHaveLength(1);
    expect(retriedBuilderRuns[0]?.agentDefId).toBe(codexBuilder.id);

    const racedArchitect = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId: planProjectId,
          mode: "codex-architect",
          engine: "codex",
          status: "succeeded",
          trigger: { type: "github_comment", repo: { id: planRepo.id } },
          gh: { owner: repoOwner, repo: planRepo.name, issueNumber: 44 },
          createdBy: { type: "user", id: "architect-requester" },
        })
        .returning()
    )[0];
    if (!racedArchitect) throw new Error("raced Architect fixture missing");
    const racedProposal = await createInternalPlanProposal(
      racedArchitect.id,
      "Reject repository lane drift inside the admission lock",
    );
    const beforeRacedApproval = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        sql`${runs.trigger} @> ${JSON.stringify({
          source: "plan_acceptance",
          proposalId: racedProposal.json().id,
        })}::jsonb`,
      );
    let racedApproval:
      | Promise<{ statusCode: number; body: string; json: () => unknown }>
      | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`builder-plan:${orgId}:${planProjectId}`}, 0))`,
      );
      await tx
        .update(repos)
        .set({ renderAnswers: { execution_lane: { architect: "platform", builder: "repo" } } })
        .where(eq(repos.id, planRepo.id));
      racedApproval = app.inject({
        method: "POST",
        url: `/v1/proposals/${racedProposal.json().id}/decide`,
        headers: { cookie: approverCookie },
        payload: { decision: "approve" },
      });
      let executing = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const candidate = (
          await db
            .select({ state: proposals.state })
            .from(proposals)
            .where(eq(proposals.id, racedProposal.json().id))
            .limit(1)
        )[0];
        if (candidate?.state === "executing") {
          executing = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(executing).toBe(true);
    });
    if (!racedApproval) throw new Error("raced approval did not start");
    const racedResult = await racedApproval;
    expect(racedResult.statusCode, racedResult.body).toBe(200);
    expect(racedResult.json()).toMatchObject({
      state: "execution_failed",
      executionError: "plan_acceptance_builder_uses_repo_lane",
    });
    expect(
      await db
        .select({ id: runs.id })
        .from(runs)
        .where(
          sql`${runs.trigger} @> ${JSON.stringify({
            source: "plan_acceptance",
            proposalId: racedProposal.json().id,
          })}::jsonb`,
        ),
    ).toHaveLength(beforeRacedApproval.length);

    await db
      .update(repos)
      .set({ renderAnswers: { execution_lane: { architect: "platform", builder: "repo" } } })
      .where(eq(repos.id, planRepo.id));
    const repoLaneArchitect = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId: planProjectId,
          mode: "architect",
          engine: "codex",
          status: "succeeded",
          trigger: { type: "github_comment", repo: { id: planRepo.id } },
          gh: { owner: repoOwner, repo: planRepo.name, issueNumber: 43 },
          createdBy: { type: "user", id: "architect-requester" },
        })
        .returning()
    )[0];
    if (!repoLaneArchitect) throw new Error("repo-lane architect fixture missing");
    const repoLaneProposal = await createInternalPlanProposal(
      repoLaneArchitect.id,
      "Repo lane must still require /builder",
    );
    const repoLaneApproval = await app.inject({
      method: "POST",
      url: `/v1/proposals/${repoLaneProposal.json().id}/decide`,
      headers: { cookie: approverCookie },
      payload: { decision: "approve" },
    });
    expect(repoLaneApproval.json().state).toBe("execution_failed");
    expect(repoLaneApproval.json().executionError).toBe("plan_acceptance_builder_uses_repo_lane");
    const repoLaneEvents = await db
      .select()
      .from(proposalEvents)
      .where(eq(proposalEvents.proposalId, repoLaneProposal.json().id));
    expect(repoLaneEvents.find((event) => event.type === "execution_failed")?.data).toMatchObject({
      error: "plan_acceptance_builder_uses_repo_lane",
    });
  });

  it("refuses an mcp_tool_call proposal on the generic route (per-tool perm bypass)", async () => {
    const actionType =
      (
        await db
          .select()
          .from(actionTypes)
          .where(sql`${actionTypes.orgId} = ${orgId} and ${actionTypes.name} = 'mcp_tool_call'`)
          .limit(1)
      )[0] ??
      (
        await db
          .insert(actionTypes)
          .values({
            id: newId("act"),
            orgId,
            name: "mcp_tool_call",
            payloadSchema: { type: "object", required: ["toolName", "args", "requestedBy"] },
            resolver: { type: "permission", config: {} },
            executor: { type: "mcp_tool_call", config: {} },
            defaultTtlHours: 1,
          })
          .returning()
      )[0];
    // A hitl:write principal must not smuggle a privileged MCP op through the
    // generic route — mcp_tool_call is reserved for /v1/mcp/tool-proposals which
    // checks the specific tool's permission (e.g. agents:write).
    const forged = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { cookie },
      payload: {
        actionTypeId: actionType?.id,
        payload: {
          toolName: "facility_create_agent",
          args: {},
          requestedBy: { type: "key", id: "x" },
        },
        contextMd: "smuggled privileged op",
      },
    });
    expect(forged.statusCode).toBe(403);
  });

  it("discovers action types and rejects invalid proposal dates and run/project mismatches", async () => {
    let actionType: { id: string; name: string } | undefined;
    for (let offset = 0; !actionType; offset += 200) {
      const listed = await app.inject({
        method: "GET",
        url: `/v1/action-types?limit=200&offset=${offset}`,
        headers: { cookie },
      });
      expect(listed.statusCode).toBe(200);
      const page = listed.json() as Array<{ id: string; name: string }>;
      actionType = page.find((row) => row.name === "task_creation");
      if (page.length < 200) break;
    }
    expect(actionType?.id).toBeTruthy();
    if (!actionType) throw new Error("task_creation action type missing");
    const loaded = await app.inject({
      method: "GET",
      url: `/v1/action-types/${actionType.id}`,
      headers: { cookie },
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().payloadSchema).toMatchObject({ type: "object" });

    const invalidDate = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { cookie },
      payload: {
        actionTypeId: actionType.id,
        payload: {},
        contextMd: "invalid expiry",
        expiresAt: "not-a-date",
      },
    });
    expect(invalidDate.statusCode).toBe(400);
    expect(invalidDate.json().error.code).toBe("validation_error");

    const other = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Proposal run project", slug: `proposal-run-${Date.now()}` },
    });
    const run = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId: other.json().id,
          mode: "manual",
          engine: "codex",
          trigger: {},
          createdBy: { type: "user", id: "fixture" },
        })
        .returning()
    )[0];
    const mismatch = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { cookie },
      payload: {
        projectId,
        runId: run?.id,
        actionTypeId: actionType.id,
        payload: {},
        contextMd: "cross-project run",
      },
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe("proposal_run_project_mismatch");
  });

  it("returns a stable 404 when updating a missing task", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/tasks/task_missing`,
      headers: { cookie },
      payload: { title: "still missing" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
  });

  it("fails closed when executing task creation without a GitHub installation", async () => {
    const actionType = (
      await db
        .select()
        .from(actionTypes)
        .where(sql`${actionTypes.orgId} = ${orgId} and ${actionTypes.name} = 'task_creation'`)
        .limit(1)
    )[0];
    if (!actionType) throw new Error("task_creation action type fixture missing");
    const project = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "GitHub Fail Closed Project",
          slug: `github-fail-closed-${Date.now()}`,
          settings: {},
        })
        .returning()
    )[0];
    if (!project) throw new Error("project fixture missing");
    const repo = (
      await db
        .insert(repos)
        .values({
          id: newId("repo"),
          orgId,
          projectId: project.id,
          owner: `owner-${Date.now()}`,
          name: "fail-closed",
          defaultBranch: "main",
        })
        .returning()
    )[0];
    if (!repo) throw new Error("repo fixture missing");
    const task = (
      await db
        .insert(poTasks)
        .values({
          id: newId("task"),
          orgId,
          projectId: project.id,
          title: "Create real issue only",
          bodyMd: "Do not fabricate a GitHub issue.",
          wsjf: { costOfDelay: 3, jobSize: 1 },
        })
        .returning()
    )[0];
    if (!task) throw new Error("task fixture missing");
    const proposal = (
      await db
        .insert(proposals)
        .values({
          id: newId("prop"),
          orgId,
          projectId: project.id,
          actionTypeId: actionType.id,
          payload: {
            taskId: task.id,
            title: task.title,
            bodyMd: task.bodyMd,
            wsjf: task.wsjf,
            target: { repo: { owner: repo.owner, name: repo.name } },
          },
          contextMd: "Task creation should fail without GitHub installation",
          expiresAt: new Date(Date.now() + 3600_000),
        })
        .returning()
    )[0];
    if (!proposal) throw new Error("proposal fixture missing");
    await db.insert(proposalEvents).values({
      orgId,
      proposalId: proposal.id,
      seq: 1,
      type: "open",
      actor: { type: "test", id: "api" },
      data: {},
    });

    const decided = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposal.id}/decide`,
      headers: { cookie },
      payload: { decision: "approve" },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().state).toBe("execution_failed");

    const events = await db
      .select()
      .from(proposalEvents)
      .where(
        sql`${proposalEvents.orgId} = ${orgId} and ${proposalEvents.proposalId} = ${proposal.id}`,
      )
      .orderBy(sql`${proposalEvents.seq} asc`);
    const failure = events.find((event) => event.type === "execution_failed");
    expect(failure?.data).toMatchObject({ error: "github_repo_not_installed" });

    const loadedTask = (await db.select().from(poTasks).where(eq(poTasks.id, task.id)).limit(1))[0];
    const forbiddenHost = ["github", "example"].join(".");
    expect(loadedTask?.status).not.toBe("created");
    expect(loadedTask?.gh).toBeNull();
    expect(JSON.stringify(loadedTask?.gh ?? {})).not.toContain(forbiddenHost);
    expect(sourceFilesContaining(new URL("../src/", import.meta.url), forbiddenHost)).toEqual([]);
  });

  it("gates MCP writes behind a separate human HITL approval", async () => {
    const role = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: {
        name: `mcp-steer-${Date.now()}`,
        description: "MCP key without approval permission",
        permissions: ["org:read", "runs:steer"],
      },
    });
    expect(role.statusCode).toBe(200);
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "mcp-steer", roleId: role.json().id },
    });
    expect(issued.statusCode).toBe(200);
    const run = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId,
          mode: "manual",
          engine: "codex",
          status: "running",
          trigger: {},
          createdBy: { type: "test", id: "fixture" },
        })
        .returning()
    )[0];
    if (!run) throw new Error("run fixture missing");
    await db.insert(runEvents).values({
      orgId,
      runId: run.id,
      seq: 1,
      type: "started",
      data: {},
    });

    const mismatched = await app.inject({
      method: "POST",
      url: "/v1/mcp/tool-proposals",
      headers: { authorization: `Bearer ${issued.json().secret}` },
      payload: {
        toolName: "facility_publish_registry_version",
        permission: "runs:steer",
        args: { versionId: "ver_unsafe" },
        summary: "attempt confused-deputy publish",
      },
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json().error.code).toBe("mcp_permission_mismatch");

    const proposed = await app.inject({
      method: "POST",
      url: "/v1/mcp/tool-proposals",
      headers: { authorization: `Bearer ${issued.json().secret}` },
      payload: {
        toolName: "facility_steer_run",
        permission: "runs:steer",
        args: { runId: run.id, body: "continue after tests pass" },
        summary: `Steer run ${run.id}`,
        runId: run.id,
      },
    });
    expect(proposed.statusCode).toBe(200);
    expect(proposed.json().state).toBe("open");

    const selfDecision = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposed.json().id}/decide`,
      headers: { authorization: `Bearer ${issued.json().secret}` },
      payload: { decision: "approve" },
    });
    expect(selfDecision.statusCode).toBe(403);
    expect(selfDecision.json().error.details.needed).toBe("hitl:decide");
    const stillOpen = (
      await db.select().from(proposals).where(eq(proposals.id, proposed.json().id)).limit(1)
    )[0];
    expect(stillOpen?.state).toBe("open");

    const approved = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposed.json().id}/decide`,
      headers: { cookie: approverCookie },
      payload: { decision: "approve", note: "approved by human" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().state).toBe("executed");
    const steerEvents = await db
      .select()
      .from(runEvents)
      .where(sql`${runEvents.runId} = ${run.id} and ${runEvents.type} = 'steer'`);
    expect(steerEvents).toHaveLength(1);
    const audit = await db
      .select()
      .from(auditEvents)
      .where(sql`${auditEvents.orgId} = ${orgId} and ${auditEvents.action} = 'mcp.tool.executed'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.projectId).toBe(projectId);

    const otherProject = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "MCP Audit Other", slug: `mcp-audit-other-${Date.now()}` },
    });
    expect(otherProject.statusCode).toBe(200);
    const projectAuditKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: `mcp-audit-reader-${Date.now()}`, roleId: ownerRole, projectId },
    });
    expect(projectAuditKey.statusCode).toBe(200);
    const otherAuditKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: {
        name: `mcp-audit-other-reader-${Date.now()}`,
        roleId: ownerRole,
        projectId: otherProject.json().id,
      },
    });
    expect(otherAuditKey.statusCode).toBe(200);

    type AuditRow = { projectId?: string | null; target: { id?: string }; action: string };
    const projectAudit = await app.inject({
      method: "GET",
      url: "/v1/audit?action=mcp.tool.executed&limit=500",
      headers: { authorization: `Bearer ${projectAuditKey.json().secret}` },
    });
    expect(projectAudit.statusCode).toBe(200);
    const projectAuditItems = projectAudit.json().items as AuditRow[];
    expect(projectAuditItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "mcp.tool.executed",
          projectId,
          target: expect.objectContaining({ id: proposed.json().id }),
        }),
      ]),
    );

    const otherAudit = await app.inject({
      method: "GET",
      url: "/v1/audit?action=mcp.tool.executed&limit=500",
      headers: { authorization: `Bearer ${otherAuditKey.json().secret}` },
    });
    expect(otherAudit.statusCode).toBe(200);
    const otherAuditItems = otherAudit.json().items as AuditRow[];
    expect(otherAuditItems.some((row) => row.target.id === proposed.json().id)).toBe(false);
  });

  it("creates an MCP agent from inline contract content after separate approval", async () => {
    const project = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Inline Agent", slug: `inline-agent-${Date.now()}` },
    });
    expect(project.statusCode).toBe(200);
    const role = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: {
        name: `mcp-agent-${Date.now()}`,
        permissions: ["org:read", "agents:write"],
      },
    });
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "mcp-agent", roleId: role.json().id, projectId: project.json().id },
    });
    const proposed = await app.inject({
      method: "POST",
      url: "/v1/mcp/tool-proposals",
      headers: { authorization: `Bearer ${issued.json().secret}` },
      payload: {
        toolName: "facility_create_agent",
        permission: "agents:write",
        projectId: project.json().id,
        summary: "Create inline agent",
        args: {
          projectId: project.json().id,
          name: "incident-responder",
          engine: "claude_code",
          model: { primary: "claude-fable-5" },
          contractContent: "Investigate incidents and leave an evidence-backed report.",
          triggers: [{ type: "manual", config: {} }],
        },
      },
    });
    expect(proposed.statusCode).toBe(200);

    const approved = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposed.json().id}/decide`,
      headers: { cookie: approverCookie },
      payload: { decision: "approve" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().state).toBe("executed");

    const agent = (
      await db
        .select()
        .from(agentDefs)
        .where(
          sql`${agentDefs.projectId} = ${project.json().id} and ${agentDefs.name} = 'incident-responder'`,
        )
        .limit(1)
    )[0];
    expect(agent?.engine).toBe("claude_code");
    const contract = (
      await db
        .select()
        .from(registryVersions)
        .where(eq(registryVersions.itemId, agent?.contractItemId ?? ""))
        .limit(1)
    )[0];
    expect(contract).toMatchObject({
      status: "active",
      content: "Investigate incidents and leave an evidence-backed report.",
    });
  });

  it("executes the complete expanded MCP lifecycle surface after separate approval", async () => {
    const target = await createProjectWithAgent("MCP Lifecycle");
    const role = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: {
        name: `mcp-lifecycle-${Date.now()}`,
        permissions: [
          "org:read",
          "projects:write",
          "registry:publish",
          "agents:write",
          "integrations:write",
        ],
      },
    });
    expect(role.statusCode).toBe(200);
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: {
        name: `mcp-lifecycle-${Date.now()}`,
        roleId: role.json().id,
        projectId: target.projectId,
      },
    });
    expect(issued.statusCode).toBe(200);

    const registry = await app.inject({
      method: "POST",
      url: "/v1/registry/items",
      headers: { cookie },
      payload: {
        scope: "project",
        projectId: target.projectId,
        kind: "skill",
        name: `mcp-deprecate-${Date.now()}`,
        content: "draft content",
      },
    });
    expect(registry.statusCode).toBe(200);
    const versionId = registry.json().versions[0].id as string;

    const integration = await app.inject({
      method: "POST",
      url: "/v1/integrations",
      headers: { cookie },
      payload: {
        projectId: target.projectId,
        kind: "webhook",
        name: `mcp-retry-${Date.now()}`,
        config: { url: "https://hooks.example.test/facility" },
      },
    });
    expect(integration.statusCode).toBe(200);
    const deliveryId = newId("evt");
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      orgId,
      integrationId: integration.json().id,
      eventType: "run.finished",
      dedupeKey: `mcp-lifecycle-${Date.now()}`,
      payload: { runId: "run_fixture" },
      status: "dead",
      attempts: 8,
      error: "upstream unavailable",
    });

    const execute = async (toolName: string, permission: string, args: Record<string, unknown>) => {
      const proposed = await app.inject({
        method: "POST",
        url: "/v1/mcp/tool-proposals",
        headers: { authorization: `Bearer ${issued.json().secret}` },
        payload: {
          toolName,
          permission,
          projectId: target.projectId,
          summary: `Execute ${toolName}`,
          args,
        },
      });
      expect(proposed.statusCode).toBe(200);
      const approved = await app.inject({
        method: "POST",
        url: `/v1/proposals/${proposed.json().id}/decide`,
        headers: { cookie: approverCookie },
        payload: { decision: "approve" },
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().state).toBe("executed");
    };

    await execute("facility_update_agent", "agents:write", {
      projectId: target.projectId,
      agentId: target.agent.id,
      name: "renamed-by-mcp",
      enabled: false,
    });
    const updatedAgent = (
      await db.select().from(agentDefs).where(eq(agentDefs.id, target.agent.id)).limit(1)
    )[0];
    expect(updatedAgent).toMatchObject({ name: "renamed-by-mcp", enabled: false });

    await execute("facility_retire_agent", "agents:write", {
      projectId: target.projectId,
      agentId: target.agent.id,
    });
    expect(await db.select().from(agentDefs).where(eq(agentDefs.id, target.agent.id))).toHaveLength(
      0,
    );

    await execute("facility_deprecate_registry_version", "registry:publish", { versionId });
    const version = (
      await db.select().from(registryVersions).where(eq(registryVersions.id, versionId)).limit(1)
    )[0];
    expect(version?.status).toBe("deprecated");

    await execute("facility_retry_webhook_delivery", "integrations:write", { deliveryId });
    const delivery = (
      await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1)
    )[0];
    expect(delivery).toMatchObject({ status: "pending", attempts: 0, error: null });

    await execute("facility_archive_project", "projects:write", {
      projectId: target.projectId,
    });
    const archived = (
      await db.select().from(projects).where(eq(projects.id, target.projectId)).limit(1)
    )[0];
    expect(archived?.status).toBe("archived");
  });

  it("denies MCP Builder trigger families without creating or enqueueing runs when plans are required", async () => {
    const target = await createProjectWithAgent("MCP Governed Builder");
    await db
      .update(agentDefs)
      .set({
        name: "delivery-specialist",
        engine: "claude_code",
        triggers: [{ type: "command", handle: "/builder" }],
        enabled: true,
      })
      .where(eq(agentDefs.id, target.agent.id));
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(and(eq(projects.orgId, orgId), eq(projects.id, target.projectId)));

    const role = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: {
        name: `mcp-governed-builder-${Date.now()}`,
        permissions: ["org:read", "runs:trigger", "repos:write"],
      },
    });
    expect(role.statusCode, role.body).toBe(200);
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: {
        name: `mcp-governed-builder-${Date.now()}`,
        roleId: role.json().id,
        projectId: target.projectId,
      },
    });
    expect(issued.statusCode, issued.body).toBe(200);

    const installation = (
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId,
          installationId: Date.now(),
          accountLogin: `mcp-governed-${Date.now()}`,
          targetType: "Organization",
        })
        .returning()
    )[0];
    const repo = (
      await db
        .insert(repos)
        .values({
          id: newId("repo"),
          orgId,
          projectId: target.projectId,
          installationId: installation?.id,
          owner: `mcp-governed-${Date.now()}`,
          name: "facility",
          defaultBranch: "main",
        })
        .returning()
    )[0];
    if (!installation || !repo) throw new Error("governed MCP repository fixture missing");
    await db.insert(ghIssues).values({
      id: newId("evt"),
      orgId,
      projectId: target.projectId,
      repoId: repo.id,
      number: 204,
      title: "Do not bypass Gate 1 from MCP",
      state: "open",
      htmlUrl: `https://github.com/${repo.owner}/${repo.name}/issues/204`,
    });
    const terminalBuilder = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId: target.projectId,
          agentDefId: target.agent.id,
          mode: "delivery-specialist",
          engine: "claude_code",
          engineSessionId: "governed-mcp-resume",
          status: "succeeded",
          createdBy: { type: "test", id: "governed-mcp" },
        })
        .returning()
    )[0];
    if (!terminalBuilder) throw new Error("governed MCP resume fixture missing");
    const governedConversation = (
      await db
        .insert(conversations)
        .values({
          id: newId("evt"),
          orgId,
          projectId: target.projectId,
          agentDefId: target.agent.id,
          title: "Governed Builder conversation",
          createdBy: { type: "test", id: "governed-mcp" },
        })
        .returning()
    )[0];
    if (!governedConversation) throw new Error("governed MCP conversation fixture missing");

    const originalEnqueue = app.enqueue;
    const originalFactory = app.githubClientFactory;
    const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];
    let githubFactoryCalls = 0;
    app.enqueue = async (queue, data) => {
      enqueued.push({ queue, data });
      return null;
    };
    app.githubClientFactory = (async () => {
      githubFactoryCalls += 1;
      throw new Error("MCP Builder denial reached GitHub");
    }) as unknown as GithubClientFactory;

    const executeDenied = async (toolName: string, args: Record<string, unknown>) => {
      const before = await db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.projectId, target.projectId));
      const proposed = await app.inject({
        method: "POST",
        url: "/v1/mcp/tool-proposals",
        headers: { authorization: `Bearer ${issued.json().secret}` },
        payload: {
          toolName,
          permission: "runs:trigger",
          projectId: target.projectId,
          summary: `Attempt governed ${toolName}`,
          args,
        },
      });
      expect(proposed.statusCode, proposed.body).toBe(200);
      const approved = await app.inject({
        method: "POST",
        url: `/v1/proposals/${proposed.json().id}/decide`,
        headers: { cookie: approverCookie },
        payload: { decision: "approve" },
      });
      expect(approved.statusCode, approved.body).toBe(200);
      expect(approved.json()).toMatchObject({
        state: "execution_failed",
        executionError: "builder_plan_required",
      });
      expect(
        await db.select({ id: runs.id }).from(runs).where(eq(runs.projectId, target.projectId)),
      ).toHaveLength(before.length);
    };

    try {
      await executeDenied("facility_trigger_run", {
        projectId: target.projectId,
        agentName: "builder",
        input: { objective: "Attempt direct Builder dispatch" },
      });
      await executeDenied("facility_trigger_github_issue", {
        projectId: target.projectId,
        repoId: repo.id,
        number: 204,
        agentName: "builder",
      });
      await executeDenied("facility_resume_run", {
        runId: terminalBuilder.id,
        message: "Attempt governed MCP resume",
      });
      await executeDenied("facility_send_conversation_message", {
        conversationId: governedConversation.id,
        body: "Attempt governed Builder conversation turn",
      });
      const beforeRepos = await db
        .select({ id: repos.id })
        .from(repos)
        .where(eq(repos.projectId, target.projectId));
      const repoProposal = await app.inject({
        method: "POST",
        url: "/v1/mcp/tool-proposals",
        headers: { authorization: `Bearer ${issued.json().secret}` },
        payload: {
          toolName: "facility_connect_repo",
          permission: "repos:write",
          projectId: target.projectId,
          summary: "Attempt repo connection while Gate 1 is required",
          args: {
            projectId: target.projectId,
            owner: installation.accountLogin,
            name: "unverified-required-repo",
          },
        },
      });
      expect(repoProposal.statusCode, repoProposal.body).toBe(200);
      const repoApproval = await app.inject({
        method: "POST",
        url: `/v1/proposals/${repoProposal.json().id}/decide`,
        headers: { cookie: approverCookie },
        payload: { decision: "approve" },
      });
      expect(repoApproval.statusCode, repoApproval.body).toBe(200);
      expect(repoApproval.json()).toMatchObject({
        state: "execution_failed",
        executionError: "builder_plan_platform_lane_required",
      });
      expect(
        await db.select({ id: repos.id }).from(repos).where(eq(repos.projectId, target.projectId)),
      ).toHaveLength(beforeRepos.length);
      expect(enqueued).toEqual([]);
      expect(githubFactoryCalls).toBe(0);
      const sources = (
        await db
          .select({ action: auditEvents.action, payload: auditEvents.payload })
          .from(auditEvents)
          .where(eq(auditEvents.projectId, target.projectId))
      )
        .filter((event) => event.action === "run.builder_plan_denied")
        .map((event) => (event.payload as { source?: unknown }).source);
      expect(sources).toEqual(
        expect.arrayContaining([
          "mcp_trigger_run",
          "mcp_trigger_github_issue",
          "mcp_resume_run",
          "mcp_conversation_message",
        ]),
      );
    } finally {
      app.enqueue = originalEnqueue;
      app.githubClientFactory = originalFactory;
    }
  });

  it("executes approved MCP sessions, conversations, and GitHub issue workflows end to end", async () => {
    const target = await createProjectWithAgent("MCP Interactive Lifecycle");
    await db
      .update(agentDefs)
      .set({ engine: "claude_code", enabled: true })
      .where(eq(agentDefs.id, target.agent.id));
    const role = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: {
        name: `mcp-interactive-${Date.now()}`,
        permissions: ["org:read", "runs:trigger", "runs:steer", "repos:write"],
      },
    });
    expect(role.statusCode).toBe(200);
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: {
        name: `mcp-interactive-${Date.now()}`,
        roleId: role.json().id,
        projectId: target.projectId,
      },
    });
    expect(issued.statusCode).toBe(200);

    const queues: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const comments: Array<{ issueNumber: number; body: string }> = [];
    const originalEnqueue = app.enqueue;
    const originalFactory = app.githubClientFactory;
    app.enqueue = async (queue: string, data: Record<string, unknown>) => {
      queues.push({ queue, data });
      return `job_${queues.length}`;
    };
    app.githubClientFactory = (async () => ({
      rest: {
        issues: {
          createComment: async (args: Record<string, unknown>) => {
            comments.push({ issueNumber: Number(args.issue_number), body: String(args.body) });
            return { data: { id: comments.length } };
          },
        },
      },
    })) as unknown as GithubClientFactory;

    const execute = async (toolName: string, permission: string, args: Record<string, unknown>) => {
      const proposed = await app.inject({
        method: "POST",
        url: "/v1/mcp/tool-proposals",
        headers: { authorization: `Bearer ${issued.json().secret}` },
        payload: {
          toolName,
          permission,
          projectId: target.projectId,
          summary: `Execute ${toolName}`,
          args,
        },
      });
      expect(proposed.statusCode, proposed.body).toBe(200);
      const approved = await app.inject({
        method: "POST",
        url: `/v1/proposals/${proposed.json().id}/decide`,
        headers: { cookie: approverCookie },
        payload: { decision: "approve" },
      });
      expect(approved.statusCode, approved.body).toBe(200);
      expect(approved.json().state).toBe("executed");
    };

    try {
      const running = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId: target.projectId,
            agentDefId: target.agent.id,
            mode: "builder",
            engine: "claude_code",
            status: "running",
            createdBy: { type: "test", id: "mcp-interactive" },
          })
          .returning()
      )[0];
      await execute("facility_interrupt_run", "runs:steer", { runId: running?.id });
      expect(
        await db
          .select()
          .from(steerMessages)
          .where(eq(steerMessages.runId, running?.id ?? "")),
      ).toEqual([expect.objectContaining({ kind: "interrupt" })]);

      const terminal = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId: target.projectId,
            agentDefId: target.agent.id,
            mode: "builder",
            engine: "claude_code",
            engineSessionId: "session_mcp_resume",
            status: "succeeded",
            trigger: {
              source: "plan_acceptance",
              proposalId: newId("prop"),
              architectRunId: newId("run"),
            },
            createdBy: { type: "test", id: "mcp-interactive" },
          })
          .returning()
      )[0];
      await execute("facility_resume_run", "runs:trigger", {
        runId: terminal?.id,
        message: "Continue from the verified checkpoint",
      });
      const resumed = (
        await db
          .select()
          .from(runs)
          .where(
            sql`${runs.projectId} = ${target.projectId} and ${runs.trigger}->>'resumeOf' = ${terminal?.id}`,
          )
          .limit(1)
      )[0];
      expect(resumed?.trigger).toMatchObject({
        type: "resume",
        resumeOf: terminal?.id,
        message: "Continue from the verified checkpoint",
      });
      expect(resumed?.trigger).not.toHaveProperty("source");
      expect(resumed?.trigger).not.toHaveProperty("proposalId");

      const title = `MCP conversation ${Date.now()}`;
      await execute("facility_start_conversation", "runs:trigger", {
        projectId: target.projectId,
        agentDefId: target.agent.id,
        title,
      });
      const conversation = (
        await db
          .select()
          .from(conversations)
          .where(and(eq(conversations.projectId, target.projectId), eq(conversations.title, title)))
          .limit(1)
      )[0];
      expect(conversation?.status).toBe("idle");
      await execute("facility_send_conversation_message", "runs:trigger", {
        conversationId: conversation?.id,
        body: "Implement the approved plan",
      });
      const conversationAfter = (
        await db
          .select()
          .from(conversations)
          .where(eq(conversations.id, conversation?.id ?? ""))
          .limit(1)
      )[0];
      expect(conversationAfter).toMatchObject({ status: "running" });
      expect(
        await db
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, conversation?.id ?? "")),
      ).toEqual([expect.objectContaining({ role: "user", body: "Implement the approved plan" })]);

      const installation = (
        await db
          .insert(githubInstallations)
          .values({
            id: newId("int"),
            orgId,
            installationId: Date.now(),
            accountLogin: `mcp-interactive-${Date.now()}`,
            targetType: "Organization",
          })
          .returning()
      )[0];
      const repo = (
        await db
          .insert(repos)
          .values({
            id: newId("repo"),
            orgId,
            projectId: target.projectId,
            installationId: installation?.id,
            owner: `mcp-interactive-${Date.now()}`,
            name: "facility",
            defaultBranch: "main",
          })
          .returning()
      )[0];
      await db.insert(ghIssues).values({
        id: newId("evt"),
        orgId,
        projectId: target.projectId,
        repoId: repo?.id ?? "",
        number: 41,
        title: "Exercise the approved MCP issue path",
        state: "open",
        htmlUrl: `https://github.com/${repo?.owner}/${repo?.name}/issues/41`,
      });
      const collidingRepo = (
        await db
          .insert(repos)
          .values({
            id: newId("repo"),
            orgId,
            projectId: target.projectId,
            owner: `mcp-collision-${Date.now()}`,
            name: "facility",
            defaultBranch: "main",
          })
          .returning()
      )[0];
      await db.insert(ghIssues).values({
        id: newId("evt"),
        orgId,
        projectId: target.projectId,
        repoId: collidingRepo?.id ?? "",
        number: 41,
        title: "Same number in another repository",
        state: "open",
        htmlUrl: `https://github.com/${collidingRepo?.owner}/${collidingRepo?.name}/issues/41`,
      });
      await execute("facility_sync_github_issues", "repos:write", {
        projectId: target.projectId,
      });
      await execute("facility_trigger_github_issue", "runs:trigger", {
        projectId: target.projectId,
        repoId: repo?.id,
        number: 41,
        agentName: target.agent.name,
      });
      const issueRun = (
        await db
          .select()
          .from(runs)
          .where(sql`${runs.projectId} = ${target.projectId} and ${runs.gh}->>'issueNumber' = '41'`)
          .limit(1)
      )[0];
      expect(issueRun?.trigger).toMatchObject({
        type: "mcp_issue",
        repo: { id: repo?.id },
        issue: { number: 41 },
      });
      expect(queues).toEqual(
        expect.arrayContaining([
          { queue: "github.issues-sync", data: { repoId: repo?.id, orgId } },
          { queue: "runs.dispatch", data: { runId: issueRun?.id, orgId } },
        ]),
      );
      expect(comments).toEqual([
        expect.objectContaining({
          issueNumber: 41,
          body: expect.stringContaining(`run ${issueRun?.id}`),
        }),
      ]);
    } finally {
      app.enqueue = originalEnqueue;
      app.githubClientFactory = originalFactory;
    }
  });

  it("refuses approved MCP execution when the resolved target project differs", async () => {
    const other = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "MCP Other", slug: `mcp-other-${Date.now()}` },
    });
    expect(other.statusCode).toBe(200);
    const run = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId: other.json().id,
          mode: "manual",
          engine: "codex",
          status: "running",
          trigger: {},
          createdBy: { type: "test", id: "fixture" },
        })
        .returning()
    )[0];
    if (!run) throw new Error("run fixture missing");
    const actionType =
      (
        await db
          .select()
          .from(actionTypes)
          .where(sql`${actionTypes.orgId} = ${orgId} and ${actionTypes.name} = 'mcp_tool_call'`)
          .limit(1)
      )[0] ??
      (
        await db
          .insert(actionTypes)
          .values({
            id: newId("act"),
            orgId,
            name: "mcp_tool_call",
            payloadSchema: { type: "object", required: ["toolName", "args", "requestedBy"] },
            resolver: { type: "permission", config: {} },
            executor: { type: "mcp_tool_call", config: {} },
            defaultTtlHours: 1,
          })
          .returning()
      )[0];
    const proposal = (
      await db
        .insert(proposals)
        .values({
          id: newId("prop"),
          orgId,
          projectId,
          runId: run.id,
          actionTypeId: actionType?.id ?? "",
          payload: {
            toolName: "facility_steer_run",
            permission: "runs:steer",
            args: { runId: run.id, body: "cross project steer" },
            targetProjectId: projectId,
            requestedBy: { type: "key", id: "malicious" },
          },
          contextMd: "malicious cross-project MCP proposal",
          expiresAt: new Date(Date.now() + 3600_000),
        })
        .returning()
    )[0];
    await db.insert(proposalEvents).values({
      orgId,
      proposalId: proposal?.id ?? "",
      seq: 1,
      type: "open",
      actor: { type: "key", id: "malicious" },
      data: {},
    });

    const approved = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposal?.id}/decide`,
      headers: { cookie: approverCookie },
      payload: { decision: "approve" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().state).toBe("execution_failed");
    const steerEvents = await db
      .select()
      .from(runEvents)
      .where(sql`${runEvents.runId} = ${run.id} and ${runEvents.type} = 'steer'`);
    expect(steerEvents).toHaveLength(0);
  });

  it("does not move an existing budget across projects on MCP set_budget", async () => {
    const suffix = `${Date.now()}`;
    const projectB = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Budget Move B", slug: `budget-move-b-${suffix}` },
    });
    expect(projectB.statusCode).toBe(200);
    const budget = (
      await db
        .insert(budgets)
        .values({
          id: newId("bud"),
          orgId,
          projectId,
          scope: "project",
          period: "monthly",
          limitCents: 1000,
          mode: "soft",
        })
        .returning()
    )[0];
    if (!budget) throw new Error("budget fixture missing");
    const actionType = (
      await db
        .select()
        .from(actionTypes)
        .where(sql`${actionTypes.orgId} = ${orgId} and ${actionTypes.name} = 'mcp_tool_call'`)
        .limit(1)
    )[0];
    if (!actionType) throw new Error("mcp_tool_call action type missing");
    const requesterRole = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: {
        name: `mcp-budget-requester-${suffix}`,
        permissions: ["org:read", "budgets:write"],
      },
    });
    expect(requesterRole.statusCode).toBe(200);
    const requesterKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: {
        name: `mcp-budget-requester-${suffix}`,
        roleId: requesterRole.json().id,
        projectId,
      },
    });
    expect(requesterKey.statusCode).toBe(200);
    const proposal = (
      await db
        .insert(proposals)
        .values({
          id: newId("prop"),
          orgId,
          projectId,
          actionTypeId: actionType.id,
          payload: {
            toolName: "facility_set_budget",
            permission: "budgets:write",
            // args tries to move the budget to project B and raise the limit.
            args: {
              budgetId: budget.id,
              scope: "project",
              projectId: projectB.json().id,
              period: "monthly",
              limitCents: 9999,
              mode: "soft",
            },
            targetProjectId: projectId,
            requestedBy: { type: "key", id: requesterKey.json().id },
          },
          contextMd: "set_budget across projects",
          expiresAt: new Date(Date.now() + 3600_000),
        })
        .returning()
    )[0];
    await db.insert(proposalEvents).values({
      orgId,
      proposalId: proposal?.id ?? "",
      seq: 1,
      type: "open",
      actor: { type: "key", id: "mover" },
      data: {},
    });
    const approved = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposal?.id}/decide`,
      headers: { cookie: approverCookie },
      payload: { decision: "approve" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().state).toBe("executed");
    const after = (await db.select().from(budgets).where(eq(budgets.id, budget.id)).limit(1))[0];
    // Project pinned to its original scope; the non-project fields still update.
    expect(after?.projectId).toBe(projectId);
    expect(after?.projectId).not.toBe(projectB.json().id);
    expect(after?.limitCents).toBe(9999);
  });

  it("rejects MCP proposal creation by keys that can decide HITL", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "mcp-owner", roleId: ownerRole },
    });
    expect(issued.statusCode).toBe(200);
    const proposed = await app.inject({
      method: "POST",
      url: "/v1/mcp/tool-proposals",
      headers: { authorization: `Bearer ${issued.json().secret}` },
      payload: {
        toolName: "facility_steer_run",
        permission: "runs:steer",
        args: { runId: "run_any", body: "do it" },
        summary: "unsafe owner-key proposal",
        runId: "run_any",
      },
    });
    expect(proposed.statusCode).toBe(403);
    expect(proposed.json().error.code).toBe("mcp_key_can_decide");
  });

  it("revalidates MCP requester authority immediately before an approved side effect", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const role = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: {
        name: `mcp-revalidation-${suffix}`,
        permissions: ["org:read", "projects:write"],
      },
    });
    expect(role.statusCode).toBe(200);
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: `mcp-revalidation-${suffix}`, roleId: role.json().id },
    });
    expect(issued.statusCode).toBe(200);
    const slug = `revoked-mcp-${suffix}`;
    const proposed = await app.inject({
      method: "POST",
      url: "/v1/mcp/tool-proposals",
      headers: { authorization: `Bearer ${issued.json().secret}` },
      payload: {
        toolName: "facility_create_project",
        permission: "projects:write",
        args: { name: "Must remain absent", slug },
        summary: "Verify delayed authority revalidation",
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/keys/${issued.json().id}`,
      headers: { cookie },
    });
    expect(revoked.statusCode).toBe(200);

    const approved = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposed.json().id}/decide`,
      headers: { cookie: approverCookie },
      payload: { decision: "approve" },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().state).toBe("execution_failed");
    expect(
      await db
        .select()
        .from(projects)
        .where(and(eq(projects.orgId, orgId), eq(projects.slug, slug))),
    ).toHaveLength(0);
  });

  it("enforces four-eyes approval for every proposal action type", async () => {
    const actionType = (
      await db
        .insert(actionTypes)
        .values({
          id: newId("act"),
          orgId,
          name: `four-eyes-${Date.now()}`,
          payloadSchema: { type: "object", additionalProperties: false },
          resolver: { type: "permission", config: {} },
          executor: { type: "test_fixture", config: {} },
          defaultTtlHours: 1,
        })
        .returning()
    )[0];
    if (!actionType) throw new Error("action type fixture missing");
    const opened = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: { cookie },
      payload: {
        projectId,
        actionTypeId: actionType.id,
        payload: {},
        contextMd: "Independent approval regression",
      },
    });
    expect(opened.statusCode).toBe(200);

    const selfDecision = await app.inject({
      method: "POST",
      url: `/v1/proposals/${opened.json().id}/decide`,
      headers: { cookie },
      payload: { decision: "reject" },
    });
    expect(selfDecision.statusCode).toBe(403);
    expect(selfDecision.json().error.code).toBe("same_principal_approval_denied");

    const independentDecision = await app.inject({
      method: "POST",
      url: `/v1/proposals/${opened.json().id}/decide`,
      headers: { cookie: approverCookie },
      payload: { decision: "reject", note: "Independently reviewed" },
    });
    expect(independentDecision.statusCode).toBe(200);
    expect(independentDecision.json().state).toBe("rejected");
  });

  it("marks failed HITL execution explicitly and can retry it", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const project = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "HITL Failure", slug: `hitl-failure-${suffix}` },
    });
    expect(project.statusCode).toBe(200);
    const task = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.json().id}/tasks`,
      headers: { cookie },
      payload: { title: "Needs retry", bodyMd: "body", wsjf: {} },
    });
    expect(task.statusCode).toBe(200);
    const proposed = await app.inject({
      method: "POST",
      url: `/v1/tasks/${task.json().id}/propose`,
      headers: { cookie },
    });
    expect(proposed.statusCode).toBe(200);

    const failed = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposed.json().id}/decide`,
      headers: { cookie: approverCookie },
      payload: { decision: "approve" },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().state).toBe("execution_failed");
    const failedLoaded = await app.inject({
      method: "GET",
      url: `/v1/proposals/${proposed.json().id}`,
      headers: { cookie },
    });
    expect(failedLoaded.json().events.map((event: { type: string }) => event.type)).toContain(
      "execution_failed",
    );

    const installation = (
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId,
          installationId: Math.floor(Math.random() * 2_000_000_000) + 1,
          accountLogin: `facility-retry-${suffix}`,
          targetType: "Organization",
        })
        .returning()
    )[0];
    await db.insert(repos).values({
      id: newId("repo"),
      orgId,
      projectId: project.json().id,
      installationId: installation?.id,
      owner: `facility-retry-${suffix}`,
      name: "repo",
      defaultBranch: "main",
    });
    const previousFactory = app.githubClientFactory;
    let issueCreates = 0;
    app.githubClientFactory = fakeGithubFactory(async () => {
      issueCreates += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    try {
      const requests = [1, 2].map(() =>
        app.inject({
          method: "POST",
          url: `/v1/proposals/${proposed.json().id}/execute`,
          headers: { cookie },
        }),
      );
      const retried = await Promise.all(requests);
      expect(retried.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect(retried.find((response) => response.statusCode === 200)?.json().state).toBe(
        "executed",
      );
      expect(issueCreates).toBe(1);
      const executed = await db
        .select()
        .from(proposalEvents)
        .where(
          sql`${proposalEvents.proposalId} = ${proposed.json().id} and ${proposalEvents.type} = 'executed'`,
        );
      expect(executed).toHaveLength(1);
    } finally {
      app.githubClientFactory = previousFactory;
    }
  });

  it("audit verify detects a manually corrupted row", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Audit Project", slug: `audit-${Date.now()}` },
    });
    const ok = await app.inject({ method: "GET", url: "/v1/audit/verify", headers: { cookie } });
    expect(ok.json().ok).toBe(true);
    const last = (
      await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.orgId, orgId))
        .orderBy(sql`${auditEvents.seq} desc`)
        .limit(1)
    )[0];
    if (!last) throw new Error("expected audit row");
    await db
      .update(auditEvents)
      .set({ payload: { corrupted: true } })
      .where(eq(auditEvents.id, last.id));
    const broken = await app.inject({
      method: "GET",
      url: "/v1/audit/verify",
      headers: { cookie },
    });
    expect(broken.json().ok).toBe(false);
    await db.update(auditEvents).set({ payload: last.payload }).where(eq(auditEvents.id, last.id));
  });

  it("enforces KB parent DAG rule and writes bidirectional links", async () => {
    const space = await app.inject({
      method: "PUT",
      url: `/v1/projects/${projectId}/kb/space`,
      headers: { cookie },
      payload: {
        charterMd: "",
        activeMd: "",
        config: { artifact_types: [{ prefix: "H", name: "Hypothesis" }] },
      },
    });
    expect(space.statusCode).toBe(200);
    const fail = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/kb/entries`,
      headers: { cookie },
      payload: { type: "E", slug: "experiment", bodyMd: "body", links: [] },
    });
    expect(fail.statusCode).toBe(400);
    const parent = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/kb/entries`,
      headers: { cookie },
      payload: { type: "H", slug: "hypothesis", bodyMd: "body", links: [] },
    });
    const child = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/kb/entries`,
      headers: { cookie },
      payload: { type: "E", slug: "experiment", bodyMd: "body", links: [parent.json().id] },
    });
    expect(child.statusCode).toBe(200);
  });

  it("links cited artifacts on body edits and captures the prior version", async () => {
    // Partial PUT: only config — charter/active must survive untouched.
    const space = await app.inject({
      method: "PUT",
      url: `/v1/projects/${projectId}/kb/space`,
      headers: { cookie },
      payload: { config: { artifact_types: [{ prefix: "H", name: "Hypothesis" }] } },
    });
    expect(space.statusCode, space.body).toBe(200);
    const first = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/kb/entries`,
      headers: { cookie },
      payload: { type: "H", slug: "cited-hypothesis", bodyMd: "the cited one", links: [] },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/kb/entries`,
      headers: { cookie },
      payload: { type: "H", slug: "citing-hypothesis", bodyMd: "no links yet", links: [] },
    });
    expect(second.statusCode).toBe(200);
    const citedRef = `H${String(first.json().number).padStart(3, "0")}`;
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/kb/entries/${second.json().id}`,
      headers: { cookie },
      payload: { bodyMd: `Builds on [[${citedRef}]].` },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const hood = await app.inject({
      method: "GET",
      url: `/v1/kb/entries/${second.json().id}/neighborhood`,
      headers: { cookie },
    });
    expect(hood.statusCode).toBe(200);
    const linkedIds = hood.json().linked.map((neighbor: { id: string }) => neighbor.id);
    expect(linkedIds).toContain(first.json().id);
    const versions = await app.inject({
      method: "GET",
      url: `/v1/kb/entries/${second.json().id}/versions`,
      headers: { cookie },
    });
    expect(versions.statusCode).toBe(200);
    expect(versions.json().length).toBe(1);
    // The captured prior is the creation-normalized body (## Links appended).
    expect(versions.json()[0].bodyMd.startsWith("no links yet")).toBe(true);
    // Dropping the cite unlinks it again (validation-guarded removal).
    const uncited = await app.inject({
      method: "PATCH",
      url: `/v1/kb/entries/${second.json().id}`,
      headers: { cookie },
      payload: { bodyMd: "Standalone again." },
    });
    expect(uncited.statusCode, uncited.body).toBe(200);
    const hoodAfter = await app.inject({
      method: "GET",
      url: `/v1/kb/entries/${second.json().id}/neighborhood`,
      headers: { cookie },
    });
    const linkedAfter = hoodAfter.json().linked.map((neighbor: { id: string }) => neighbor.id);
    expect(linkedAfter).not.toContain(first.json().id);
  });

  it("returns null for a project whose KB space has not been created", async () => {
    const legacyProject = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Legacy empty KB",
          slug: `legacy-empty-kb-${Date.now()}`,
          settings: {},
        })
        .returning()
    )[0];
    expect(legacyProject).toBeTruthy();
    const space = await app.inject({
      method: "GET",
      url: `/v1/projects/${legacyProject?.id}/kb/space`,
      headers: { cookie },
    });
    expect(space.statusCode, space.body).toBe(200);
    expect(space.json()).toBeNull();
  });

  it("aggregates spend over llm request fixtures", async () => {
    await db.insert(llmRequests).values({
      id: newId("evt"),
      orgId,
      projectId,
      provider: "openai",
      model: "gpt-5.5",
      status: "ok",
      costCents: 123,
      latencyMs: 10,
    });
    // Database-managed created_at can lead the millisecond application clock.
    // The default spend window must therefore use the database clock too.
    const RealDate = Date;
    const applicationNow = RealDate.now() - 1_000;
    const SkewedDate = new Proxy(RealDate, {
      construct(target, args) {
        return Reflect.construct(target, args.length ? args : [applicationNow]);
      },
      get(target, property, receiver) {
        if (property === "now") return () => applicationNow;
        return Reflect.get(target, property, receiver);
      },
    });
    vi.stubGlobal("Date", SkewedDate);
    const spend = await (async () => {
      try {
        return await app.inject({
          method: "GET",
          url: "/v1/spend?groupBy=model",
          headers: { cookie },
        });
      } finally {
        vi.stubGlobal("Date", RealDate);
      }
    })();
    expect(spend.statusCode).toBe(200);
    expect(
      spend
        .json()
        .some(
          (row: { bucket: string; cost_cents: number }) =>
            row.bucket === "gpt-5.5" && row.cost_cents >= 123,
        ),
    ).toBe(true);
  });

  it("lists raw llm requests with project clamping and pagination", async () => {
    const other = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "LLM Other", slug: `llm-other-${Date.now()}` },
    });
    expect(other.statusCode).toBe(200);
    await db.insert(llmRequests).values([
      {
        id: newId("evt"),
        orgId,
        projectId,
        provider: "openai",
        model: "gpt-5.5",
        status: "ok",
        inputTokens: 10,
        outputTokens: 5,
        costCents: 1,
        latencyMs: 10,
        requestUri: "s3://facility/request-a",
        responseUri: "s3://facility/response-a",
      },
      {
        id: newId("evt"),
        orgId,
        projectId: other.json().id,
        provider: "openai",
        model: "gpt-5.5-mini",
        status: "ok",
        inputTokens: 20,
        outputTokens: 10,
        costCents: 2,
        latencyMs: 20,
      },
    ]);
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "llm-reader", roleId: ownerRole, projectId },
    });
    const listed = await app.inject({
      method: "GET",
      url: "/v1/llm-requests?limit=1",
      headers: { authorization: `Bearer ${issued.json().secret}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
    expect(listed.json().items[0].projectId).toBe(projectId);
    expect(listed.json().items[0].requestUri).toBeTruthy();
  });

  it("reads a stored llm request envelope through the API", async () => {
    const envelope = { request: { body: { model: "gpt-5.5" } }, response: { id: "resp_1" } };
    // Envelopes are keyed under the owning org's prefix; the read path enforces
    // that the stored URI stays within envelopes/<orgId>/.
    const envelopeKey = `envelopes/${orgId}/evt.json.gz`;
    const server = createServer((request, response) => {
      if (request.url === `/facility-test/${envelopeKey}`) {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
        });
        response.end(gzipSync(Buffer.from(JSON.stringify(envelope))));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const previousBucket = config.s3Bucket;
    const previousEndpoint = config.s3Endpoint;
    const previousAccessKey = config.s3AccessKey;
    const previousSecretKey = config.s3SecretKey;
    const previousRegion = config.awsRegion;
    config.s3Bucket = "facility-test";
    config.s3Endpoint = `http://127.0.0.1:${address.port}`;
    config.s3AccessKey = "test";
    config.s3SecretKey = "test";
    config.awsRegion = "us-east-1";
    try {
      const requestId = newId("evt");
      await db.insert(llmRequests).values({
        id: requestId,
        orgId,
        projectId,
        provider: "openai",
        model: "gpt-5.5",
        status: "ok",
        costCents: 123,
        latencyMs: 10,
        requestUri: `s3://facility-test/${envelopeKey}`,
        responseUri: `s3://facility-test/${envelopeKey}`,
      });
      const issued = await app.inject({
        method: "POST",
        url: "/v1/keys",
        headers: { cookie },
        payload: { name: "envelope-reader", roleId: ownerRole, projectId },
      });
      const response = await app.inject({
        method: "GET",
        url: `/v1/llm-requests/${requestId}/envelope`,
        headers: { authorization: `Bearer ${issued.json().secret}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().llmRequest.id).toBe(requestId);
      expect(response.json().envelope).toEqual(envelope);
    } finally {
      config.s3Bucket = previousBucket;
      config.s3Endpoint = previousEndpoint;
      config.s3AccessKey = previousAccessKey;
      config.s3SecretKey = previousSecretKey;
      config.awsRegion = previousRegion;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("requires the runner token for transcript uploads", async () => {
    const token = "frt_transcript_auth";
    const run = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId,
          mode: "builder",
          engine: "codex",
          status: "running",
          sandbox: { runnerTokenHash: await hashKey(token) },
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    const response = await app.inject({
      method: "POST",
      url: `/internal/runs/${run?.id}/transcript`,
      headers: { "content-type": "application/x-ndjson" },
      payload: '{"type":"result"}\n',
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects transcript uploads over 50 MB", async () => {
    const token = "frt_transcript_large";
    const run = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId,
          mode: "builder",
          engine: "codex",
          status: "running",
          sandbox: { runnerTokenHash: await hashKey(token) },
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    const response = await app.inject({
      method: "POST",
      url: `/internal/runs/${run?.id}/transcript`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-ndjson",
      },
      payload: Buffer.alloc(50 * 1024 * 1024 + 1, "x"),
    });
    expect(response.statusCode).toBe(413);
  });

  it("round trips a run transcript and hides it from another project-scoped key", async () => {
    const transcript = '{"type":"system","session_id":"sess_1"}\n{"type":"result"}\n';
    const objects = new Map<string, Buffer>();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const key = request.url ?? "";
        if (request.method === "PUT") {
          objects.set(key, Buffer.concat(chunks));
          response.writeHead(200).end();
          return;
        }
        const body = objects.get(key);
        if (request.method === "GET" && body) {
          response.writeHead(200, { "content-type": "application/x-ndjson" });
          response.end(body);
          return;
        }
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const previous = {
      s3Bucket: config.s3Bucket,
      s3Endpoint: config.s3Endpoint,
      s3AccessKey: config.s3AccessKey,
      s3SecretKey: config.s3SecretKey,
      awsRegion: config.awsRegion,
    };
    config.s3Bucket = "facility-test";
    config.s3Endpoint = `http://127.0.0.1:${address.port}`;
    config.s3AccessKey = "test";
    config.s3SecretKey = "test";
    config.awsRegion = "us-east-1";
    try {
      const token = "frt_transcript_roundtrip";
      const run = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId,
            mode: "builder",
            engine: "codex",
            status: "running",
            sandbox: { runnerTokenHash: await hashKey(token) },
            createdBy: { type: "user", id: "test" },
          })
          .returning()
      )[0];
      const upload = await app.inject({
        method: "POST",
        url: `/internal/runs/${run?.id}/transcript`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-ndjson",
        },
        payload: transcript,
      });
      expect(upload.statusCode).toBe(200);
      const stored = (
        await db
          .select()
          .from(runs)
          .where(eq(runs.id, run?.id ?? ""))
          .limit(1)
      )[0];
      expect(stored?.transcriptUri).toBe(
        `s3://facility-test/transcripts/${orgId}/${run?.id}.jsonl`,
      );
      const loaded = await app.inject({
        method: "GET",
        url: `/v1/runs/${run?.id}/transcript`,
        headers: { cookie },
      });
      expect(loaded.statusCode).toBe(200);
      expect(loaded.headers["content-type"]).toContain("application/x-ndjson");
      expect(loaded.body).toBe(transcript);

      const otherProject = (
        await db
          .insert(projects)
          .values({
            id: newId("proj"),
            orgId,
            name: "Transcript Other Project",
            slug: `transcript-other-${Date.now()}`,
            settings: {},
          })
          .returning()
      )[0];
      const issued = await app.inject({
        method: "POST",
        url: "/v1/keys",
        headers: { cookie },
        payload: { name: "transcript-other-key", roleId: ownerRole, projectId: otherProject?.id },
      });
      const crossProject = await app.inject({
        method: "GET",
        url: `/v1/runs/${run?.id}/transcript`,
        headers: { authorization: `Bearer ${issued.json().secret}` },
      });
      expect(crossProject.statusCode).toBe(404);
    } finally {
      Object.assign(config, previous);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uploads session state and serves the parent archive only to a matching resume run", async () => {
    const archive = gzipSync(Buffer.from("claude state"));
    const objects = new Map<string, Buffer>();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const key = request.url ?? "";
        if (request.method === "PUT") {
          objects.set(key, Buffer.concat(chunks));
          response.writeHead(200).end();
          return;
        }
        const body = objects.get(key);
        if (request.method === "GET" && body) {
          response.writeHead(200, { "content-type": "application/gzip" });
          response.end(body);
          return;
        }
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const previous = {
      s3Bucket: config.s3Bucket,
      s3Endpoint: config.s3Endpoint,
      s3AccessKey: config.s3AccessKey,
      s3SecretKey: config.s3SecretKey,
      awsRegion: config.awsRegion,
    };
    config.s3Bucket = "facility-test";
    config.s3Endpoint = `http://127.0.0.1:${address.port}`;
    config.s3AccessKey = "test";
    config.s3SecretKey = "test";
    config.awsRegion = "us-east-1";
    try {
      const target = await createProjectWithAgent("Session State");
      const parentToken = "frt_session_state_parent";
      const parent = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId: target.projectId,
            agentDefId: target.agent.id,
            mode: "builder",
            engine: "claude_code",
            status: "running",
            sandbox: { runnerTokenHash: await hashKey(parentToken) },
            createdBy: { type: "user", id: "test" },
          })
          .returning()
      )[0];
      const unauth = await app.inject({
        method: "POST",
        url: `/internal/runs/${parent?.id}/session-state`,
        headers: { "content-type": "application/gzip" },
        payload: archive,
      });
      expect(unauth.statusCode).toBe(401);
      const upload = await app.inject({
        method: "POST",
        url: `/internal/runs/${parent?.id}/session-state`,
        headers: {
          authorization: `Bearer ${parentToken}`,
          "content-type": "application/gzip",
        },
        payload: archive,
      });
      expect(upload.statusCode).toBe(200);
      const stored = (
        await db
          .select()
          .from(runs)
          .where(eq(runs.id, parent?.id ?? ""))
          .limit(1)
      )[0];
      expect(stored?.sessionStateUri).toBe(
        `s3://facility-test/session-state/${orgId}/${parent?.id}.tgz`,
      );

      const currentToken = "frt_session_state_current";
      const current = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId: target.projectId,
            agentDefId: target.agent.id,
            mode: "builder",
            engine: "claude_code",
            status: "running",
            sandbox: {
              runnerTokenHash: await hashKey(currentToken),
              bundle: {
                resume: { sessionId: "sess_1", sessionStateFrom: parent?.id, prompt: "go" },
              },
            },
            createdBy: { type: "user", id: "test" },
          })
          .returning()
      )[0];
      const loaded = await app.inject({
        method: "GET",
        url: `/internal/runs/${current?.id}/session-state`,
        headers: { authorization: `Bearer ${currentToken}` },
      });
      expect(loaded.statusCode).toBe(200);
      expect(Buffer.compare(loaded.rawPayload, archive)).toBe(0);

      const otherProject = (
        await db
          .insert(projects)
          .values({
            id: newId("proj"),
            orgId,
            name: "Session State Other",
            slug: `session-state-other-${Date.now()}`,
            settings: {},
          })
          .returning()
      )[0];
      const mismatchToken = "frt_session_state_mismatch";
      const mismatched = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId: otherProject?.id ?? projectId,
            agentDefId: target.agent.id,
            mode: "builder",
            engine: "claude_code",
            status: "running",
            sandbox: {
              runnerTokenHash: await hashKey(mismatchToken),
              bundle: {
                resume: { sessionId: "sess_1", sessionStateFrom: parent?.id, prompt: "go" },
              },
            },
            createdBy: { type: "user", id: "test" },
          })
          .returning()
      )[0];
      const blocked = await app.inject({
        method: "GET",
        url: `/internal/runs/${mismatched?.id}/session-state`,
        headers: { authorization: `Bearer ${mismatchToken}` },
      });
      expect(blocked.statusCode).toBe(404);
    } finally {
      Object.assign(config, previous);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("denies the llm envelope to a spend:read-only principal", async () => {
    const role = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: { name: `spend-only-${Date.now()}`, permissions: ["spend:read"] },
    });
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "spend-only-key", roleId: role.json().id, projectId },
    });
    const requestId = newId("evt");
    await db.insert(llmRequests).values({
      id: requestId,
      orgId,
      projectId,
      provider: "openai",
      model: "gpt-5.5",
      status: "ok",
      costCents: 1,
      latencyMs: 1,
      requestUri: "s3://facility-test/x.json.gz",
      responseUri: "s3://facility-test/x.json.gz",
    });
    // spend:read sees cost (via /v1/spend + the request list) but NOT the full
    // request/response transcript — the envelope now requires audit:read.
    const denied = await app.inject({
      method: "GET",
      url: `/v1/llm-requests/${requestId}/envelope`,
      headers: { authorization: `Bearer ${issued.json().secret}` },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("runs the admin readiness doctor with object-store and audit-chain checks", async () => {
    const objects = new Map<string, Buffer>();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const key = request.url ?? "";
        if (request.method === "PUT") {
          objects.set(key, Buffer.concat(chunks));
          response.writeHead(200).end();
          return;
        }
        const body = objects.get(key);
        if (request.method === "GET" && body) {
          response.writeHead(200, {
            "content-type": "application/json",
            "content-encoding": "gzip",
          });
          response.end(body);
          return;
        }
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const previousGithubAppMetadataReader = app.githubAppMetadataReader;
    const previous = {
      s3Bucket: config.s3Bucket,
      s3Endpoint: config.s3Endpoint,
      s3AccessKey: config.s3AccessKey,
      s3SecretKey: config.s3SecretKey,
      awsRegion: config.awsRegion,
      githubAppId: config.githubAppId,
      githubAppPrivateKey: config.githubAppPrivateKey,
      githubAppWebhookSecret: config.githubAppWebhookSecret,
      githubAppSlug: config.githubAppSlug,
    };
    config.s3Bucket = "facility-test";
    config.s3Endpoint = `http://127.0.0.1:${address.port}`;
    config.s3AccessKey = "test";
    config.s3SecretKey = "test";
    config.awsRegion = "us-east-1";
    config.githubAppId = "1";
    config.githubAppPrivateKey = githubAppTestKey;
    config.githubAppWebhookSecret = "secret";
    config.githubAppSlug = "facility-test";
    app.githubAppMetadataReader = async () => ({
      permissions: { checks: "read" },
      events: ["check_run", "pull_request"],
    });
    const first = await insertAuditEvent(db, {
      orgId,
      actor: { type: "system", id: "doctor-test" },
      action: "doctor.audit.first",
      target: { type: "org", id: orgId },
    });
    const second = await insertAuditEvent(db, {
      orgId,
      actor: { type: "system", id: "doctor-test" },
      action: "doctor.audit.second",
      target: { type: "org", id: orgId },
    });
    if (!first || !second) throw new Error("audit fixture setup failed");
    await db
      .insert(schedulerWatermarks)
      .values({ name: "agent.schedules", lastTick: new Date() })
      .onConflictDoUpdate({
        target: schedulerWatermarks.name,
        set: { lastTick: new Date(), updatedAt: new Date() },
      });
    try {
      const healthy = await app.inject({
        method: "GET",
        url: "/v1/admin/doctor",
        headers: { cookie },
      });
      expect(healthy.statusCode).toBe(200);
      expect(healthy.json().ok).toBe(true);
      expect(checkStatus(healthy.json(), "object_storage")).toBe("pass");
      expect(checkStatus(healthy.json(), "audit_hash_chain")).toBe("pass");
      expect(checkStatus(healthy.json(), "worker_heartbeat")).toBe("pass");
      expect(checkStatus(healthy.json(), "github_app")).toBe("pass");
      expect(checkStatus(healthy.json(), "github_check_run")).toBe("pass");
      expect(
        healthy.json().checks.some((check: { id: string }) => check.id === "aws_sandbox"),
      ).toBe(false);
      // The seeded default profile runs the configured runner image on the docker
      // driver (Docker reachable in the test env). Whether that image is present
      // locally is environmental, so the platform-lane check is pass (image
      // present) or warn (image absent, pulled on first run) — never fail.
      expect(["pass", "warn"]).toContain(checkStatus(healthy.json(), "sandbox_runner"));
      expect([...objects.keys()].some((key) => key.includes("/facility-test/envelopes/"))).toBe(
        true,
      );

      config.githubAppPrivateKey = "not-a-private-key";
      const invalidGithubKey = await app.inject({
        method: "GET",
        url: "/v1/admin/doctor",
        headers: { cookie },
      });
      expect(invalidGithubKey.json().ok).toBe(false);
      expect(checkStatus(invalidGithubKey.json(), "github_app")).toBe("fail");
      expect(JSON.stringify(invalidGithubKey.json())).not.toContain("not-a-private-key");
      config.githubAppPrivateKey = githubAppTestKey;

      app.githubAppMetadataReader = async () => ({
        permissions: { checks: "read" },
        events: ["pull_request"],
      });
      const missingCheckRun = await app.inject({
        method: "GET",
        url: "/v1/admin/doctor",
        headers: { cookie },
      });
      expect(missingCheckRun.json().ok).toBe(false);
      expect(checkStatus(missingCheckRun.json(), "github_check_run")).toBe("fail");
      app.githubAppMetadataReader = async () => ({
        permissions: { checks: "read" },
        events: ["check_run"],
      });

      await db.update(auditEvents).set({ hash: "broken" }).where(eq(auditEvents.id, second.id));
      const broken = await app.inject({
        method: "GET",
        url: "/v1/admin/doctor",
        headers: { cookie },
      });
      expect(broken.statusCode).toBe(200);
      expect(broken.json().ok).toBe(false);
      expect(checkStatus(broken.json(), "audit_hash_chain")).toBe("fail");

      await db
        .update(auditEvents)
        .set({ hash: second.hash, prevHash: first.hash })
        .where(eq(auditEvents.id, second.id));
      await db
        .update(schedulerWatermarks)
        .set({ lastTick: new Date(Date.now() - 10 * 60_000) })
        .where(eq(schedulerWatermarks.name, "agent.schedules"));
      const staleWorker = await app.inject({
        method: "GET",
        url: "/v1/admin/doctor",
        headers: { cookie },
      });
      expect(staleWorker.json().ok).toBe(false);
      expect(checkStatus(staleWorker.json(), "worker_heartbeat")).toBe("fail");
    } finally {
      await db
        .update(auditEvents)
        .set({ hash: second.hash, prevHash: first.hash })
        .where(eq(auditEvents.id, second.id));
      await db.delete(schedulerWatermarks).where(eq(schedulerWatermarks.name, "agent.schedules"));
      Object.assign(config, previous);
      app.githubAppMetadataReader = previousGithubAppMetadataReader;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("filters audit rows by actor and returns newest-first pages", async () => {
    const action = `audit.filtered.${Date.now()}`;
    const first = await insertAuditEvent(db, {
      orgId,
      actor: { type: "key", id: "auditor" },
      action,
      target: { type: "test", id: "first" },
    });
    const second = await insertAuditEvent(db, {
      orgId,
      actor: { type: "key", id: "auditor" },
      action,
      target: { type: "test", id: "second" },
    });
    await insertAuditEvent(db, {
      orgId,
      actor: { type: "key", id: "other" },
      action,
      target: { type: "test", id: "other" },
    });

    const page = await app.inject({
      method: "GET",
      url: `/v1/audit?action=${action}&actor=key:auditor&limit=1`,
      headers: { cookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().items.map((row: { id: string }) => row.id)).toEqual([second?.id]);
    expect(page.json().nextCursor).toBe(second?.seq);
    const next = await app.inject({
      method: "GET",
      url: `/v1/audit?action=${action}&actor=auditor&cursor=${page.json().nextCursor}`,
      headers: { cookie },
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().items.map((row: { id: string }) => row.id)).toEqual([first?.id]);
  });

  it("filters audit rows to a project-scoped key's project and preserves the hash chain", async () => {
    const suffix = Date.now();
    const projectA = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Audit Scoped A", slug: `audit-scoped-a-${suffix}` },
    });
    expect(projectA.statusCode).toBe(200);
    const projectB = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Audit Scoped B", slug: `audit-scoped-b-${suffix}` },
    });
    expect(projectB.statusCode).toBe(200);

    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: `audit-reader-${suffix}`, roleId: ownerRole, projectId: projectA.json().id },
    });
    expect(issued.statusCode).toBe(200);

    const updateA = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectA.json().id}`,
      headers: { authorization: `Bearer ${issued.json().secret}` },
      payload: { description: "project A audit event" },
    });
    expect(updateA.statusCode).toBe(200);
    const updateB = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectB.json().id}`,
      headers: { cookie },
      payload: { description: "project B audit event" },
    });
    expect(updateB.statusCode).toBe(200);

    await expect(verifyAuditChain(db, orgId)).resolves.toEqual({ ok: true, firstBreakSeq: null });

    type AuditRow = { projectId?: string | null; target: { id?: string } };
    const scoped = await app.inject({
      method: "GET",
      url: "/v1/audit?action=project.updated&limit=500",
      headers: { authorization: `Bearer ${issued.json().secret}` },
    });
    expect(scoped.statusCode).toBe(200);
    const scopedItems = scoped.json().items as AuditRow[];
    expect(scopedItems.every((row) => row.projectId === projectA.json().id)).toBe(true);
    expect(scopedItems.some((row) => row.target.id === projectA.json().id)).toBe(true);
    expect(scopedItems.some((row) => row.target.id === projectB.json().id)).toBe(false);

    const orgLevel = await app.inject({
      method: "GET",
      url: "/v1/audit?action=project.updated&limit=500",
      headers: { cookie },
    });
    expect(orgLevel.statusCode).toBe(200);
    const orgItems = orgLevel.json().items as AuditRow[];
    expect(orgItems.some((row) => row.target.id === projectA.json().id)).toBe(true);
    expect(orgItems.some((row) => row.target.id === projectB.json().id)).toBe(true);
  });

  it("groups spend by agent definition, not run id", async () => {
    const agent = (await db.select().from(agentDefs).where(eq(agentDefs.orgId, orgId)).limit(1))[0];
    expect(agent).toBeTruthy();
    if (!agent) throw new Error("agent fixture missing");
    const runA = newId("run");
    const runB = newId("run");
    await db.insert(runs).values([
      {
        id: runA,
        orgId,
        projectId: agent.projectId,
        agentDefId: agent.id,
        mode: "builder",
        engine: "codex",
        createdBy: { type: "test", id: "api" },
      },
      {
        id: runB,
        orgId,
        projectId: agent.projectId,
        agentDefId: agent.id,
        mode: "builder",
        engine: "codex",
        createdBy: { type: "test", id: "api" },
      },
    ]);
    await db.insert(llmRequests).values([
      {
        id: newId("evt"),
        orgId,
        projectId: agent.projectId,
        runId: runA,
        agentDefId: agent.id,
        provider: "openai",
        model: "gpt-5.5",
        status: "ok",
        costCents: 100,
        latencyMs: 10,
      },
      {
        id: newId("evt"),
        orgId,
        projectId: agent.projectId,
        runId: runB,
        agentDefId: agent.id,
        provider: "openai",
        model: "gpt-5.5",
        status: "ok",
        costCents: 125,
        latencyMs: 10,
      },
    ]);
    const spend = await app.inject({
      method: "GET",
      url: "/v1/spend?groupBy=agent",
      headers: { cookie },
    });
    expect(spend.statusCode).toBe(200);
    const row = spend
      .json()
      .find((item: { bucket: string; cost_cents: number }) => item.bucket === agent.id);
    expect(row?.cost_cents).toBeGreaterThanOrEqual(225);
  });

  it("startup assertion catches an undeclared protected route", async () => {
    const bad = await buildApp(config);
    bad.get("/v1/bad-test-route", async () => ({ ok: true }));
    await expect(bad.ready()).rejects.toThrow(/missing permission/i);
    await bad.close();
  });

  it("pins project-scoped keys to their project (404 elsewhere)", async () => {
    const other = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Other", slug: `other-${Date.now()}` },
    });
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "pinned", roleId: ownerRole, projectId },
    });
    const secret = issued.json().secret;
    const own = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(own.statusCode).toBe(200);
    const projectList = await app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(projectList.statusCode).toBe(200);
    expect(projectList.json().map((row: { id: string }) => row.id)).toEqual([projectId]);
    const cross = await app.inject({
      method: "GET",
      url: `/v1/projects/${other.json().id}`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(cross.statusCode).toBe(404);
    // bare-id resources are pinned too
    const otherAgent = (
      await db.select().from(agentDefs).where(eq(agentDefs.projectId, other.json().id)).limit(1)
    )[0];
    expect(otherAgent).toBeTruthy();
    const crossRun = await app.inject({
      method: "POST",
      url: `/v1/projects/${other.json().id}/runs`,
      headers: { cookie },
      payload: {
        mode: "builder",
        engine: "codex",
        agentDefId: otherAgent?.id,
        trigger: { type: "manual", message: "Exercise cross-project run reads" },
      },
    });
    const denied = await app.inject({
      method: "GET",
      url: `/v1/runs/${crossRun.json().id}`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(denied.statusCode).toBe(404);
    await db.insert(budgets).values([
      {
        id: newId("bud"),
        orgId,
        scope: "project",
        projectId,
        period: "daily",
        limitCents: 100,
        mode: "hard",
        enabled: true,
      },
      {
        id: newId("bud"),
        orgId,
        scope: "project",
        projectId: other.json().id,
        period: "daily",
        limitCents: 100,
        mode: "hard",
        enabled: true,
      },
    ]);
    const budgetList = await app.inject({
      method: "GET",
      url: "/v1/budgets",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(budgetList.statusCode).toBe(200);
    expect(
      budgetList.json().every((row: { projectId: string }) => row.projectId === projectId),
    ).toBe(true);
  });

  it("returns 404 when a project-scoped key mutates another project's sandbox profile", async () => {
    const other = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Sandbox Other", slug: `sandbox-other-${Date.now()}` },
    });
    expect(other.statusCode).toBe(200);
    const ownKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "sandbox-project-key", roleId: ownerRole, projectId },
    });
    const otherProfile = (
      await db
        .insert(sandboxProfiles)
        .values({
          id: newId("sbx"),
          orgId,
          projectId: other.json().id,
          name: "other sandbox",
          driver: "docker",
          image: "node:22",
          setup: {},
          resources: {},
          network: {},
        })
        .returning()
    )[0];
    const denied = await app.inject({
      method: "PATCH",
      url: `/v1/sandbox-profiles/${otherProfile?.id}`,
      headers: { authorization: `Bearer ${ownKey.json().secret}` },
      payload: { image: "node:24" },
    });
    expect(denied.statusCode).toBe(404);
  });

  it("stores unique key prefixes so auth is an indexed lookup", async () => {
    const a = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "prefix-a", roleId: viewerRole },
    });
    const b = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "prefix-b", roleId: viewerRole },
    });
    expect(a.json().prefix).not.toBe(b.json().prefix);
    expect(a.json().prefix).toBe(String(a.json().secret).slice(0, 12));
  });

  it("rejects issuing a more privileged role than the caller has", async () => {
    const role = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: { name: `issuer-${Date.now()}`, permissions: ["keys:issue"] },
    });
    expect(role.statusCode).toBe(200);
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "limited-issuer", roleId: role.json().id },
    });
    const denied = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${issued.json().secret}` },
      payload: { name: "owner-escalation", roleId: ownerRole },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("privilege_escalation");
  });

  it("rejects assigning a member into a role more privileged than the caller", async () => {
    const mgrRole = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: { name: `mgr-${Date.now()}`, permissions: ["members:write", "members:read"] },
    });
    const mgrKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "limited-mgr", roleId: mgrRole.json().id },
    });
    const token = mgrKey.json().secret;
    const target = await app.inject({
      method: "POST",
      url: "/v1/members",
      headers: { cookie },
      payload: { email: `target-${Date.now()}@example.com`, roleId: viewerRole },
    });
    // The members-only manager cannot promote anyone (incl. itself) to owner(*).
    const denied = await app.inject({
      method: "PATCH",
      url: `/v1/members/${target.json().userId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { roleId: ownerRole },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("privilege_escalation");
  });

  it("race-safely prevents deleting or demoting the last organization owner", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const isolatedOrgId = newId("org");
    const isolatedUserId = newId("user");
    await db.insert(orgs).values({
      id: isolatedOrgId,
      name: "Last Owner Fixture",
      slug: `last-owner-${suffix}`,
      settings: {},
    });
    await db.insert(users).values({
      id: isolatedUserId,
      email: `last-owner-${suffix}@example.com`,
      status: "active",
    });
    await db.insert(orgMembers).values({
      id: newId("member"),
      orgId: isolatedOrgId,
      userId: isolatedUserId,
      roleId: ownerRole,
    });
    const isolatedCookie = `facility_session=${await mintSessionCookie(
      config,
      isolatedUserId,
      isolatedOrgId,
    )}`;

    const demote = await app.inject({
      method: "PATCH",
      url: `/v1/members/${isolatedUserId}`,
      headers: { cookie: isolatedCookie },
      payload: { roleId: viewerRole },
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe("last_owner_required");

    const remove = await app.inject({
      method: "DELETE",
      url: `/v1/members/${isolatedUserId}`,
      headers: { cookie: isolatedCookie },
    });
    expect(remove.statusCode).toBe(409);
    expect(remove.json().error.code).toBe("last_owner_required");
    const membership = await db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.userId, isolatedUserId));
    expect(membership).toHaveLength(1);
  });

  it("rejects creating a role with permissions the caller does not hold", async () => {
    const rolerRole = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: { name: `roler-${Date.now()}`, permissions: ["roles:write", "roles:read"] },
    });
    const rolerKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "limited-roler", roleId: rolerRole.json().id },
    });
    const token = rolerKey.json().secret;
    const wildcard = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: `escalated-${Date.now()}`, permissions: ["*"] },
    });
    expect(wildcard.statusCode).toBe(403);
    expect(wildcard.json().error.code).toBe("privilege_escalation");
    const bogus = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: `bogus-${Date.now()}`, permissions: ["not:aperm"] },
    });
    expect(bogus.statusCode).toBe(400);
    expect(bogus.json().error.code).toBe("invalid_permission");
  });

  it("blocks project-scoped keys from another project's proposal, task, key, budget, and registry item", async () => {
    const other = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Scoped Other", slug: `scoped-other-${Date.now()}` },
    });
    const otherProjectId = other.json().id;
    const ownKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "own-project-owner", roleId: ownerRole, projectId },
    });
    const otherKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "other-project-owner", roleId: ownerRole, projectId: otherProjectId },
    });
    const orgKey = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "org-owner", roleId: ownerRole },
    });
    const type = (
      await db
        .insert(actionTypes)
        .values({
          id: newId("act"),
          orgId,
          name: `scope_test_${Date.now()}`,
          payloadSchema: { type: "object", required: [] },
          resolver: { type: "permission", config: {} },
          executor: { type: "none", config: {} },
          defaultTtlHours: 1,
        })
        .returning()
    )[0];
    const proposal = (
      await db
        .insert(proposals)
        .values({
          id: newId("prop"),
          orgId,
          projectId: otherProjectId,
          actionTypeId: type?.id ?? "",
          payload: {},
          contextMd: "cross project",
          expiresAt: new Date(Date.now() + 3600_000),
        })
        .returning()
    )[0];
    const task = (
      await db
        .insert(poTasks)
        .values({
          id: newId("task"),
          orgId,
          projectId: otherProjectId,
          title: "Cross task",
          bodyMd: "body",
          wsjf: {},
        })
        .returning()
    )[0];
    const auth = { authorization: `Bearer ${ownKey.json().secret}` };
    const readProposal = await app.inject({
      method: "GET",
      url: `/v1/proposals/${proposal?.id}`,
      headers: auth,
    });
    expect(readProposal.statusCode).toBe(404);
    const mutateTask = await app.inject({
      method: "POST",
      url: `/v1/tasks/${task?.id}/transition`,
      headers: auth,
      payload: { status: "created" },
    });
    expect(mutateTask.statusCode).toBe(404);
    const revokeKey = await app.inject({
      method: "DELETE",
      url: `/v1/keys/${otherKey.json().id}`,
      headers: auth,
    });
    expect(revokeKey.statusCode).toBe(404);
    const revokeOrgKey = await app.inject({
      method: "DELETE",
      url: `/v1/keys/${orgKey.json().id}`,
      headers: auth,
    });
    expect(revokeOrgKey.statusCode).toBe(404);
    const budget = await app.inject({
      method: "POST",
      url: "/v1/budgets",
      headers: { cookie },
      payload: {
        scope: "project",
        projectId: otherProjectId,
        period: "daily",
        limitCents: 100,
        mode: "hard",
      },
    });
    expect(budget.statusCode).toBe(200);
    const registry = await app.inject({
      method: "POST",
      url: "/v1/registry/items",
      headers: { cookie },
      payload: {
        scope: "project",
        projectId: otherProjectId,
        kind: "skill",
        name: `cross-scope-skill-${Date.now()}`,
        content: "body",
      },
    });
    expect(registry.statusCode).toBe(200);
    const versionId = registry.json().versions[0].id;
    const readBudget = await app.inject({
      method: "GET",
      url: `/v1/budgets/${budget.json().id}`,
      headers: auth,
    });
    expect(readBudget.statusCode).toBe(404);
    const patchBudget = await app.inject({
      method: "PATCH",
      url: `/v1/budgets/${budget.json().id}`,
      headers: auth,
      payload: { limitCents: 200 },
    });
    expect(patchBudget.statusCode).toBe(404);
    const deleteBudget = await app.inject({
      method: "DELETE",
      url: `/v1/budgets/${budget.json().id}`,
      headers: auth,
    });
    expect(deleteBudget.statusCode).toBe(404);
    const readRegistry = await app.inject({
      method: "GET",
      url: `/v1/registry/items/${registry.json().id}`,
      headers: auth,
    });
    expect(readRegistry.statusCode).toBe(404);
    const versionRegistry = await app.inject({
      method: "POST",
      url: `/v1/registry/items/${registry.json().id}/versions`,
      headers: auth,
      payload: { content: "v2" },
    });
    expect(versionRegistry.statusCode).toBe(404);
    const publishRegistry = await app.inject({
      method: "POST",
      url: `/v1/registry/versions/${versionId}/publish`,
      headers: auth,
    });
    expect(publishRegistry.statusCode).toBe(404);
    const deprecateRegistry = await app.inject({
      method: "POST",
      url: `/v1/registry/versions/${versionId}/deprecate`,
      headers: auth,
    });
    expect(deprecateRegistry.statusCode).toBe(404);
  });

  it("returns 403 when project-scoped keys call org-admin endpoints", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "project-admin-denied", roleId: ownerRole, projectId },
    });
    const auth = { authorization: `Bearer ${issued.json().secret}` };
    for (const url of ["/v1/org", "/v1/members", "/v1/roles", "/v1/providers"]) {
      const response = await app.inject({ method: "GET", url, headers: auth });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("project_scope_forbidden");
    }
  });

  it("returns 409 for an already-approved proposal without re-executing it", async () => {
    const installation = (
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId,
          installationId: Math.floor(Math.random() * 2_000_000_000) + 1,
          accountLogin: `facility-test-${Date.now()}`,
          targetType: "Organization",
        })
        .returning()
    )[0];
    await db.insert(repos).values({
      id: newId("repo"),
      orgId,
      projectId,
      installationId: installation?.id,
      owner: `facility-test-${Date.now()}`,
      name: "repo",
      defaultBranch: "main",
    });
    const task = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/tasks`,
      headers: { cookie },
      payload: { title: "Create issue once", bodyMd: "body", wsjf: {} },
    });
    const proposed = await app.inject({
      method: "POST",
      url: `/v1/tasks/${task.json().id}/propose`,
      headers: { cookie },
    });
    const previousFactory = app.githubClientFactory;
    app.githubClientFactory = fakeGithubFactory();
    try {
      const approved = await app.inject({
        method: "POST",
        url: `/v1/proposals/${proposed.json().id}/decide`,
        headers: { cookie: approverCookie },
        payload: { decision: "approve" },
      });
      expect(approved.statusCode).toBe(200);
      const repeated = await app.inject({
        method: "POST",
        url: `/v1/proposals/${proposed.json().id}/decide`,
        headers: { cookie: approverCookie },
        payload: { decision: "approve" },
      });
      expect(repeated.statusCode).toBe(409);
      const executed = await db
        .select()
        .from(proposalEvents)
        .where(
          sql`${proposalEvents.proposalId} = ${proposed.json().id} and ${proposalEvents.type} = 'executed'`,
        );
      expect(executed).toHaveLength(1);
    } finally {
      app.githubClientFactory = previousFactory;
    }
  });

  it("ignores forbidden projectId and orgId fields on PATCH", async () => {
    const other = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Patch Other", slug: `patch-other-${Date.now()}` },
    });
    const task = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/tasks`,
      headers: { cookie },
      payload: { title: "Patch guarded", bodyMd: "body", wsjf: {} },
    });
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/tasks/${task.json().id}`,
      headers: { cookie },
      payload: { title: "Patch guarded updated", projectId: other.json().id, orgId: "org_bad" },
    });
    expect(patched.statusCode).toBe(200);
    const row = (await db.select().from(poTasks).where(eq(poTasks.id, task.json().id)).limit(1))[0];
    expect(row?.title).toBe("Patch guarded updated");
    expect(row?.projectId).toBe(projectId);
    expect(row?.orgId).toBe(orgId);
  });

  it("rejects triggering a run with an agent definition from another project", async () => {
    const projectA = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Run A", slug: `run-a-${Date.now()}` },
    });
    const projectB = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Run B", slug: `run-b-${Date.now()}` },
    });
    const foreignAgent = (
      await db.select().from(agentDefs).where(eq(agentDefs.projectId, projectB.json().id)).limit(1)
    )[0];
    expect(foreignAgent).toBeTruthy();
    const run = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectA.json().id}/runs`,
      headers: { cookie },
      payload: { mode: "builder", engine: "codex", agentDefId: foreignAgent?.id },
    });
    expect(run.statusCode).toBe(400);
    expect(run.json().error.code).toBe("agent_not_in_project");
  });

  it("persists the selected agent's effective engine for manually triggered runs", async () => {
    const project = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Engine Truth", slug: `engine-truth-${Date.now()}` },
    });
    const agent = (
      await db.select().from(agentDefs).where(eq(agentDefs.projectId, project.json().id)).limit(1)
    )[0];
    if (!agent) throw new Error("seeded agent fixture missing");
    await db.update(agentDefs).set({ engine: "claude_code" }).where(eq(agentDefs.id, agent.id));

    const run = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.json().id}/runs`,
      headers: { cookie },
      payload: {
        mode: "manual",
        engine: "codex",
        agentDefId: agent.id,
        trigger: { type: "manual", message: "Exercise effective engine selection" },
      },
    });

    expect(run.statusCode).toBe(200);
    expect(run.json().engine).toBe("claude_code");
    expect(run.json().mode).toBe(agent.name);
  });

  it("requires an objective for builder runs without governed issue context", async () => {
    const project = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Builder Objective", slug: `builder-objective-${Date.now()}` },
    });
    const builder = (
      await db
        .select()
        .from(agentDefs)
        .where(and(eq(agentDefs.projectId, project.json().id), eq(agentDefs.name, "builder")))
        .limit(1)
    )[0];
    if (!builder) throw new Error("seeded builder fixture missing");
    const runsBeforeRejection = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.projectId, project.json().id));

    for (const trigger of [
      { type: "manual", source: "agent-page" },
      { type: "manual", source: "agent-page", message: "   " },
    ]) {
      const rejected = await app.inject({
        method: "POST",
        url: `/v1/projects/${project.json().id}/runs`,
        headers: { cookie },
        payload: { agentDefId: builder.id, trigger },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error.code).toBe("run_objective_required");
    }
    expect(
      await db.select({ id: runs.id }).from(runs).where(eq(runs.projectId, project.json().id)),
    ).toHaveLength(runsBeforeRejection.length);

    const accepted = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.json().id}/runs`,
      headers: { cookie },
      payload: {
        agentDefId: builder.id,
        trigger: {
          type: "manual",
          source: "agent-page",
          message: "Implement the next approved Platform task",
        },
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().trigger).toMatchObject({
      type: "manual",
      source: "agent-page",
      message: "Implement the next approved Platform task",
    });

    for (const trigger of [
      { source: "web", approvedPlan: "Ship the approved Platform plan" },
      { source: "cli", input: "Implement the requested CLI task" },
    ]) {
      const objectiveRun = await app.inject({
        method: "POST",
        url: `/v1/projects/${project.json().id}/runs`,
        headers: { cookie },
        payload: { agentDefId: builder.id, trigger },
      });
      expect(objectiveRun.statusCode).toBe(200);
    }

    const issueRetry = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.json().id}/runs`,
      headers: { cookie },
      payload: {
        agentDefId: builder.id,
        trigger: {
          type: "web_issue",
          source: "web",
          retryOf: accepted.json().id,
          repo: { owner: "theam", name: "tam-os" },
          issue: { number: 42 },
        },
      },
    });
    expect(issueRetry.statusCode).toBe(200);

    const cliInput = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.json().id}/runs`,
      headers: { cookie },
      payload: {
        agentDefId: builder.id,
        trigger: {
          source: "cli",
          agentName: "builder",
          input: { objective: "Implement the next approved Platform task" },
        },
      },
    });
    expect(cliInput.statusCode).toBe(200);
  });

  it("creates and dispatches each scheduled run exactly once per UTC minute", async () => {
    await db.delete(schedulerWatermarks);
    const target = await createProjectWithAgent("Scheduled Run");
    await db
      .update(agentDefs)
      .set({
        triggers: [{ type: "schedule", config: { cron: "30 12 * * *", timezone: "UTC" } }],
      })
      .where(eq(agentDefs.id, target.agent.id));
    const jobs: Array<{
      queue: string;
      data: Record<string, unknown>;
      options?: { singletonKey?: string };
    }> = [];
    const enqueue = async (
      queue: string,
      data: Record<string, unknown>,
      options?: { singletonKey?: string },
    ) => {
      jobs.push({ queue, data, options });
      return null;
    };
    const now = new Date("2026-07-16T12:30:42.000Z");
    const first = await runAgentSchedules(config, enqueue, now);
    const second = await runAgentSchedules(config, enqueue, now);
    // The integration database may contain other due agents from earlier
    // scenarios; this agent must contribute one new run on the first pass.
    expect(first.created).toBeGreaterThanOrEqual(1);
    expect(second.created).toBe(0);
    const scheduled = await db.select().from(runs).where(eq(runs.agentDefId, target.agent.id));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      mode: target.agent.name,
      engine: target.agent.engine,
      status: "queued",
      trigger: {
        type: "schedule",
        scheduledFor: "2026-07-16T12:30:00.000Z",
      },
    });
    expect(jobs.filter((job) => job.options?.singletonKey === scheduled[0]?.id)).toHaveLength(2);

    const catchUpTarget = await createProjectWithAgent("Scheduled Catch-up");
    await db
      .update(agentDefs)
      .set({ triggers: [{ type: "schedule", config: { cron: "* * * * *", timezone: "UTC" } }] })
      .where(eq(agentDefs.id, catchUpTarget.agent.id));
    await db
      .update(schedulerWatermarks)
      .set({ lastTick: new Date("2026-07-16T12:27:00.000Z") })
      .where(eq(schedulerWatermarks.name, "agent.schedules"));
    const catchUp = await runAgentSchedules(config, enqueue, now);
    expect(catchUp.caughtUpMinutes).toBe(2);
    const caughtUpRuns = await db
      .select()
      .from(runs)
      .where(eq(runs.agentDefId, catchUpTarget.agent.id));
    expect(
      caughtUpRuns.map((run) => (run.trigger as { scheduledFor: string }).scheduledFor).sort(),
    ).toEqual(["2026-07-16T12:28:00.000Z", "2026-07-16T12:29:00.000Z", "2026-07-16T12:30:00.000Z"]);
  });

  it("creates a greenfield GitHub repo through the App and connects the repo row", async () => {
    const project = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Greenfield", slug: `greenfield-${Date.now()}` },
    });
    expect(project.statusCode).toBe(200);
    const installationId = Date.now();
    const owner = `octo-${installationId}`;
    const installation = (
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId,
          installationId,
          accountLogin: owner,
          targetType: "Organization",
        })
        .returning()
    )[0];
    if (!installation) throw new Error("installation fixture missing");
    let createArgs: Record<string, unknown> | undefined;
    app.githubClientFactory = async (actualInstallationId) => {
      expect(actualInstallationId).toBe(installationId);
      return {
        rest: {
          repos: {
            createInOrg: async (args: Record<string, unknown>) => {
              createArgs = args;
              return {
                data: {
                  name: String(args.name),
                  owner: { login: String(args.org) },
                  default_branch: "main",
                },
              };
            },
          },
        },
      } as never;
    };

    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.json().id}/repos`,
      headers: { cookie },
      payload: {
        owner,
        name: "created-repo",
        defaultBranch: "main",
        mode: "create",
        private: true,
        autoInit: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(createArgs).toEqual({
      org: owner,
      name: "created-repo",
      private: true,
      description: undefined,
      auto_init: false,
    });
    const repo = (
      await db.select().from(repos).where(eq(repos.id, response.json().id)).limit(1)
    )[0];
    expect(repo?.installationId).toBe(installation.id);
    expect(repo?.owner).toBe(owner);
    expect(repo?.name).toBe("created-repo");
    app.githubClientFactory = undefined;
  });

  it("connects an existing GitHub repo to its App installation and discovers its branch", async () => {
    const project = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Existing Repo", slug: `existing-repo-${Date.now()}` },
    });
    const installationId = Date.now() + 1;
    const owner = `existing-${installationId}`;
    const installation = (
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId,
          installationId,
          accountLogin: owner,
          targetType: "Organization",
        })
        .returning()
    )[0];
    if (!installation) throw new Error("installation fixture missing");
    let lookupArgs: Record<string, unknown> | undefined;
    app.githubClientFactory = async (actualInstallationId) => {
      expect(actualInstallationId).toBe(installationId);
      return {
        rest: {
          repos: {
            get: async (args: Record<string, unknown>) => {
              lookupArgs = args;
              return {
                data: {
                  name: "existing-repo",
                  owner: { login: owner },
                  default_branch: "trunk",
                },
              };
            },
          },
        },
      } as never;
    };

    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/projects/${project.json().id}/repos`,
        headers: { cookie },
        payload: { owner, name: "existing-repo", mode: "connect" },
      });

      expect(response.statusCode).toBe(200);
      expect(lookupArgs).toEqual({ owner, repo: "existing-repo" });
      expect(response.json()).toMatchObject({
        installationId: installation.id,
        owner,
        name: "existing-repo",
        defaultBranch: "trunk",
      });
    } finally {
      app.githubClientFactory = undefined;
    }
  });

  it("rejects connecting a repo when the GitHub App is not installed for its owner", async () => {
    const project = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Missing Install", slug: `missing-install-${Date.now()}` },
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.json().id}/repos`,
      headers: { cookie },
      payload: { owner: `uninstalled-${Date.now()}`, name: "repo", mode: "connect" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("github_installation_required");
  });

  it("accepts signed generic inbound payloads and rejects bad signatures", async () => {
    const secret = "generic-inbound-secret";
    const fingerprint = `generic:${Date.now()}`;
    const integration = (
      await db
        .insert(integrations)
        .values({
          id: newId("int"),
          orgId,
          projectId,
          kind: "generic_inbound",
          name: "Generic Inbound",
          config: {},
          sealedSecret: await seal(secret, masterKey),
        })
        .returning()
    )[0];
    if (!integration) throw new Error("integration fixture missing");
    const payload = Buffer.from(
      JSON.stringify({
        eventType: "alert",
        title: "Generic alert",
        bodyMd: "Generic alert body",
        severity: "error",
        fingerprint,
      }),
    );
    const bad = await app.inject({
      method: "POST",
      url: `/webhooks/inbound/${integration.id}`,
      headers: {
        "content-type": "application/json",
        "x-facility-signature": "sha256=bad",
      },
      payload,
    });
    expect(bad.statusCode).toBe(401);
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const delivery = newId("evt");
    const eventType = "alert";
    const signature = `sha256=${createHmac("sha256", secret)
      .update(`${timestamp}.${delivery}.${eventType}.`)
      .update(payload)
      .digest("hex")}`;
    const valid = await app.inject({
      method: "POST",
      url: `/webhooks/inbound/${integration.id}`,
      headers: {
        "content-type": "application/json",
        "x-facility-delivery": delivery,
        "x-facility-event": eventType,
        "x-facility-timestamp": timestamp,
        "x-facility-signature": signature,
      },
      payload,
    });
    expect(valid.statusCode).toBe(202);
    const replay = await app.inject({
      method: "POST",
      url: `/webhooks/inbound/${integration.id}`,
      headers: {
        "content-type": "application/json",
        "x-facility-delivery": delivery,
        "x-facility-event": eventType,
        "x-facility-timestamp": timestamp,
        "x-facility-signature": signature,
      },
      payload,
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({ ok: true, replayed: true });
    const replayWithChangedDelivery = await app.inject({
      method: "POST",
      url: `/webhooks/inbound/${integration.id}`,
      headers: {
        "content-type": "application/json",
        "x-facility-delivery": newId("evt"),
        "x-facility-event": eventType,
        "x-facility-timestamp": timestamp,
        "x-facility-signature": signature,
      },
      payload,
    });
    expect(replayWithChangedDelivery.statusCode).toBe(401);
    const staleTimestamp = String(Number(timestamp) - 301);
    const staleSignature = `sha256=${createHmac("sha256", secret)
      .update(`${staleTimestamp}.${delivery}.${eventType}.`)
      .update(payload)
      .digest("hex")}`;
    const stale = await app.inject({
      method: "POST",
      url: `/webhooks/inbound/${integration.id}`,
      headers: {
        "content-type": "application/json",
        "x-facility-delivery": delivery,
        "x-facility-event": eventType,
        "x-facility-timestamp": staleTimestamp,
        "x-facility-signature": staleSignature,
      },
      payload,
    });
    expect(stale.statusCode).toBe(401);
    const malformedPayload = Buffer.from("{");
    const malformedDelivery = newId("evt");
    const malformedSignature = `sha256=${createHmac("sha256", secret)
      .update(`${timestamp}.${malformedDelivery}.${eventType}.`)
      .update(malformedPayload)
      .digest("hex")}`;
    const malformed = await app.inject({
      method: "POST",
      url: `/webhooks/inbound/${integration.id}`,
      headers: {
        "content-type": "application/json",
        "x-facility-delivery": malformedDelivery,
        "x-facility-event": eventType,
        "x-facility-timestamp": timestamp,
        "x-facility-signature": malformedSignature,
      },
      payload: malformedPayload,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("bad_request");
    const events = await db
      .select()
      .from(inboundEvents)
      .where(eq(inboundEvents.integrationId, integration.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.verified).toBe(true);
    expect(events[0]?.processedAt).toBeTruthy();
    const issue = (
      await db
        .select()
        .from(platformIssues)
        .where(eq(platformIssues.fingerprint, fingerprint))
        .limit(1)
    )[0];
    expect(issue?.projectId).toBe(projectId);
    expect(issue?.title).toBe("Generic alert");
    expect(issue?.severity).toBe("error");

    await db
      .update(integrations)
      .set({ enabled: false })
      .where(eq(integrations.id, integration.id));
    const revokedDelivery = newId("evt");
    const revokedSignature = `sha256=${createHmac("sha256", secret)
      .update(`${timestamp}.${revokedDelivery}.${eventType}.`)
      .update(payload)
      .digest("hex")}`;
    const revoked = await app.inject({
      method: "POST",
      url: `/webhooks/inbound/${integration.id}`,
      headers: {
        "content-type": "application/json",
        "x-facility-delivery": revokedDelivery,
        "x-facility-event": eventType,
        "x-facility-timestamp": timestamp,
        "x-facility-signature": revokedSignature,
      },
      payload,
    });
    expect(revoked.statusCode).toBe(401);
  });

  it("rejects cross-project and cross-tenant targets from project-scoped inbound integrations", async () => {
    const secret = "project-scoped-inbound-secret";
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const otherProject = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Other inbound project",
          slug: `other-inbound-${suffix}`,
          settings: {},
        })
        .returning()
    )[0];
    const foreignOrgId = newId("org");
    await db.insert(orgs).values({
      id: foreignOrgId,
      name: "Foreign inbound org",
      slug: `foreign-inbound-${suffix}`,
      settings: {},
    });
    const foreignProject = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId: foreignOrgId,
          name: "Foreign inbound project",
          slug: `foreign-inbound-${suffix}`,
          settings: {},
        })
        .returning()
    )[0];
    const integration = (
      await db
        .insert(integrations)
        .values({
          id: newId("int"),
          orgId,
          projectId,
          kind: "generic_inbound",
          name: "Project-scoped inbound",
          config: {},
          sealedSecret: await seal(secret, masterKey),
        })
        .returning()
    )[0];
    if (!integration || !otherProject || !foreignProject) {
      throw new Error("project scope fixtures missing");
    }

    const attemptTarget = async (targetProjectId: string, label: string) => {
      const fingerprint = `${label}:${suffix}`;
      const payload = Buffer.from(
        JSON.stringify({
          projectId: targetProjectId,
          title: "Must not cross project scope",
          fingerprint,
        }),
      );
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const delivery = newId("evt");
      const eventType = "alert";
      const signature = `sha256=${createHmac("sha256", secret)
        .update(`${timestamp}.${delivery}.${eventType}.`)
        .update(payload)
        .digest("hex")}`;
      const response = await app.inject({
        method: "POST",
        url: `/webhooks/inbound/${integration.id}`,
        headers: {
          "content-type": "application/json",
          "x-facility-delivery": delivery,
          "x-facility-event": eventType,
          "x-facility-timestamp": timestamp,
          "x-facility-signature": signature,
        },
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("generic_inbound_project_scope_mismatch");
      expect(
        await db.select().from(platformIssues).where(eq(platformIssues.fingerprint, fingerprint)),
      ).toHaveLength(0);
    };

    await attemptTarget(otherProject.id, "cross-project");
    await attemptTarget(foreignProject.id, "cross-tenant");
  });

  it("routes organization-scoped inbound integrations only within their organization", async () => {
    const secret = "org-scoped-inbound-secret";
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const sameOrgProject = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Organization-scoped inbound project",
          slug: `org-inbound-${suffix}`,
          settings: {},
        })
        .returning()
    )[0];
    const foreignOrgId = newId("org");
    await db.insert(orgs).values({
      id: foreignOrgId,
      name: "Foreign organization-scoped inbound org",
      slug: `foreign-org-inbound-${suffix}`,
      settings: {},
    });
    const foreignProject = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId: foreignOrgId,
          name: "Foreign organization-scoped inbound project",
          slug: `foreign-org-inbound-${suffix}`,
          settings: {},
        })
        .returning()
    )[0];
    const integration = (
      await db
        .insert(integrations)
        .values({
          id: newId("int"),
          orgId,
          projectId: null,
          kind: "generic_inbound",
          name: "Organization-scoped inbound",
          config: {},
          sealedSecret: await seal(secret, masterKey),
        })
        .returning()
    )[0];
    if (!integration || !sameOrgProject || !foreignProject) {
      throw new Error("organization scope fixtures missing");
    }

    const post = async (targetProjectId: string, fingerprint: string, enqueueRun = false) => {
      const payload = Buffer.from(
        JSON.stringify({
          projectId: targetProjectId,
          title: "Organization-scoped inbound event",
          fingerprint,
          ...(enqueueRun ? { run: { enqueue: true } } : {}),
        }),
      );
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const delivery = newId("evt");
      const eventType = "alert";
      const signature = `sha256=${createHmac("sha256", secret)
        .update(`${timestamp}.${delivery}.${eventType}.`)
        .update(payload)
        .digest("hex")}`;
      return app.inject({
        method: "POST",
        url: `/webhooks/inbound/${integration.id}`,
        headers: {
          "content-type": "application/json",
          "x-facility-delivery": delivery,
          "x-facility-event": eventType,
          "x-facility-timestamp": timestamp,
          "x-facility-signature": signature,
        },
        payload,
      });
    };

    const sameOrgFingerprint = `org-inbound-success:${suffix}`;
    const sameOrgResponse = await post(sameOrgProject.id, sameOrgFingerprint);
    expect(sameOrgResponse.statusCode).toBe(202);
    expect(
      (
        await db
          .select()
          .from(platformIssues)
          .where(eq(platformIssues.fingerprint, sameOrgFingerprint))
      )[0]?.projectId,
    ).toBe(sameOrgProject.id);

    const runCountBefore = Number(
      (await db.select({ count: sql<number>`count(*)` }).from(runs))[0]?.count ?? 0,
    );
    const foreignFingerprint = `org-inbound-cross-tenant:${suffix}`;
    const foreignResponse = await post(foreignProject.id, foreignFingerprint, true);
    expect(foreignResponse.statusCode).toBe(400);
    expect(foreignResponse.json().error.code).toBe("generic_inbound_project_not_found");
    expect(
      await db
        .select()
        .from(platformIssues)
        .where(eq(platformIssues.fingerprint, foreignFingerprint)),
    ).toHaveLength(0);
    expect(
      Number((await db.select({ count: sql<number>`count(*)` }).from(runs))[0]?.count ?? 0),
    ).toBe(runCountBefore);
  });

  it("does not mutate another project's issue through an inbound fingerprint collision", async () => {
    const secret = "fingerprint-scoped-inbound-secret";
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const otherProject = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Fingerprint owner project",
          slug: `fingerprint-owner-${suffix}`,
          settings: {},
        })
        .returning()
    )[0];
    const integration = (
      await db
        .insert(integrations)
        .values({
          id: newId("int"),
          orgId,
          projectId,
          kind: "generic_inbound",
          name: "Fingerprint-scoped inbound",
          config: {},
          sealedSecret: await seal(secret, masterKey),
        })
        .returning()
    )[0];
    if (!integration || !otherProject) throw new Error("fingerprint scope fixtures missing");

    const post = async (body: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify(body));
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const delivery = newId("evt");
      const eventType = "alert";
      const signature = `sha256=${createHmac("sha256", secret)
        .update(`${timestamp}.${delivery}.${eventType}.`)
        .update(payload)
        .digest("hex")}`;
      return app.inject({
        method: "POST",
        url: `/webhooks/inbound/${integration.id}`,
        headers: {
          "content-type": "application/json",
          "x-facility-delivery": delivery,
          "x-facility-event": eventType,
          "x-facility-timestamp": timestamp,
          "x-facility-signature": signature,
        },
        payload,
      });
    };

    const legacyFingerprint = `legacy-fingerprint-owner:${suffix}`;
    const legacyIssue = (
      await db
        .insert(platformIssues)
        .values({
          id: newId("iss"),
          orgId,
          projectId: otherProject.id,
          kind: "existing_issue",
          severity: "error",
          fingerprint: legacyFingerprint,
          title: "Owned by another project",
          bodyMd: "Original issue body",
          state: "acked",
        })
        .returning()
    )[0];
    const legacyResponse = await post({
      fingerprint: legacyFingerprint,
      title: "Attacker-controlled replacement",
      bodyMd: "Must not overwrite",
    });
    expect(legacyResponse.statusCode).toBe(400);
    expect(legacyResponse.json().error.code).toBe("generic_inbound_fingerprint_scope_mismatch");
    expect(
      (
        await db
          .select()
          .from(platformIssues)
          .where(eq(platformIssues.id, legacyIssue?.id ?? ""))
      )[0],
    ).toMatchObject({
      projectId: otherProject.id,
      kind: "existing_issue",
      title: "Owned by another project",
      bodyMd: "Original issue body",
      state: "acked",
      count: 1,
    });

    const recoveryFingerprint = `recovery-fingerprint-owner:${suffix}`;
    const recoveryIssue = (
      await db
        .insert(platformIssues)
        .values({
          id: newId("iss"),
          orgId,
          projectId: otherProject.id,
          kind: "deployment_failure",
          severity: "error",
          fingerprint: recoveryFingerprint,
          title: "Other project deployment failure",
          bodyMd: "Failure is still active",
          state: "open",
        })
        .returning()
    )[0];
    const recoveryResponse = await post({
      schema: "facility.signal.v1",
      type: "deployment",
      status: "recovered",
      fingerprint: recoveryFingerprint,
      source: "untrusted-project-hook",
    });
    expect(recoveryResponse.statusCode).toBe(400);
    expect(recoveryResponse.json().error.code).toBe("generic_inbound_fingerprint_scope_mismatch");
    expect(
      (
        await db
          .select()
          .from(platformIssues)
          .where(eq(platformIssues.id, recoveryIssue?.id ?? ""))
      )[0],
    ).toMatchObject({
      projectId: otherProject.id,
      title: "Other project deployment failure",
      bodyMd: "Failure is still active",
      state: "open",
      count: 1,
    });
  });

  it("does not let one integration's delivery id suppress another's identical id", async () => {
    // Regression: inbound idempotency keys on `in_${integration.id}_${deliveryId}`,
    // not a global `in_${deliveryId}`. Two integrations that happen to emit the
    // same delivery id must BOTH process — the first must not shadow the second.
    const secret = "shared-inbound-secret";
    const delivery = newId("evt");
    const make = async (label: string) =>
      (
        await db
          .insert(integrations)
          .values({
            id: newId("int"),
            orgId,
            projectId,
            kind: "generic_inbound",
            name: label,
            config: { projectId },
            sealedSecret: await seal(secret, masterKey),
          })
          .returning()
      )[0];
    const a = await make("Inbound A");
    const b = await make("Inbound B");
    if (!a || !b) throw new Error("integration fixtures missing");

    const post = async (integrationId: string, fingerprint: string) => {
      const payload = Buffer.from(
        JSON.stringify({ eventType: "alert", title: fingerprint, bodyMd: "b", fingerprint }),
      );
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const eventType = "alert";
      const signature = `sha256=${createHmac("sha256", secret)
        .update(`${timestamp}.${delivery}.${eventType}.`)
        .update(payload)
        .digest("hex")}`;
      return app.inject({
        method: "POST",
        url: `/webhooks/inbound/${integrationId}`,
        headers: {
          "content-type": "application/json",
          "x-facility-delivery": delivery,
          "x-facility-event": eventType,
          "x-facility-timestamp": timestamp,
          "x-facility-signature": signature,
        },
        payload,
      });
    };

    const fpA = `shared-a:${delivery}`;
    const fpB = `shared-b:${delivery}`;
    expect((await post(a.id, fpA)).statusCode).toBe(202);
    expect((await post(b.id, fpB)).statusCode).toBe(202);

    expect(
      await db
        .select()
        .from(inboundEvents)
        .where(eq(inboundEvents.id, `in_${a.id}_${delivery}`)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(inboundEvents)
        .where(eq(inboundEvents.id, `in_${b.id}_${delivery}`)),
    ).toHaveLength(1);
    // Both fully processed — each raised its own issue, so the second wasn't dropped.
    expect(
      await db.select().from(platformIssues).where(eq(platformIssues.fingerprint, fpA)),
    ).toHaveLength(1);
    expect(
      await db.select().from(platformIssues).where(eq(platformIssues.fingerprint, fpB)),
    ).toHaveLength(1);
  });

  it("manages integrations and rotates one-time webhook secrets", async () => {
    const managedCatalogRow = (
      await db
        .insert(integrations)
        .values({
          id: newId("int"),
          orgId,
          kind: "github_app",
          name: "Platform-managed GitHub App",
          config: {},
          enabled: false,
        })
        .returning()
    )[0];
    const created = await app.inject({
      method: "POST",
      url: "/v1/integrations",
      headers: { cookie },
      payload: {
        projectId,
        kind: "generic_inbound",
        name: `Inbound managed ${Date.now()}`,
        config: { projectId },
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created.json().webhookUrl).toContain(`/webhooks/inbound/${created.json().id}`);
    expect(created.json()).not.toHaveProperty("sealedSecret");

    const fetched = await app.inject({
      method: "GET",
      url: `/v1/integrations/${created.json().id}`,
      headers: { cookie },
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().hasSecret).toBe(true);
    expect(fetched.json()).not.toHaveProperty("secret");

    const rotated = await app.inject({
      method: "POST",
      url: `/v1/integrations/${created.json().id}/rotate-secret`,
      headers: { cookie },
      payload: {},
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().secret).not.toBe(created.json().secret);

    const disabled = await app.inject({
      method: "DELETE",
      url: `/v1/integrations/${created.json().id}`,
      headers: { cookie },
    });
    expect(disabled.statusCode).toBe(200);
    const listed = await app.inject({
      method: "GET",
      url: "/v1/integrations?enabled=false&limit=200",
      headers: { cookie },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().some((row: { id: string }) => row.id === created.json().id)).toBe(true);
    expect(listed.json().some((row: { id: string }) => row.id === managedCatalogRow?.id)).toBe(
      true,
    );
  });

  it("rejects unsupported outbound webhook event subscriptions", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrations",
      headers: { cookie },
      payload: {
        projectId,
        kind: "webhook",
        name: `Invalid outbound ${Date.now()}`,
        config: { url: "https://hooks.example.test/facility", events: ["run.started"] },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_webhook_events");
  });

  it("queues and signs durable outbound webhook deliveries for terminal runs", async () => {
    const target = await createProjectWithAgent("Outbound Webhook Run");
    const secret = "outbound-webhook-secret-at-least-32-bytes";
    const integration = await app.inject({
      method: "POST",
      url: "/v1/integrations",
      headers: { cookie },
      payload: {
        projectId: target.projectId,
        kind: "webhook",
        name: `Outbound ${Date.now()}`,
        config: { url: "https://hooks.example.test/facility", events: ["run.finished"] },
        secret,
      },
    });
    expect(integration.statusCode).toBe(200);
    const run = await app.inject({
      method: "POST",
      url: `/v1/projects/${target.projectId}/runs`,
      headers: { cookie },
      payload: {
        mode: "manual",
        agentDefId: target.agent.id,
        trigger: { type: "manual", message: "Exercise terminal webhook delivery" },
      },
    });
    expect(run.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/runs/${run.json().id}/cancel`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);

    const pending = await app.inject({
      method: "GET",
      url: `/v1/integrations/${integration.json().id}/deliveries`,
      headers: { cookie },
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toHaveLength(1);
    expect(pending.json()[0]).toMatchObject({ eventType: "run.finished", status: "pending" });

    const requests: Array<{ url: string; headers: Headers; body: string }> = [];
    const now = new Date(new Date(pending.json()[0].createdAt).getTime() + 1_000);
    const delivered = await deliverPendingWebhooks(config, {
      now,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: String(init?.body),
        });
        return new Response(null, { status: 204 });
      },
    });
    expect(delivered).toContainEqual({ id: pending.json()[0].id, status: "delivered" });
    const request = requests.find(
      (item) => item.headers.get("x-facility-delivery") === pending.json()[0].id,
    );
    expect(request?.url).toBe("https://hooks.example.test/facility");
    expect(request?.headers.get("x-facility-event")).toBe("run.finished");
    const timestamp = String(Math.floor(now.getTime() / 1_000));
    const expectedSignature = `sha256=${createHmac("sha256", secret)
      .update(`${timestamp}.${pending.json()[0].id}.run.finished.${request?.body}`)
      .digest("hex")}`;
    expect(request?.headers.get("x-facility-signature")).toBe(expectedSignature);

    const history = await app.inject({
      method: "GET",
      url: `/v1/integrations/${integration.json().id}/deliveries`,
      headers: { cookie },
    });
    expect(history.json()[0]).toMatchObject({ status: "delivered", responseStatus: 204 });
  });

  it("refuses steering a finished run", async () => {
    const target = await createProjectWithAgent("Steering Run");
    const run = await app.inject({
      method: "POST",
      url: `/v1/projects/${target.projectId}/runs`,
      headers: { cookie },
      payload: {
        mode: "builder",
        engine: "codex",
        agentDefId: target.agent.id,
        trigger: { type: "manual", message: "Exercise terminal steering rejection" },
      },
    });
    const canceled = await app.inject({
      method: "POST",
      url: `/v1/runs/${run.json().id}/cancel`,
      headers: { cookie },
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().status).toBe("canceled");
    const repeated = await app.inject({
      method: "POST",
      url: `/v1/runs/${run.json().id}/cancel`,
      headers: { cookie },
    });
    expect(repeated.statusCode).toBe(200);
    const cancellationEvents = (
      await db.select().from(runEvents).where(eq(runEvents.runId, run.json().id))
    ).filter((event) => event.type === "result");
    expect(cancellationEvents).toHaveLength(1);
    expect(cancellationEvents[0]?.data).toEqual({ status: "canceled" });
    const steer = await app.inject({
      method: "POST",
      url: `/v1/runs/${run.json().id}/steer`,
      headers: { cookie },
      payload: { body: "hello?" },
    });
    expect(steer.statusCode).toBe(409);
  });

  it("interrupts live runs through steer_messages and rejects terminal or unauthorized calls", async () => {
    const target = await createProjectWithAgent("Interrupt Run");
    const run = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId: target.projectId,
          agentDefId: target.agent.id,
          mode: "builder",
          engine: "claude_code",
          status: "running",
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    const interrupted = await app.inject({
      method: "POST",
      url: `/v1/runs/${run?.id}/interrupt`,
      headers: { cookie },
    });
    expect(interrupted.statusCode).toBe(200);
    if (!run) throw new Error("interrupt run fixture missing");
    const messages = await db.select().from(steerMessages).where(eq(steerMessages.runId, run.id));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe("interrupt");
    const steerEvent = (
      await db
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, run?.id ?? ""))
        .orderBy(runEvents.seq)
    ).find((event) => event.type === "steer");
    expect(steerEvent?.data).toMatchObject({ kind: "interrupt" });

    const finished = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId: target.projectId,
          agentDefId: target.agent.id,
          mode: "builder",
          engine: "claude_code",
          status: "succeeded",
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    const terminal = await app.inject({
      method: "POST",
      url: `/v1/runs/${finished?.id}/interrupt`,
      headers: { cookie },
    });
    expect(terminal.statusCode).toBe(409);

    const role = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { cookie },
      payload: { name: `read-only-${Date.now()}`, permissions: ["runs:read"] },
    });
    const issued = await app.inject({
      method: "POST",
      url: "/v1/keys",
      headers: { cookie },
      payload: { name: "interrupt-read-only", roleId: role.json().id, projectId: target.projectId },
    });
    const forbidden = await app.inject({
      method: "POST",
      url: `/v1/runs/${run?.id}/interrupt`,
      headers: { authorization: `Bearer ${issued.json().secret}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("resumes terminal claude_code runs with a session id and preserves parent scope", async () => {
    const target = await createProjectWithAgent("Resume Run");
    const dispatched: { queue: string; data: Record<string, unknown> }[] = [];
    const originalEnqueue = app.enqueue;
    app.enqueue = async (queue: string, data: Record<string, unknown>) => {
      dispatched.push({ queue, data });
      return `job_${dispatched.length}`;
    };
    try {
      const parent = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId: target.projectId,
            agentDefId: target.agent.id,
            mode: "builder",
            engine: "claude_code",
            status: "succeeded",
            engineSessionId: "sess_resume_1",
            gh: { owner: "octo", repo: "repo", branch: "facility/old" },
            createdBy: { type: "user", id: "test" },
          })
          .returning()
      )[0];
      const resumed = await app.inject({
        method: "POST",
        url: `/v1/runs/${parent?.id}/resume`,
        headers: { cookie },
        payload: { message: "continue this" },
      });
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json().trigger).toEqual({
        type: "resume",
        resumeOf: parent?.id,
        message: "continue this",
      });
      expect(resumed.json().gh).toEqual({ owner: "octo", repo: "repo", branch: "facility/old" });
      expect(dispatched).toEqual([
        { queue: "runs.dispatch", data: { runId: resumed.json().id, orgId } },
      ]);

      const runningParent = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId: target.projectId,
            agentDefId: target.agent.id,
            mode: "builder",
            engine: "claude_code",
            status: "running",
            engineSessionId: "sess_resume_2",
            createdBy: { type: "user", id: "test" },
          })
          .returning()
      )[0];
      const running = await app.inject({
        method: "POST",
        url: `/v1/runs/${runningParent?.id}/resume`,
        headers: { cookie },
      });
      expect(running.statusCode).toBe(409);

      const codexParent = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId: target.projectId,
            agentDefId: target.agent.id,
            mode: "builder",
            engine: "codex",
            status: "succeeded",
            engineSessionId: "sess_codex",
            createdBy: { type: "user", id: "test" },
          })
          .returning()
      )[0];
      const codex = await app.inject({
        method: "POST",
        url: `/v1/runs/${codexParent?.id}/resume`,
        headers: { cookie },
      });
      expect(codex.statusCode).toBe(409);
      expect(codex.json().error.code).toBe("not_resumable");

      // A resume is a new Builder row, not a second consumption of the
      // parent's plan acceptance. Required projects therefore deny it before
      // insertion instead of copying provenance into a non-canonical trigger.
      await db
        .update(projects)
        .set({ builderPlanPolicy: "required" })
        .where(and(eq(projects.orgId, orgId), eq(projects.id, target.projectId)));
      const beforeRequiredResume = await db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.projectId, target.projectId));
      const dispatchedBeforeRequiredResume = dispatched.length;
      const governedResume = await app.inject({
        method: "POST",
        url: `/v1/runs/${parent?.id}/resume`,
        headers: { cookie },
        payload: { message: "attempt a governed resume" },
      });
      expect(governedResume.statusCode, governedResume.body).toBe(409);
      expect(governedResume.json().error.code).toBe("builder_plan_required");
      expect(
        await db.select({ id: runs.id }).from(runs).where(eq(runs.projectId, target.projectId)),
      ).toHaveLength(beforeRequiredResume.length);
      expect(dispatched).toHaveLength(dispatchedBeforeRequiredResume);

      const other = (
        await db
          .insert(projects)
          .values({
            id: newId("proj"),
            orgId,
            name: "Resume Other",
            slug: `resume-other-${Date.now()}`,
            settings: {},
          })
          .returning()
      )[0];
      const issued = await app.inject({
        method: "POST",
        url: "/v1/keys",
        headers: { cookie },
        payload: { name: "resume-other-key", roleId: ownerRole, projectId: other?.id },
      });
      const scoped = await app.inject({
        method: "POST",
        url: `/v1/runs/${parent?.id}/resume`,
        headers: { authorization: `Bearer ${issued.json().secret}` },
      });
      expect(scoped.statusCode).toBe(404);
    } finally {
      app.enqueue = originalEnqueue;
    }
  });

  it("creates project-owner conversations, dispatches turns, and enforces project scope", async () => {
    const target = await createProjectWithAgent("Conversation Run");
    const ownerAgent = (
      await db
        .select()
        .from(agentDefs)
        .where(
          sql`${agentDefs.projectId} = ${target.projectId} and ${agentDefs.name} = 'project-owner'`,
        )
        .limit(1)
    )[0];
    expect(ownerAgent).toBeTruthy();
    const dispatched: { queue: string; data: Record<string, unknown> }[] = [];
    const originalEnqueue = app.enqueue;
    app.enqueue = async (queue: string, data: Record<string, unknown>) => {
      dispatched.push({ queue, data });
      return `job_${dispatched.length}`;
    };
    try {
      const created = await app.inject({
        method: "POST",
        url: `/v1/projects/${target.projectId}/conversations`,
        headers: { cookie },
        payload: { title: "Owner chat" },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().agentDefId).toBe(ownerAgent?.id);
      expect(created.json().status).toBe("idle");

      const turn = await app.inject({
        method: "POST",
        url: `/v1/conversations/${created.json().id}/messages`,
        headers: { cookie },
        payload: { body: "What should we do next?" },
      });
      expect(turn.statusCode).toBe(200);
      const storedConversation = (
        await db
          .select()
          .from(conversations)
          .where(eq(conversations.id, created.json().id))
          .limit(1)
      )[0];
      expect(storedConversation?.status).toBe("running");
      const userMessages = await db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, created.json().id));
      expect(userMessages.map((message) => message.seq)).toEqual([1]);
      expect(userMessages[0]?.role).toBe("user");
      const run = (await db.select().from(runs).where(eq(runs.id, turn.json().runId)).limit(1))[0];
      expect(run?.mode).toBe("conversation");
      expect(run?.trigger).toEqual({
        type: "conversation",
        conversationId: created.json().id,
        message: "What should we do next?",
      });
      expect(dispatched).toEqual([
        { queue: "runs.dispatch", data: { runId: turn.json().runId, orgId } },
      ]);

      const second = await app.inject({
        method: "POST",
        url: `/v1/conversations/${created.json().id}/messages`,
        headers: { cookie },
        payload: { body: "Second turn" },
      });
      expect(second.statusCode).toBe(409);

      const detail = await app.inject({
        method: "GET",
        url: `/v1/conversations/${created.json().id}`,
        headers: { cookie },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().messages).toHaveLength(1);

      const codexAgent = (
        await db
          .insert(agentDefs)
          .values({
            id: newId("agent"),
            orgId,
            projectId: target.projectId,
            name: `codex-owner-${Date.now()}`,
            engine: "codex",
            model: {},
            contractItemId: target.agent.contractItemId,
            harnessItemId: target.agent.harnessItemId,
            triggers: [],
            sandboxProfileId: target.agent.sandboxProfileId,
            permissions: [],
            enabled: true,
          })
          .returning()
      )[0];
      const unsupported = await app.inject({
        method: "POST",
        url: `/v1/projects/${target.projectId}/conversations`,
        headers: { cookie },
        payload: { agentDefId: codexAgent?.id },
      });
      expect(unsupported.statusCode).toBe(409);
      expect(unsupported.json().error.code).toBe("engine_unsupported");
    } finally {
      app.enqueue = originalEnqueue;
    }
  });
});

function checkStatus(payload: { checks: Array<{ id: string; status: string }> }, id: string) {
  return payload.checks.find((check) => check.id === id)?.status;
}
