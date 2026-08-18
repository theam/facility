import {
  generateApiKey,
  hashKey,
  newId,
  seal,
  verifyFacilityReceipt,
  verifyKey,
} from "@facility/core";
import {
  agentDefs,
  apiKeys,
  auditEvents,
  conversationMessages,
  conversations,
  createDb,
  githubInstallations,
  kbSpaces,
  migrate,
  projects,
  providerCredentials,
  registryItems,
  registryVersions,
  repos,
  roles,
  runEvents,
  runs,
  sandboxProfiles,
  seed,
  virtualKeys,
} from "@facility/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { verifyStoredReceipts } from "../src/receipt-integrity.js";
import { AwsSandboxDriver } from "../src/sandbox/aws.js";
import { sandboxCachePartition, sandboxNamespace } from "../src/sandbox/cache.js";
import { DockerSandboxDriver } from "../src/sandbox/docker.js";
import type { SandboxDriver } from "../src/sandbox/driver.js";
import {
  dispatchRun,
  finishRun,
  reconcileSandboxes,
  repairExpectedHeadSha,
  runDeliveryRefMismatch,
} from "../src/sandbox/orchestrator.js";
import { appendRunEvents, readSandbox } from "../src/sandbox/state.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const masterKey = Buffer.alloc(32, 8).toString("base64");

describe("run delivery integrity binding", () => {
  const expected = {
    headBranch: "facility/run-1",
    expectedHeadSha: "expected-sha",
    baseBranch: "main",
  };

  it("accepts only the exact head, base, and commit", () => {
    expect(
      runDeliveryRefMismatch(
        { headRef: "facility/run-1", headSha: "expected-sha", baseRef: "main" },
        expected,
      ),
    ).toBeNull();
    expect(
      runDeliveryRefMismatch(
        { headRef: "facility/run-1", headSha: "moved-sha", baseRef: "main" },
        expected,
      ),
    ).toBe("pull_request_head_sha_mismatch");
    expect(
      runDeliveryRefMismatch(
        { headRef: "foreign-branch", headSha: "expected-sha", baseRef: "main" },
        expected,
      ),
    ).toBe("pull_request_ref_mismatch");
    expect(
      runDeliveryRefMismatch(
        { headRef: "facility/run-1", headSha: "expected-sha", baseRef: "release" },
        expected,
      ),
    ).toBe("pull_request_ref_mismatch");
  });

  it("pins repair bundles to the admitted head and prefers doctor evidence", () => {
    const admitted = "a".repeat(40);
    const webhook = "b".repeat(40);
    expect(
      repairExpectedHeadSha("ci_doctor", {
        ciDoctor: { admittedHeadSha: admitted },
        pullRequest: { headSha: webhook },
      }),
    ).toBe(admitted);
    expect(repairExpectedHeadSha("address_review", { pullRequest: { headSha: webhook } })).toBe(
      webhook,
    );
    expect(repairExpectedHeadSha("builder", { pullRequest: { headSha: webhook } })).toBeNull();
  });
});

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

async function dockerReachable() {
  try {
    await new DockerSandboxDriver().status("definitely-missing");
    return true;
  } catch (error) {
    return error instanceof Error && !/connect|socket|permission/i.test(error.message);
  }
}

describe("sandbox api", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; sandbox tests skipped", () => undefined);
    return;
  }

  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: masterKey,
    port: 4401,
    publicUrl: "http://127.0.0.1:0",
    sandboxApiUrl: "http://127.0.0.1:0",
    sandboxGatewayUrl: "http://127.0.0.1:0",
    gatewayUrl: "http://localhost:4410",
    sandboxRunnerImage: "facility-runner:dev",
    sandboxDriver: "docker",
    webUrl: "http://localhost:3000",
    facilityInsecureDev: true,
    packageRegistryToken: "package-token",
    logLevel: "silent",
  };
  const { db, client } = createDb(databaseUrl);
  const app = await buildApp(config);
  let cookie = "";
  let orgId = "";
  let projectId = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/__test/session",
      payload: { email: `sandbox-${Date.now()}@example.com` },
    });
    cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    orgId = login.json().orgId;
    await db.delete(auditEvents).where(eq(auditEvents.orgId, orgId));
    const project = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Sandbox Test Project",
          slug: `sandbox-${Date.now()}`,
          settings: {},
        })
        .returning()
    )[0];
    projectId = project?.id ?? "";
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("imageExists reports daemon image presence without pulling", async () => {
    const withInspect = (inspect: () => Promise<unknown>) =>
      new DockerSandboxDriver({ getImage: () => ({ inspect }) } as unknown as ConstructorParameters<
        typeof DockerSandboxDriver
      >[0]);
    // Present: inspect resolves.
    expect(await withInspect(async () => ({ Id: "sha256:abc" })).imageExists("runner:dev")).toBe(
      true,
    );
    // Absent: inspect rejects with Docker's 404.
    expect(
      await withInspect(async () => {
        throw { statusCode: 404 };
      }).imageExists("runner:missing"),
    ).toBe(false);
    // A real daemon error (not 404) must propagate, not read as "absent".
    await expect(
      withInspect(async () => {
        throw { statusCode: 500, message: "daemon boom" };
      }).imageExists("runner:dev"),
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  it("grants the legacy KB floor only to an explicitly harness-backed run", async () => {
    const suffix = Date.now();
    const [contract, harness, profile] = await Promise.all([
      db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId,
          kind: "agent_contract",
          name: `permission-contract-${suffix}`,
          latestVersion: 1,
        })
        .returning()
        .then((rows) => rows[0]),
      db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId,
          kind: "harness",
          name: `permission-harness-${suffix}`,
          latestVersion: 1,
        })
        .returning()
        .then((rows) => rows[0]),
      db
        .insert(sandboxProfiles)
        .values({
          id: newId("sbx"),
          orgId,
          projectId,
          name: `permission-profile-${suffix}`,
          driver: "docker",
          image: "facility-runner:test",
          resources: { timeout_min: 5 },
        })
        .returning()
        .then((rows) => rows[0]),
    ]);
    if (!contract || !harness || !profile) throw new Error("permission fixtures missing");
    await Promise.all([
      db.insert(registryVersions).values({
        id: newId("ver"),
        orgId,
        itemId: contract.id,
        version: 1,
        content: "Exercise the permission boundary.",
        contentHash: `permission-contract-${suffix}`,
        status: "active",
      }),
      db.insert(registryVersions).values({
        id: newId("ver"),
        orgId,
        itemId: harness.id,
        version: 1,
        content: "Harness fixture.",
        contentHash: `permission-harness-${suffix}`,
        status: "active",
      }),
      db.insert(kbSpaces).values({
        id: newId("kb"),
        orgId,
        projectId,
        charterMd: "# Charter\n",
        activeMd: "## Objective\n\n## Next Step\n\n## Blocker\n\n## Links\n",
        config: {},
      }),
    ]);
    const driver: SandboxDriver = {
      name: "docker",
      launch: async (spec) => ({ ref: `fake-${spec.runId}` }),
      status: async () => "running",
      async *logs() {},
      stop: async () => undefined,
      destroy: async () => undefined,
    };

    const permissionSets: string[][] = [];
    const runKeyExpirations: Array<{ virtual: Date | null; platform: Date | null }> = [];
    for (const harnessEnabled of [false, true]) {
      const agent = (
        await db
          .insert(agentDefs)
          .values({
            id: newId("agent"),
            orgId,
            projectId,
            name: `permission-agent-${harnessEnabled}-${suffix}`,
            engine: "byo",
            model: { cmd: "true" },
            contractItemId: contract.id,
            harnessItemId: harnessEnabled ? harness.id : null,
            sandboxProfileId: profile.id,
            triggers: [],
            permissions: [],
            enabled: true,
          })
          .returning()
      )[0];
      if (!agent) throw new Error("permission agent fixture missing");
      const run = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId,
            agentDefId: agent.id,
            mode: harnessEnabled ? "project-owner" : "builder",
            engine: "byo",
            trigger: {},
            createdBy: { type: "user", id: "permission-test" },
          })
          .returning()
      )[0];
      if (!run) throw new Error("permission run fixture missing");
      await dispatchRun(config, { runId: run.id, orgId }, { sandboxDriver: async () => driver });
      const key = (
        await db.select({ roleId: apiKeys.roleId }).from(apiKeys).where(eq(apiKeys.runId, run.id))
      )[0];
      const role = key?.roleId
        ? (
            await db
              .select({ permissions: roles.permissions })
              .from(roles)
              .where(eq(roles.id, key.roleId))
          )[0]
        : undefined;
      permissionSets.push(role?.permissions ?? []);
      const [virtualKey] = await db
        .select({ expiresAt: virtualKeys.expiresAt })
        .from(virtualKeys)
        .where(eq(virtualKeys.runId, run.id));
      const [platformKey] = await db
        .select({ expiresAt: apiKeys.expiresAt })
        .from(apiKeys)
        .where(eq(apiKeys.runId, run.id));
      runKeyExpirations.push({
        virtual: virtualKey?.expiresAt ?? null,
        platform: platformKey?.expiresAt ?? null,
      });
    }

    expect(permissionSets).toEqual([[], ["kb:read", "kb:write", "tasks:read", "tasks:write"]]);
    expect(runKeyExpirations).toEqual([
      { virtual: null, platform: null },
      { virtual: null, platform: null },
    ]);
  });

  it("dispatch persists engine-specific model policy on each run key", async () => {
    const suffix = Date.now();
    const contract = (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId,
          kind: "agent_contract",
          name: `model-policy-${suffix}`,
          latestVersion: 1,
        })
        .returning()
    )[0];
    if (!contract) throw new Error("model policy contract fixture missing");
    await db.insert(registryVersions).values({
      id: newId("ver"),
      orgId,
      itemId: contract.id,
      version: 1,
      content: "Exercise the configured model.",
      contentHash: `model-policy-${suffix}`,
      status: "active",
    });
    const profile = (
      await db
        .insert(sandboxProfiles)
        .values({
          id: newId("sbx"),
          orgId,
          projectId,
          name: `model-policy-${suffix}`,
          driver: "docker",
          image: "facility-runner:test",
          resources: { timeout_min: 5 },
        })
        .returning()
    )[0];
    if (!profile) throw new Error("model policy sandbox fixture missing");

    const driver: SandboxDriver = {
      name: "docker",
      launch: async (spec) => ({ ref: `fake-${spec.runId}` }),
      status: async () => "running",
      async *logs() {},
      stop: async () => undefined,
      destroy: async () => undefined,
    };
    const cases = [
      {
        name: "claude",
        engine: "claude_code",
        model: { model: "opusplan" },
        expected: ["claude-opus-4-8", "claude-sonnet-5"],
      },
      {
        name: "codex",
        engine: "codex",
        model: { primary: "gpt-5.6-sol" },
        expected: ["gpt-5.6-sol"],
      },
      {
        name: "byo",
        engine: "byo",
        model: { model: "metadata-only", cmd: "true" },
        expected: null,
      },
    ] as const;

    for (const fixture of cases) {
      const oauthCredentialId = fixture.engine === "claude_code" ? newId("prov") : null;
      if (oauthCredentialId) {
        await db.insert(providerCredentials).values({
          id: oauthCredentialId,
          orgId,
          provider: "anthropic",
          name: `claude-subscription-${suffix}`,
          authMode: "oauth",
          sealedSecret: await seal("sk-ant-oat01-sandbox-test", masterKey),
          createdBy: "test",
        });
      }
      const agent = (
        await db
          .insert(agentDefs)
          .values({
            id: newId("agent"),
            orgId,
            projectId,
            name: `model-policy-${fixture.name}-${suffix}`,
            engine: fixture.engine,
            model: fixture.model,
            contractItemId: contract.id,
            sandboxProfileId: profile.id,
            triggers: [],
            permissions: [],
            enabled: true,
          })
          .returning()
      )[0];
      if (!agent) throw new Error(`${fixture.name} agent fixture missing`);
      const run = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId,
            agentDefId: agent.id,
            mode: "custom",
            engine: fixture.engine,
            trigger: {},
            createdBy: { type: "user", id: "model-policy-test" },
          })
          .returning()
      )[0];
      if (!run) throw new Error(`${fixture.name} run fixture missing`);

      await dispatchRun(config, { runId: run.id, orgId }, { sandboxDriver: async () => driver });

      const [key] = await db
        .select({ allowedModels: virtualKeys.allowedModels })
        .from(virtualKeys)
        .where(eq(virtualKeys.runId, run.id));
      expect(key?.allowedModels).toEqual(fixture.expected);
      const [persistedRun] = await db.select().from(runs).where(eq(runs.id, run.id));
      expect(readSandbox(persistedRun?.sandbox).bundle?.anthropicAuthMode).toBe(
        fixture.engine === "claude_code" ? "oauth" : undefined,
      );
      if (oauthCredentialId) {
        await db.delete(providerCredentials).where(eq(providerCredentials.id, oauthCredentialId));
      }
    }
  });

  it("derives the trusted CodeBuild nested-Docker flag only from the selected profile", async () => {
    const suffix = Date.now();
    const contract = (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId,
          kind: "agent_contract",
          name: `nested-docker-${suffix}`,
          latestVersion: 1,
        })
        .returning()
    )[0];
    if (!contract) throw new Error("nested-Docker contract fixture missing");
    await db.insert(registryVersions).values({
      id: newId("ver"),
      orgId,
      itemId: contract.id,
      version: 1,
      content: "Exercise the selected sandbox capability.",
      contentHash: `nested-docker-${suffix}`,
      status: "active",
    });
    const profile = (
      await db
        .insert(sandboxProfiles)
        .values({
          id: newId("sbx"),
          orgId,
          projectId,
          name: `nested-docker-${suffix}`,
          driver: "aws",
          image: "facility-runner:test",
          setup: { nested_docker: false },
          resources: { timeout_min: 5 },
        })
        .returning()
    )[0];
    if (!profile) throw new Error("nested-Docker profile fixture missing");
    const agent = (
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId,
          name: `nested-docker-${suffix}`,
          engine: "byo",
          model: { cmd: "true" },
          contractItemId: contract.id,
          sandboxProfileId: profile.id,
          triggers: [],
          permissions: [],
          enabled: true,
        })
        .returning()
    )[0];
    if (!agent) throw new Error("nested-Docker agent fixture missing");
    await db.insert(repos).values({
      id: newId("repo"),
      orgId,
      projectId,
      owner: `sandbox-capabilities-${suffix}`,
      name: "repo",
      defaultBranch: "main",
      renderAnswers: {
        packageInstallCmd: "pnpm install --frozen-lockfile",
        provisionCmd: "pnpm run local:setup:ui",
      },
    });

    const launched: Array<Parameters<SandboxDriver["launch"]>[0]> = [];
    const preLaunchClaims = new Map<string, string>();
    const driver: SandboxDriver = {
      name: "aws",
      launch: async (spec) => {
        // Regression: launch() is allowed to start the command immediately. Its
        // runner token and bundle must therefore already be durable before the
        // provider call, and provider-ref attachment must preserve a concurrent
        // one-shot /hello claim.
        const [beforeLaunch] = await db
          .select({ sandbox: runs.sandbox })
          .from(runs)
          .where(eq(runs.id, spec.runId));
        const prepared = readSandbox(beforeLaunch?.sandbox);
        expect(prepared.ref).toBeUndefined();
        expect(prepared.bundle).toBeDefined();
        expect(await verifyKey(spec.env.RUNNER_TOKEN ?? "", prepared.runnerTokenHash ?? "")).toBe(
          true,
        );
        const claimedAt = new Date().toISOString();
        preLaunchClaims.set(spec.runId, claimedAt);
        await db
          .update(runs)
          .set({ sandbox: { ...prepared, virtualKeyRevealedAt: claimedAt } })
          .where(eq(runs.id, spec.runId));
        launched.push(spec);
        return { ref: `fake-${spec.runId}` };
      },
      status: async () => "running",
      async *logs() {},
      stop: async () => undefined,
      destroy: async () => undefined,
    };
    for (const fixture of [
      {
        setup: { nested_docker: false, provisioning: "deps_only" },
        expected: "0",
        provisioning: "deps_only",
        packageInstallCmd: "pnpm install --frozen-lockfile",
        provisionCmd: null,
      },
      {
        setup: { nested_docker: true, provisioning: "none" },
        expected: "1",
        provisioning: "none",
        packageInstallCmd: null,
        provisionCmd: null,
      },
      // Profiles created before this capability keep their legacy full boundary.
      {
        setup: {},
        expected: "1",
        provisioning: "full",
        packageInstallCmd: "pnpm install --frozen-lockfile",
        provisionCmd: "pnpm run local:setup:ui",
      },
    ] as const) {
      await db
        .update(sandboxProfiles)
        .set({ setup: fixture.setup })
        .where(eq(sandboxProfiles.id, profile.id));
      const run = (
        await db
          .insert(runs)
          .values({
            id: newId("run"),
            orgId,
            projectId,
            agentDefId: agent.id,
            mode: "builder",
            engine: "byo",
            trigger: {},
            createdBy: { type: "user", id: "nested-docker-test" },
          })
          .returning()
      )[0];
      if (!run) throw new Error("nested-Docker run fixture missing");

      await dispatchRun(config, { runId: run.id, orgId }, { sandboxDriver: async () => driver });

      expect(launched.at(-1)?.env.FACILITY_SANDBOX_NESTED_DOCKER).toBe(fixture.expected);
      expect(launched.at(-1)?.cachePartition).toBe(
        sandboxCachePartition(config.secretMasterKey, orgId, projectId),
      );
      expect(launched.at(-1)?.env).not.toHaveProperty("FACILITY_CACHE_PARTITION");
      const persistedRun = (
        await db.select({ sandbox: runs.sandbox }).from(runs).where(eq(runs.id, run.id)).limit(1)
      )[0];
      expect(
        (persistedRun?.sandbox as { bundle?: Record<string, unknown> } | null)?.bundle,
      ).toMatchObject({
        packageInstallCmd: fixture.packageInstallCmd,
        provisionCmd: fixture.provisionCmd,
      });
      expect(readSandbox(persistedRun?.sandbox).virtualKeyRevealedAt).toBe(
        preLaunchClaims.get(run.id),
      );
      const sandboxEvent = (
        await db.select({ data: runEvents.data }).from(runEvents).where(eq(runEvents.runId, run.id))
      ).find((event) => (event.data as Record<string, unknown>).nested_docker !== undefined);
      expect(sandboxEvent?.data).toMatchObject({
        driver: "aws",
        nested_docker: fixture.expected === "1",
        provisioning: fixture.provisioning,
      });
    }

    await db
      .update(sandboxProfiles)
      .set({ driver: "docker", setup: { nested_docker: false } })
      .where(eq(sandboxProfiles.id, profile.id));
    const dockerRun = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId,
          agentDefId: agent.id,
          mode: "builder",
          engine: "byo",
          trigger: {},
          createdBy: { type: "user", id: "nested-docker-docker-driver-test" },
        })
        .returning()
    )[0];
    if (!dockerRun) throw new Error("docker-driver run fixture missing");
    const dockerDriver: SandboxDriver = { ...driver, name: "docker" };

    await dispatchRun(
      config,
      { runId: dockerRun.id, orgId },
      { sandboxDriver: async () => dockerDriver },
    );

    expect(launched.at(-1)?.env).not.toHaveProperty("FACILITY_SANDBOX_NESTED_DOCKER");
    expect(launched.at(-1)?.cachePartition).toBe(
      sandboxCachePartition(config.secretMasterKey, orgId, projectId),
    );
    expect(launched.at(-1)?.env).not.toHaveProperty("FACILITY_CACHE_PARTITION");
    const dockerSandboxEvent = (
      await db
        .select({ data: runEvents.data })
        .from(runEvents)
        .where(eq(runEvents.runId, dockerRun.id))
    ).find((event) => (event.data as Record<string, unknown>).driver === "docker");
    expect(dockerSandboxEvent?.data).not.toHaveProperty("nested_docker");
    expect(dockerSandboxEvent?.data).toMatchObject({ provisioning: "full" });
  });

  it("accepts only coherent sandbox capability settings", async () => {
    const valid = await app.inject({
      method: "POST",
      url: "/v1/sandbox-profiles",
      headers: { cookie },
      payload: {
        name: `no-nested-docker-${Date.now()}`,
        driver: "aws",
        image: "facility-runner:test",
        setup: { nested_docker: false, provisioning: "deps_only" },
      },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().setup).toMatchObject({
      nested_docker: false,
      provisioning: "deps_only",
    });

    for (const [setup, message] of [
      [{ nested_docker: "false" }, "setup.nested_docker must be a boolean"],
      [{ provisioning: "skip" }, "setup.provisioning must be full, deps_only, or none"],
      [
        { provisioning: "deps_only", provision_cmd: "pnpm setup" },
        "setup command overrides cannot target phases disabled by setup.provisioning",
      ],
      [
        { provisioning: "none", package_install_cmd: "pnpm install" },
        "setup command overrides cannot target phases disabled by setup.provisioning",
      ],
    ] as const) {
      const invalid = await app.inject({
        method: "POST",
        url: "/v1/sandbox-profiles",
        headers: { cookie },
        payload: {
          name: `invalid-capability-${Date.now()}`,
          driver: "aws",
          image: "facility-runner:test",
          setup,
        },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.body).toContain(message);
    }

    const invalidPatch = await app.inject({
      method: "PATCH",
      url: `/v1/sandbox-profiles/${valid.json().id}`,
      headers: { cookie },
      payload: { setup: { provisioning: false } },
    });
    expect(invalidPatch.statusCode).toBe(400);
    expect(invalidPatch.body).toContain("setup.provisioning must be full, deps_only, or none");

    const validPatch = await app.inject({
      method: "PATCH",
      url: `/v1/sandbox-profiles/${valid.json().id}`,
      headers: { cookie },
      payload: { setup: { nested_docker: false, provisioning: "none" } },
    });
    expect(validPatch.statusCode).toBe(200);
    expect(validPatch.json().setup).toEqual({ nested_docker: false, provisioning: "none" });
  });

  it("appendRunEvents allocates contiguous seqs under concurrent appends", async () => {
    const runId = newId("run");
    await insertRunnerRun("frt_seq", "running", runId, {});
    // Many producers append to the SAME run at once — without the per-run advisory
    // lock these race on the (run_id, seq) PK and some fail with a duplicate key.
    const count = 24;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        appendRunEvents(db, orgId, runId, [{ type: "assistant", data: { n: i } }]),
      ),
    );
    expect(results.every((r) => r.length === 1)).toBe(true);
    const rows = await db
      .select({ seq: runEvents.seq })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(runEvents.seq);
    const seqs = rows.map((r) => r.seq);
    // All appends landed, with unique + contiguous seqs starting at 1.
    expect(seqs).toEqual(Array.from({ length: count }, (_, i) => i + 1));
  });

  it("persists large run events without exceeding PostgreSQL NOTIFY limits", async () => {
    const runId = newId("run");
    await insertRunnerRun("frt_large_event", "running", runId, {});
    const text = "event-output-".repeat(2_000);

    await expect(
      appendRunEvents(db, orgId, runId, [{ type: "engine", data: { text } }]),
    ).resolves.toHaveLength(1);

    const stored = (
      await db.select({ data: runEvents.data }).from(runEvents).where(eq(runEvents.runId, runId))
    )[0];
    expect((stored?.data as { text?: string })?.text).toBe(text);
  });

  it("rejects rate-limited runner events before persisting them", async () => {
    const token = "frt_rate_limit";
    const run = await insertRunnerRun(token, "running");
    const limited = await buildApp(config, { rateLimitMax: 1 });
    await limited.ready();
    try {
      const request = {
        method: "POST" as const,
        url: `/internal/runs/${run.id}/events`,
        headers: { authorization: `Bearer ${token}` },
        payload: [{ type: "shell", data: { text: "installed" } }],
      };
      expect((await limited.inject(request)).statusCode).toBe(200);
      expect((await limited.inject(request)).statusCode).toBe(429);
      const persisted = await db
        .select({ seq: runEvents.seq })
        .from(runEvents)
        .where(eq(runEvents.runId, run.id));
      expect(persisted).toHaveLength(1);
    } finally {
      await limited.close();
    }
  });

  it("persists authenticated runner phase timings without a schema migration", async () => {
    const token = "frt_phase_timing";
    const run = await insertRunnerRun(token, "running");
    const payload = {
      name: "package_install",
      status: "completed",
      duration_ms: 1_234,
      outcome: "succeeded",
    };

    const response = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/events`,
      headers: { authorization: `Bearer ${token}` },
      payload: [{ type: "phase", data: payload }],
    });

    expect(response.statusCode).toBe(200);
    const [stored] = await db
      .select({ type: runEvents.type, data: runEvents.data, ts: runEvents.ts })
      .from(runEvents)
      .where(eq(runEvents.runId, run.id));
    expect(stored).toMatchObject({ type: "phase", data: payload });
    expect(stored?.ts).toBeInstanceOf(Date);
  });

  it("aws driver fails loudly as not_configured when env is missing", async () => {
    await expect(
      new AwsSandboxDriver().launch({
        runId: "run_test",
        image: "facility-runner:dev",
        env: {},
        cpu: 1,
        memoryMb: 512,
        timeoutMin: 1,
      }),
    ).rejects.toMatchObject({ code: "not_configured" });
  });

  it("rejects wrong runner tokens and terminal internal posts", async () => {
    const token = "frt_test";
    const run = await insertRunnerRun(token, "running");
    const wrong = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/events`,
      headers: { authorization: "Bearer wrong" },
      payload: [{ type: "assistant", data: { text: "no" } }],
    });
    expect(wrong.statusCode).toBe(401);
    await db
      .update(runs)
      .set({ status: "succeeded", endedAt: new Date() })
      .where(eq(runs.id, run.id));
    const terminal = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/events`,
      headers: { authorization: `Bearer ${token}` },
      payload: [{ type: "assistant", data: { text: "late" } }],
    });
    expect(terminal.statusCode).toBe(409);
  });

  it("finishRun persists the engine session id from the runner result", async () => {
    const run = await insertRunnerRun("frt_finish_session", "running");
    await finishRun(db, run, { status: "succeeded", engineSessionId: "sess_finish_123" });
    const stored = (await db.select().from(runs).where(eq(runs.id, run.id)).limit(1))[0];
    expect(stored?.engineSessionId).toBe("sess_finish_123");
  });

  it("persists the first engine session event before the runner reaches a result", async () => {
    const token = "frt_early_session";
    const run = await insertRunnerRun(token, "running");
    const first = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/events`,
      headers: { authorization: `Bearer ${token}` },
      payload: [{ type: "session", data: { engine_session_id: "sess_early_123" } }],
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/events`,
      headers: { authorization: `Bearer ${token}` },
      payload: [{ type: "session", data: { engine_session_id: "sess_must_not_replace" } }],
    });
    expect(second.statusCode).toBe(200);

    const [stored] = await db
      .select({ engineSessionId: runs.engineSessionId, status: runs.status })
      .from(runs)
      .where(eq(runs.id, run.id));
    expect(stored).toEqual({ engineSessionId: "sess_early_123", status: "running" });
  });

  it("finishRun synchronizes only trusted qualifying security findings", async () => {
    const suffix = Date.now();
    const installation = (
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId,
          installationId: Math.floor(Math.random() * 2_000_000_000) + 1,
          accountLogin: `security-${suffix}`,
          targetType: "Organization",
        })
        .returning()
    )[0];
    await db.insert(repos).values({
      id: newId("repo"),
      orgId,
      projectId,
      installationId: installation?.id,
      owner: `security-${suffix}`,
      name: "repo",
      defaultBranch: "main",
    });
    const inserted = await insertRunnerRun("frt_security", "running");
    const run = (
      await db
        .update(runs)
        .set({
          mode: "security_sweep",
          gh: { owner: `security-${suffix}`, repo: "repo" },
        })
        .where(eq(runs.id, inserted.id))
        .returning()
    )[0];
    if (!run) throw new Error("security run fixture missing");
    const observed: Record<string, unknown> = {};
    const githubClientFactory = (async () => ({
      rest: {
        issues: {
          listForRepo: async () => ({ data: [] }),
          createLabel: async () => ({ data: {} }),
          create: async (input: Record<string, unknown>) => {
            observed.issue = input;
            return { data: { number: 31, html_url: "https://github.test/issues/31" } };
          },
        },
      },
    })) as never;

    const finished = await finishRun(
      db,
      run,
      {
        status: "succeeded",
        securityReport: {
          schema: "facility.security.findings.v1",
          findings: [
            {
              fingerprint: "reachable-auth-bypass",
              title: "Authorization bypass",
              severity: "high",
              confidence: "high",
              actionable: true,
              risk: "A reachable route skips authorization.",
              locations: ["src/admin.ts:42"],
              smallest_fix: "Apply the shared authorization guard.",
              evidence: [],
            },
            {
              fingerprint: "low-severity",
              title: "Low severity observation",
              severity: "low",
              confidence: "high",
              actionable: true,
              risk: "Low impact.",
              locations: ["src/info.ts:1"],
              smallest_fix: "Optional hardening.",
              evidence: [],
            },
          ],
          dismissed: ["Credential ghp_abcdefghijklmnopqrstuvwxyz123456 was not reachable."],
        },
      },
      { githubClientFactory },
    );

    expect(finished.status).toBe("succeeded");
    expect(observed.issue).toMatchObject({
      title: "[Security] Authorization bypass",
      labels: ["facility-security", "needs-security-triage"],
    });
    const securityEvent = (
      await db.select({ data: runEvents.data }).from(runEvents).where(eq(runEvents.runId, run.id))
    ).find((event) => (event.data as { report?: unknown }).report);
    expect(securityEvent?.data).toMatchObject({
      report: {
        dismissed: ["Credential «redacted» was not reachable."],
      },
      reported: 2,
      eligible: 1,
    });
  });

  it("does not accept a successful security run without a valid findings artifact", async () => {
    const inserted = await insertRunnerRun("frt_security_missing", "running");
    const run = (
      await db
        .update(runs)
        .set({ mode: "security_sweep" })
        .where(eq(runs.id, inserted.id))
        .returning()
    )[0];
    if (!run) throw new Error("security run fixture missing");
    const finished = await finishRun(db, run, { status: "succeeded" });
    expect(finished).toMatchObject({ status: "failed", error: "security_report_invalid" });
  });

  it("finishRun appends the assistant reply to a conversation and marks it idle", async () => {
    const contract = (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId,
          kind: "agent_contract",
          name: `conversation-contract-${Date.now()}`,
        })
        .returning()
    )[0];
    if (!contract) throw new Error("contract fixture missing");
    const agent = (
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId,
          name: `conversation-agent-${Date.now()}`,
          engine: "claude_code",
          model: {},
          contractItemId: contract.id,
          triggers: [],
          permissions: [],
          enabled: true,
        })
        .returning()
    )[0];
    if (!agent) throw new Error("agent fixture missing");
    const conversation = (
      await db
        .insert(conversations)
        .values({
          id: newId("evt"),
          orgId,
          projectId,
          agentDefId: agent.id,
          status: "running",
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    if (!conversation) throw new Error("conversation fixture missing");
    const run = await insertRunnerRun("frt_finish_conversation", "running", newId("run"), {
      runnerTokenHash: await hashKey("frt_finish_conversation"),
    });
    await db
      .update(runs)
      .set({
        agentDefId: agent.id,
        engine: "claude_code",
        mode: "conversation",
        trigger: {
          type: "conversation",
          conversationId: conversation.id,
          message: "hello",
        },
      })
      .where(eq(runs.id, run.id));
    // The message handler pins the owning run; finishConversationTurn only
    // finalizes the run the conversation points at.
    await db
      .update(conversations)
      .set({ lastRunId: run.id })
      .where(eq(conversations.id, conversation.id));
    const [conversationRun] = await db.select().from(runs).where(eq(runs.id, run.id));
    if (!conversationRun) throw new Error("conversation run fixture missing");
    await appendRunEvents(db, orgId, run.id, [
      { type: "assistant", data: { text: "first reply" } },
      { type: "assistant", data: { text: "final reply" } },
    ]);
    await finishRun(db, conversationRun, {
      status: "succeeded",
      engineSessionId: "sess_conversation_2",
    });
    const messages = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversation.id))
      .orderBy(conversationMessages.seq);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("agent");
    expect(messages[0]?.body).toBe("final reply");
    expect(messages[0]?.runId).toBe(run.id);
    const [stored] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(stored?.status).toBe("idle");
    expect(stored?.lastRunId).toBe(run.id);
    expect(stored?.engineSessionId).toBe("sess_conversation_2");
  });

  it("a foreign run cannot finalize a conversation it doesn't own (even same agent)", async () => {
    const contract = (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId,
          kind: "agent_contract",
          name: `forge-contract-${Date.now()}`,
        })
        .returning()
    )[0];
    const sharedAgent = (
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId,
          name: `forge-agent-${Date.now()}`,
          engine: "claude_code",
          model: {},
          contractItemId: contract?.id ?? "",
          triggers: [],
          permissions: [],
          enabled: true,
        })
        .returning()
    )[0];
    if (!sharedAgent) throw new Error("shared agent fixture missing");
    // A running conversation pinned to its OWN in-flight run — same agent the
    // attacker uses, so ONLY the lastRunId pin distinguishes owner from forger.
    const victimRun = await insertRunnerRun("frt_victim", "running", newId("run"), {
      runnerTokenHash: await hashKey("frt_victim"),
    });
    const victimConversationId = newId("evt");
    await db.insert(conversations).values({
      id: victimConversationId,
      orgId,
      projectId,
      agentDefId: sharedAgent.id,
      status: "running",
      lastRunId: victimRun.id,
      createdBy: { type: "user", id: "victim" },
    });
    const forged = await insertRunnerRun("frt_forge", "running", newId("run"), {
      runnerTokenHash: await hashKey("frt_forge"),
    });
    await db
      .update(runs)
      .set({
        agentDefId: sharedAgent.id,
        engine: "claude_code",
        mode: "conversation",
        trigger: { type: "conversation", conversationId: victimConversationId },
      })
      .where(eq(runs.id, forged.id));
    const [forgedRun] = await db.select().from(runs).where(eq(runs.id, forged.id));
    if (!forgedRun) throw new Error("forged run fixture missing");
    await appendRunEvents(db, orgId, forged.id, [
      { type: "assistant", data: { text: "attacker reply" } },
    ]);
    await finishRun(db, forgedRun, {
      status: "succeeded",
      engineSessionId: "sess_attacker",
    }).catch(() => undefined);
    const [victim] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, victimConversationId));
    expect(victim?.status).toBe("running"); // untouched — still owned by victimRun
    expect(victim?.engineSessionId ?? null).toBeNull();
    const forgedMessages = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, victimConversationId));
    expect(forgedMessages).toHaveLength(0);
  });

  it("stores actual check outcomes and provenance in the run receipt", async () => {
    const token = "frt_receipt_checks";
    const run = await insertRunnerRun(token, "running");
    await appendRunEvents(db, orgId, run.id, [
      {
        type: "check",
        data: {
          command: "pnpm test",
          status: "passed",
          exit_code: 0,
          self_reported: false,
        },
      },
      {
        type: "check",
        data: { name: "agent smoke", status: " SKIPPED ", self_reported: true },
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/result`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "succeeded" },
    });
    expect(response.statusCode).toBe(200);
    const finished = (await db.select().from(runs).where(eq(runs.id, run.id)).limit(1))[0];
    expect((finished?.receipt as { checks?: unknown[] })?.checks).toEqual([
      { name: "pnpm test", status: "passed", source: "platform", exit_code: 0 },
      { name: "agent smoke", status: "skipped", source: "agent" },
    ]);
    expect((finished?.receipt as { checks_truncated?: boolean })?.checks_truncated).toBe(false);
  });

  it("discloses when a run receipt truncates its check list", async () => {
    const token = "frt_receipt_checks_truncated";
    const run = await insertRunnerRun(token, "running");
    await appendRunEvents(
      db,
      orgId,
      run.id,
      Array.from({ length: 201 }, (_, index) => ({
        type: "check",
        data: { name: `check ${index + 1}`, status: "passed", self_reported: false },
      })),
    );

    const response = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/result`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "succeeded" },
    });
    expect(response.statusCode).toBe(200);
    const finished = (await db.select().from(runs).where(eq(runs.id, run.id)).limit(1))[0];
    const receipt = finished?.receipt as {
      checks?: unknown[];
      checks_truncated?: boolean;
      events?: { checks?: number };
      integrity?: { payload_sha256?: string };
    };
    expect(receipt.checks).toHaveLength(200);
    expect(receipt.checks_truncated).toBe(true);
    expect(receipt.events?.checks).toBe(201);
    expect(verifyFacilityReceipt(receipt as never)).toBe(true);
    await expect(verifyStoredReceipts(db, orgId, [run.id])).resolves.toMatchObject({ ok: true });
  });

  it("delivers run events over the NOTIFY-backed SSE path without safety polling", async () => {
    const token = "frt_stream";
    const run = await insertRunnerRun(token, "running");
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const streamPromise = fetch(`${address}/v1/runs/${run.id}/stream?idleMs=1500`, {
      headers: { cookie },
    }).then((response) => response.text());
    await new Promise((resolve) => setTimeout(resolve, 100));
    const posted = await fetch(`${address}/internal/runs/${run.id}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([{ type: "assistant", data: { text: "notify delivered" } }]),
    });
    expect(posted.status).toBe(200);
    const body = await streamPromise;
    expect(body).toContain("event: run_event");
    expect(body).toContain("notify delivered");
  }, 10_000);

  it("returns per-installation clone credentials and bound security-sweep evidence", async () => {
    const token = "frt_clone";
    const installationNumber = Date.now();
    const owner = `octo-${installationNumber}`;
    const installation = (
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId,
          installationId: installationNumber,
          accountLogin: owner,
          targetType: "Organization",
        })
        .returning()
    )[0];
    if (!installation) throw new Error("failed to insert installation");
    await db.insert(repos).values({
      id: newId("repo"),
      orgId,
      projectId,
      installationId: installation.id,
      owner,
      name: "private-repo",
      defaultBranch: "main",
    });
    const runId = newId("run");
    const run = await insertRunnerRun(token, "provisioning", runId, {
      runnerTokenHash: await hashKey(token),
      sealedVirtualKey: await seal("fvk_test", masterKey),
      bundle: {
        runId,
        mode: "security-sweep",
        engine: "byo",
        contract: "contract",
        skills: [],
        engineConfig: {},
        repo: {
          cloneUrl: `https://github.com/${owner}/private-repo.git`,
          branch: "main",
          expectedHeadSha: null,
          installationTokenRef: installation.id,
        },
        packageInstallCmd: "pnpm install --frozen-lockfile",
        provisionCmd: null,
        checkCmds: [],
        gatewayUrls: { anthropic: "http://gateway/anthropic", openai: "http://gateway/openai" },
        scope: {},
        timeoutMin: 60,
      },
    });
    await db.update(runs).set({ mode: "security-sweep" }).where(eq(runs.id, run.id));
    let tokenInput: Record<string, unknown> | undefined;
    app.githubInstallationTokenFactory = async (input) => {
      tokenInput = input;
      return "installation-token";
    };
    const previousGithubFactory = app.githubClientFactory;
    app.githubClientFactory = async (actualInstallationId) => {
      expect(actualInstallationId).toBe(installationNumber);
      return {
        request: async (route: string) => ({
          data: route.includes("dependency-graph") ? { sbom: { packages: [] } } : [],
        }),
        rest: {
          repos: {
            getBranch: async () => ({ data: { commit: { sha: "a".repeat(40) } } }),
          },
        },
      } as never;
    };

    const response = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/hello`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const hello = response.json();
    expect(hello.repoToken).toBe("installation-token");
    expect(hello.packageRegistryToken).toBe("package-token");
    expect(hello.securitySweepEvidence).toMatchObject({
      schema: "facility.security.sweep-input.v1",
      runId,
      repository: {
        owner,
        name: "private-repo",
        ref: "main",
        headSha: "a".repeat(40),
      },
      sources: {
        codeScanning: [],
        dependabot: [],
        secretScanning: [],
        sbom: { sbom: { packages: [] } },
      },
    });
    expect(hello.bundleUrl).not.toContain("?");
    const bundlePath = new URL(hello.bundleUrl).pathname;
    expect((await app.inject({ method: "GET", url: bundlePath })).statusCode).toBe(401);
    const bundleResponse = await app.inject({
      method: "GET",
      url: bundlePath,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bundleResponse.statusCode).toBe(200);
    expect(bundleResponse.json().runId).toBe(runId);
    expect(tokenInput).toEqual({
      installationId: installationNumber,
      owner,
      repo: "private-repo",
      permissions: { contents: "read" },
    });
    const replay = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/hello`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe("virtual_key_revealed");
    app.githubInstallationTokenFactory = undefined;
    app.githubClientFactory = previousGithubFactory;
  });

  it("does not release the package token when no dedicated install phase exists", async () => {
    const token = `frt_no_package_${Date.now()}`;
    const runId = newId("run");
    const run = await insertRunnerRun(token, "provisioning", runId, {
      runnerTokenHash: await hashKey(token),
      sealedVirtualKey: await seal("fvk_no_package", masterKey),
      bundle: {
        runId,
        mode: "architect",
        engine: "byo",
        contract: "contract",
        skills: [],
        engineConfig: {},
        repo: { cloneUrl: null, branch: null, expectedHeadSha: null, installationTokenRef: null },
        packageInstallCmd: null,
        provisionCmd: null,
        checkCmds: [],
        gatewayUrls: { anthropic: "http://gateway/anthropic", openai: "http://gateway/openai" },
        scope: {},
        timeoutMin: 60,
      },
    });
    const response = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/hello`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().packageRegistryToken).toBeNull();
  });

  it("preserves provider-owned sandbox state when hello claims credentials", async () => {
    const token = `frt_hello_merge_${Date.now()}`;
    const runId = newId("run");
    const launchedAt = new Date().toISOString();
    const run = await insertRunnerRun(token, "provisioning", runId, {
      driver: "vercel",
      ref: "v1.provider-ref",
      launchedAt,
      runnerTokenHash: await hashKey(token),
      sealedVirtualKey: await seal("fvk_hello_merge", masterKey),
      bundle: {
        runId,
        mode: "architect",
        engine: "byo",
        contract: "contract",
        skills: [],
        engineConfig: {},
        repo: { cloneUrl: null, branch: null, expectedHeadSha: null, installationTokenRef: null },
        packageInstallCmd: null,
        provisionCmd: null,
        checkCmds: [],
        gatewayUrls: { anthropic: "http://gateway/anthropic", openai: "http://gateway/openai" },
        scope: {},
        timeoutMin: 60,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/hello`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const [stored] = await db.select().from(runs).where(eq(runs.id, run.id));
    const state = readSandbox(stored?.sandbox);
    expect(state.ref).toBe("v1.provider-ref");
    expect(state.launchedAt).toBe(launchedAt);
    expect(state.virtualKeyRevealedAt).toEqual(expect.any(String));
  });

  it("denies credential release after a run is terminal", async () => {
    const token = `frt_terminal_${Date.now()}`;
    const run = await insertRunnerRun(token, "failed", newId("run"), {
      runnerTokenHash: await hashKey(token),
      sealedVirtualKey: await seal("fvk_terminal", masterKey),
      bundle: { packageInstallCmd: "pnpm install --frozen-lockfile" },
    });
    const response = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/hello`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("run_terminal");
  });

  it("redacts sealed run credentials from run read APIs", async () => {
    const runId = newId("run");
    const run = await insertRunnerRun("frt_redact", "provisioning", runId, {
      driver: "docker",
      ref: "container-redact",
      virtualKeyId: "vk_redact",
      platformKeyId: "ak_redact",
      runnerTokenHash: await hashKey("frt_redact"),
      sealedVirtualKey: await seal("fvk_secret", masterKey),
      sealedPlatformKey: await seal("fak_secret", masterKey),
    });

    const single = await app.inject({
      method: "GET",
      url: `/v1/runs/${run.id}`,
      headers: { cookie },
    });
    expect(single.statusCode).toBe(200);
    const sandbox = (single.json().sandbox ?? {}) as Record<string, unknown>;
    // Secrets stripped...
    expect(sandbox.sealedVirtualKey).toBeUndefined();
    expect(sandbox.sealedPlatformKey).toBeUndefined();
    expect(sandbox.runnerTokenHash).toBeUndefined();
    // ...non-secret fields retained (the UI/CLI still need driver + ref).
    expect(sandbox.driver).toBe("docker");
    expect(sandbox.ref).toBe("container-redact");

    const list = await app.inject({ method: "GET", url: "/v1/runs", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const listed = (list.json() as Array<{ id: string; sandbox?: Record<string, unknown> }>).find(
      (r) => r.id === run.id,
    );
    expect(listed?.sandbox?.sealedVirtualKey).toBeUndefined();
    expect(listed?.sandbox?.sealedPlatformKey).toBeUndefined();
    expect(listed?.sandbox?.runnerTokenHash).toBeUndefined();

    // The project-scoped run list is a run-read surface too — it must redact.
    const projList = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/runs`,
      headers: { cookie },
    });
    expect(projList.statusCode).toBe(200);
    const projListed = (
      projList.json() as Array<{ id: string; sandbox?: Record<string, unknown> }>
    ).find((r) => r.id === run.id);
    expect(projListed?.sandbox?.sealedVirtualKey).toBeUndefined();
    expect(projListed?.sandbox?.sealedPlatformKey).toBeUndefined();
    expect(projListed?.sandbox?.runnerTokenHash).toBeUndefined();
  });

  it("reconciler revokes orphaned run keys (virtual + platform) of a terminal run", async () => {
    const runId = newId("run");
    // A run that reached a terminal state but (simulating a crash between the
    // status commit and the best-effort revoke) still owns live keys.
    await insertRunnerRun("frt_orphan", "succeeded", runId, {});
    // Far-future expiry throughout, so the assertions prove the *sweep* revoked
    // the keys, not their own natural expiry.
    const farFuture = new Date(Date.now() + 3_600_000);
    const vkeyId = newId("vkey");
    await db.insert(virtualKeys).values({
      id: vkeyId,
      orgId,
      projectId,
      runId,
      name: "orphan run key",
      prefix: `orphan_${Date.now()}`,
      last4: "0000",
      hash: "orphan-hash",
      expiresAt: farFuture,
    });
    const roleId = newId("key");
    await db
      .insert(roles)
      .values({ id: roleId, orgId, name: `sweep-role-${Date.now()}`, permissions: [] });
    const platformKeyId = newId("key");
    await db.insert(apiKeys).values({
      id: platformKeyId,
      orgId,
      name: "orphan platform key",
      prefix: `orphanpk_${Date.now()}`,
      last4: "0000",
      hash: "orphan-pk-hash",
      scopeType: "project",
      projectId,
      roleId,
      runId,
      expiresAt: farFuture,
    });

    await reconcileSandboxes(config);

    const [vkey] = await db.select().from(virtualKeys).where(eq(virtualKeys.id, vkeyId));
    expect(vkey?.revokedAt).not.toBeNull();
    const [pkey] = await db.select().from(apiKeys).where(eq(apiKeys.id, platformKeyId));
    expect(pkey?.revokedAt).not.toBeNull();
  });

  it("does not turn a healthy inline session into a wall-clock timeout", async () => {
    const runId = newId("run");
    await insertRunnerRun("frt_unbounded_inline", "running", runId, { inline: true });
    await db
      .update(runs)
      .set({ startedAt: new Date(Date.now() - 24 * 60 * 60_000) })
      .where(eq(runs.id, runId));

    await reconcileSandboxes(config);

    const [stored] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    expect(stored?.status).toBe("running");
    await db
      .update(runs)
      .set({ status: "canceled", endedAt: new Date() })
      .where(eq(runs.id, runId));
  });

  it("rejects an expired run-scoped platform key at authentication", async () => {
    const roleId = newId("key");
    await db
      .insert(roles)
      .values({ id: roleId, orgId, name: `expiry-role-${Date.now()}`, permissions: ["runs:read"] });
    const expired = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: expired.id,
      orgId,
      name: "expired run key",
      prefix: expired.lookup,
      last4: expired.last4,
      hash: expired.hash,
      scopeType: "project",
      projectId,
      roleId,
      // Already expired: auth must reject it even though it's not revoked.
      // (runId omitted — expiry enforcement is independent of the run link.)
      expiresAt: new Date(Date.now() - 1000),
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${expired.secret}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("launches, stops, and destroys a docker sleep container when Docker is reachable", async () => {
    if (!(await dockerReachable())) {
      console.warn("Docker socket is not reachable from this sandbox; skipping docker driver test");
      return;
    }
    const driver = new DockerSandboxDriver();
    const launched = await driver.launch({
      runId: `run_${Date.now()}`,
      image: "alpine:3.20",
      env: {},
      cpu: 0.5,
      memoryMb: 128,
      timeoutMin: 1,
      cmd: ["sleep", "30"],
    });
    expect(await driver.status(launched.ref)).toBe("running");
    await driver.stop(launched.ref);
    expect(await driver.status(launched.ref)).toBe("exited");
    await driver.destroy(launched.ref);
    expect(await driver.status(launched.ref)).toBe("lost");
  }, 60_000);

  it("isolates run sweeps from other instances and preview workloads", async () => {
    if (!(await dockerReachable())) {
      console.warn("Docker socket is not reachable from this sandbox; skipping namespace test");
      return;
    }
    const driver = new DockerSandboxDriver();
    const refs: string[] = [];
    try {
      const alphaRun = await driver.launch({
        runId: `run_alpha_${Date.now()}`,
        namespace: "instance_alpha",
        kind: "run",
        image: "alpine:3.20",
        env: {},
        cpu: 0.5,
        memoryMb: 128,
        timeoutMin: 1,
        cmd: ["sleep", "30"],
      });
      refs.push(alphaRun.ref);
      const betaRun = await driver.launch({
        runId: `run_beta_${Date.now()}`,
        namespace: "instance_beta",
        kind: "run",
        image: "alpine:3.20",
        env: {},
        cpu: 0.5,
        memoryMb: 128,
        timeoutMin: 1,
        cmd: ["sleep", "30"],
      });
      refs.push(betaRun.ref);
      const alphaPreview = await driver.launch({
        runId: `preview:alpha_${Date.now()}`,
        namespace: "instance_alpha",
        kind: "preview",
        image: "alpine:3.20",
        env: {},
        cpu: 0.5,
        memoryMb: 128,
        timeoutMin: 1,
        cmd: ["sleep", "30"],
      });
      refs.push(alphaPreview.ref);

      expect(await driver.listFacilityContainers("instance_alpha")).toEqual([
        { ref: alphaRun.ref, runId: expect.stringMatching(/^run_alpha_/) },
      ]);
      expect(await driver.listFacilityContainers("instance_beta")).toEqual([
        { ref: betaRun.ref, runId: expect.stringMatching(/^run_beta_/) },
      ]);
      expect(await driver.status(alphaPreview.ref)).toBe("running");
    } finally {
      await Promise.all(refs.map((ref) => driver.destroy(ref).catch(() => undefined)));
    }
  }, 60_000);

  it("reconciler destroys orphan docker containers after label and run-state double check", async () => {
    if (!(await dockerReachable())) {
      console.warn(
        "Docker socket is not reachable from this sandbox; skipping docker reconciler test",
      );
      return;
    }
    const driver = new DockerSandboxDriver();
    const runId = `run_orphan_${Date.now()}`;
    const launched = await driver.launch({
      runId,
      namespace: sandboxNamespace(config),
      image: "alpine:3.20",
      env: {},
      cpu: 0.5,
      memoryMb: 128,
      timeoutMin: 1,
      cmd: ["sleep", "30"],
    });
    await reconcileSandboxes(config);
    expect(await driver.status(launched.ref)).toBe("lost");
  }, 60_000);

  it("reconciler records terminal sandbox cleanup so provider deletion is not retried forever", async () => {
    if (!(await dockerReachable())) {
      console.warn(
        "Docker socket is not reachable from this sandbox; skipping terminal cleanup test",
      );
      return;
    }
    const driver = new DockerSandboxDriver();
    const runId = newId("run");
    const launched = await driver.launch({
      runId,
      namespace: sandboxNamespace(config),
      image: "alpine:3.20",
      env: {},
      cpu: 0.5,
      memoryMb: 128,
      timeoutMin: 1,
      cmd: ["sleep", "30"],
    });
    try {
      await insertRunnerRun("frt_terminal_cleanup", "failed", runId, {
        driver: "docker",
        ref: launched.ref,
      });

      await reconcileSandboxes(config);

      expect(await driver.status(launched.ref)).toBe("lost");
      const [stored] = await db.select().from(runs).where(eq(runs.id, runId));
      const state = readSandbox(stored?.sandbox);
      expect(state.lastStatus).toBe("destroyed");
      expect(state.destroyedAt).toEqual(expect.any(String));
    } finally {
      await driver.destroy(launched.ref).catch(() => undefined);
    }
  }, 60_000);

  async function insertRunnerRun(
    token: string,
    status: string,
    runId = newId("run"),
    sandbox?: Record<string, unknown>,
  ) {
    const sandboxState = sandbox ?? { runnerTokenHash: await hashKey(token) };
    const row = (
      await db
        .insert(runs)
        .values({
          id: runId,
          orgId,
          projectId,
          mode: "builder",
          engine: "byo",
          status,
          trigger: {},
          sandbox: sandboxState,
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    if (!row) throw new Error("failed to insert runner run");
    return row;
  }
});
