import { newId } from "@facility/core";
import {
  agentDefs,
  createDb,
  migrate,
  projects,
  registryItems,
  registryVersions,
  runEvents,
  runs,
  sandboxProfiles,
  seed,
  virtualKeys,
} from "@facility/db";
import { and, eq, isNotNull } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { sandboxNamespace } from "../src/sandbox/cache.js";
import { DockerSandboxDriver } from "../src/sandbox/docker.js";
import { dispatchRun } from "../src/sandbox/orchestrator.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_sbx";
const masterKey = Buffer.alloc(32, 7).toString("base64");
const dockerNamespace = sandboxNamespace({ databaseUrl, secretMasterKey: masterKey });

describe("sandbox docker e2e", () => {
  if (process.env.FACILITY_E2E_DOCKER !== "1") {
    it.skip("set FACILITY_E2E_DOCKER=1 to run the Docker-backed sandbox e2e", () => undefined);
    return;
  }

  const port = Number(process.env.FACILITY_E2E_PORT ?? 4499);
  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: masterKey,
    port,
    publicUrl: `http://host.docker.internal:${port}`,
    sandboxApiUrl: `http://host.docker.internal:${port}`,
    sandboxGatewayUrl: `http://host.docker.internal:${port}`,
    gatewayUrl: "http://localhost:4410",
    sandboxRunnerImage: "facility-runner:dev",
    sandboxDriver: "docker",
    webUrl: "http://localhost:3000",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  const { db, client } = createDb(databaseUrl);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie = "";
  let orgId = "";
  let projectId = "";

  beforeAll(async () => {
    await assertPostgres();
    await assertRunnerImage();
    await migrate(databaseUrl);
    await seed(databaseUrl);
    app = await buildApp(config);
    await app.listen({ port, host: "0.0.0.0" });
    const login = await app.inject({
      method: "POST",
      url: "/__test/session",
      payload: { email: `sandbox-e2e-${Date.now()}@example.com` },
    });
    cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    orgId = login.json().orgId;
    const project = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Sandbox E2E",
          slug: `sandbox-e2e-${Date.now()}`,
          settings: {},
        })
        .returning()
    )[0];
    projectId = project?.id ?? "";
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client.end();
  });

  it("runs the full BYO runner loop", async () => {
    const contractItem = requiredRow(
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId,
          kind: "agent_contract",
          name: `byo-contract-${Date.now()}`,
          latestVersion: 1,
        })
        .returning(),
      "contract item",
    );
    await db.insert(registryVersions).values({
      id: newId("ver"),
      orgId,
      itemId: contractItem.id,
      version: 1,
      content: "Emit progress, respect steering, and write checks.",
      contentHash: "e2e",
      status: "active",
    });
    const profile = requiredRow(
      await db
        .insert(sandboxProfiles)
        .values({
          id: newId("sbx"),
          orgId,
          projectId,
          name: "Runner E2E",
          driver: "docker",
          image: "facility-runner:dev",
          // Reproduce the normal package-manager bootstrap under the runner's
          // non-root user. Corepack must install shims without writing /usr/local.
          setup: { provision_cmd: "corepack enable && pnpm --version" },
          resources: { cpu: 1, memory_mb: 512, timeout_min: 5 },
          network: { egress: "unrestricted" },
        })
        .returning(),
      "sandbox profile",
    );
    const agent = requiredRow(
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId,
          name: "BYO E2E",
          engine: "byo",
          model: {
            cmd: 'mkdir -p .agent-sdlc; echo agent-started; for i in $(seq 1 30); do if [ -s /work/STEERING.md ]; then echo steer-seen; break; fi; sleep 1; done; printf \'{"name":"fixture","status":"passed"}\\n\' > .agent-sdlc/checks.jsonl',
          },
          contractItemId: contractItem.id,
          sandboxProfileId: profile.id,
        })
        .returning(),
      "agent",
    );
    const run = requiredRow(
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId,
          agentDefId: agent.id,
          // This test proves the sandbox/runner protocol without depending on an
          // external Git remote. Builder modes deliberately require a configured
          // repository and pushed commit, so use the custom BYO mode here; the
          // GitHub delivery path has its own integration coverage.
          mode: "custom",
          engine: "byo",
          trigger: {},
          createdBy: { type: "user", id: "e2e" },
        })
        .returning(),
      "run",
    );
    await dispatchRun(config, { runId: run.id, orgId });
    await waitFor(async () => (await runStatus(run.id)) === "running", 30_000);
    const steer = await app.inject({
      method: "POST",
      url: `/v1/runs/${run.id}/steer`,
      headers: { cookie },
      payload: { body: "please finish the fixture" },
    });
    expect(steer.statusCode).toBe(200);
    await waitForRunSuccess(run.id, 60_000);

    const finished = requiredRow(
      await db.select().from(runs).where(eq(runs.id, run.id)).limit(1),
      "finished run",
    );
    const events = await db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, run.id))
      .orderBy(runEvents.seq);
    const types = events.map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining(["hello", "phase", "shell", "assistant", "steer", "check"]),
    );
    const phaseEvents = events
      .filter((event) => event.type === "phase")
      .map((event) => event.data as Record<string, unknown>);
    expect(phaseEvents.map((event) => event.name)).toEqual([
      "bootstrap",
      "workspace",
      "runner_runtime",
      "package_install",
      "provision",
      "agent",
      "result_capture",
      "acceptance",
      "delivery",
    ]);
    for (const event of phaseEvents) {
      expect(event.status).toMatch(/^(completed|skipped)$/);
      expect(event.duration_ms).toEqual(expect.any(Number));
      expect(event.duration_ms).toBeGreaterThanOrEqual(0);
      expect(event).not.toHaveProperty("command");
      expect(event).not.toHaveProperty("output");
    }
    // Revocation trails the terminal status (it runs in the orchestrator's
    // cleanup, not the status transition) — poll instead of racing it.
    await waitFor(async () => {
      const revoked = await db
        .select()
        .from(virtualKeys)
        .where(and(eq(virtualKeys.runId, run.id), isNotNull(virtualKeys.revokedAt)));
      return revoked.length === 1;
    }, 20_000);
    expect(
      (finished.receipt as { events?: { count?: number; checks?: number } })?.events?.checks,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (finished.receipt as { checks?: Array<{ name?: string; status?: string; source?: string }> })
        ?.checks,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "fixture", status: "passed", source: "agent" }),
      ]),
    );
    expect(await containersFor(run.id)).toEqual([]);
  }, 120_000);

  async function runStatus(runId: string) {
    return (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0]?.status;
  }

  async function waitForRunSuccess(runId: string, timeoutMs: number) {
    await waitFor(async () => {
      const row = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0];
      if (row?.status === "failed" || row?.status === "canceled") {
        const result = await db
          .select()
          .from(runEvents)
          .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "result")))
          .orderBy(runEvents.seq);
        throw new Error(
          `runner ended ${row.status}: ${JSON.stringify(result.at(-1)?.data ?? row.receipt)}`,
        );
      }
      return row?.status === "succeeded";
    }, timeoutMs);
  }
});

async function assertPostgres() {
  const sqlClient = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await sqlClient`select 1`;
  } finally {
    await sqlClient.end().catch(() => undefined);
  }
}

async function assertRunnerImage() {
  const driver = new DockerSandboxDriver();
  await driver.status("definitely-missing").catch((error) => {
    if (/connect|socket|permission/i.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("timed out waiting for condition");
}

async function containersFor(runId: string) {
  return (await new DockerSandboxDriver().listFacilityContainers(dockerNamespace)).filter(
    (container) => container.runId === runId,
  );
}

function requiredRow<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) throw new Error(`missing ${label}`);
  return row;
}
