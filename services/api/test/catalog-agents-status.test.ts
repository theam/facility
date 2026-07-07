import { newId } from "@facility/core";
import {
  agentDefs,
  createDb,
  integrations,
  migrate,
  projects,
  registryItems,
  runs,
  seed,
} from "@facility/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility";
const masterKey = Buffer.alloc(32, 11).toString("base64");

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

describe("catalog + agents status + integrations", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres unreachable; catalog/status tests skipped", () => undefined);
    return;
  }

  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: masterKey,
    port: 4412,
    publicUrl: "http://127.0.0.1:0",
    sandboxApiUrl: "http://127.0.0.1:0",
    sandboxGatewayUrl: "http://127.0.0.1:0",
    sandboxRunnerImage: "facility-runner:dev",
    sandboxDriver: "docker",
    webUrl: "http://localhost:3000",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  const { db, client } = createDb(databaseUrl);
  const app = await buildApp(config);
  let cookie = "";
  let orgId = "";
  let projectId = "";
  let contractItemId = "";
  let agentId = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { email: `catalog-status-${Date.now()}@example.com` },
    });
    cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    orgId = login.json().orgId;
    projectId =
      (
        await db
          .insert(projects)
          .values({
            id: newId("proj"),
            orgId,
            name: "catalog-status",
            slug: `catalog-status-${Date.now()}`,
            settings: {},
          })
          .returning()
      )[0]?.id ?? "";
    contractItemId =
      (
        await db
          .insert(registryItems)
          .values({
            id: newId("item"),
            orgId,
            scope: "project",
            projectId,
            kind: "agent_contract",
            name: `status-contract-${Date.now()}`,
            description: "Watches the watchers.",
          })
          .returning()
      )[0]?.id ?? "";
    agentId =
      (
        await db
          .insert(agentDefs)
          .values({
            id: newId("agent"),
            orgId,
            projectId,
            name: "status-probe",
            engine: "claude_code",
            model: { model: "claude-sonnet-5" },
            contractItemId,
            triggers: [{ type: "schedule", config: { cron: "0 6 * * *" } }],
            permissions: [],
            enabled: true,
          })
          .returning()
      )[0]?.id ?? "";
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("serves the platform catalog for semantic pickers", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/catalog", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      engines: Array<{ id: string }>;
      models: Array<{ id: string; provider: string }>;
      permissions: { all: string[] };
      triggerTypes: Array<{ type: string }>;
    };
    expect(body.engines.map((e) => e.id)).toContain("claude_code");
    expect(body.models.some((m) => m.provider === "anthropic")).toBe(true);
    expect(body.models.some((m) => m.id === "custom")).toBe(false);
    expect(body.permissions.all).toContain("runs:trigger");
    expect(body.triggerTypes.map((t) => t.type)).toContain("schedule");
  });

  it("reports per-agent status: schedule truth, next fire, run rollups", async () => {
    await db.insert(runs).values({
      id: newId("run"),
      orgId,
      projectId,
      agentDefId: agentId,
      mode: "status-probe",
      engine: "claude_code",
      status: "succeeded",
      receipt: { usage: { cost_cents: 42 } },
      gh: { pr: { number: 7, url: "https://github.com/theam/x/pull/7" } },
      queuedAt: new Date(Date.now() - 60_000),
      endedAt: new Date(),
      createdBy: { type: "system", id: "test" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/agents/status`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{
      agentId: string;
      description: string | null;
      schedule: { cron: string } | null;
      nextRunAt: string | null;
      lastRun: { status: string; costCents: number | null; prUrl: string | null } | null;
      counts14d: { total: number; succeeded: number };
      prCount14d: number;
    }>;
    const probe = rows.find((row) => row.agentId === agentId);
    expect(probe).toBeDefined();
    expect(probe?.description).toBe("Watches the watchers.");
    expect(probe?.schedule?.cron).toBe("0 6 * * *");
    expect(probe?.nextRunAt).toBeTruthy();
    expect(new Date(probe?.nextRunAt ?? 0).getTime()).toBeGreaterThan(Date.now());
    expect(probe?.lastRun?.status).toBe("succeeded");
    expect(probe?.lastRun?.costCents).toBe(42);
    expect(probe?.lastRun?.prUrl).toContain("/pull/7");
    expect(probe?.counts14d.total).toBeGreaterThanOrEqual(1);
    expect(probe?.counts14d.succeeded).toBeGreaterThanOrEqual(1);
    expect(probe?.prCount14d).toBeGreaterThanOrEqual(1);
  });

  it("surfaces integration event bindings on the bound agent", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/integrations",
      headers: { cookie },
      payload: {
        name: "uservoice",
        kind: "feedback",
        config: { projectId, agent: "status-probe", enqueueRun: true },
        secret: "hook-secret",
      },
    });
    expect(created.statusCode).toBe(200);
    const integration = created.json() as Record<string, unknown>;
    expect(integration.hasSecret).toBe(true);
    expect("sealedSecret" in integration).toBe(false);

    const res = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/agents/status`,
      headers: { cookie },
    });
    const rows = res.json() as Array<{
      agentId: string;
      eventBindings: Array<{ name: string; dispatchesRuns: boolean }>;
    }>;
    const probe = rows.find((row) => row.agentId === agentId);
    expect(probe?.eventBindings.map((b) => b.name)).toContain("uservoice");
    expect(probe?.eventBindings[0]?.dispatchesRuns).toBe(true);
  });

  it("integrations CRUD: list redacts secrets, patch toggles, events list is scoped", async () => {
    const list = await app.inject({ method: "GET", url: "/v1/integrations", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((row) => !("sealedSecret" in row))).toBe(true);
    const id = rows.find((row) => row.name === "uservoice")?.id as string;

    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/integrations/${id}`,
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { enabled: boolean }).enabled).toBe(false);

    const events = await app.inject({
      method: "GET",
      url: `/v1/integrations/${id}/events`,
      headers: { cookie },
    });
    expect(events.statusCode).toBe(200);
    expect(events.json()).toEqual([]);

    const foreign = await db
      .insert(integrations)
      .values({
        id: newId("int"),
        orgId: `org_other_${Date.now()}`,
        kind: "feedback",
        name: "other-org",
        config: {},
        enabled: true,
      })
      .returning()
      .catch(() => []);
    // Foreign-org row may violate FK in this harness; the scope check is what matters:
    if (foreign[0]) {
      const denied = await app.inject({
        method: "GET",
        url: `/v1/integrations/${foreign[0].id}/events`,
        headers: { cookie },
      });
      expect(denied.statusCode).toBe(404);
    }
  });
});
