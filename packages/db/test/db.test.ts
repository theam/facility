import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashChain, newId } from "@facility/core";
import { count, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analysisSandboxProfileId,
  applyMigrations,
  builderSandboxProfileId,
  createDb,
  defaultSandboxProfileId,
  deployDatabase,
  insertAuditEvent,
  MigrationChecksumError,
  MigrationExecutionError,
  MigrationLockTimeoutError,
  migrate,
  seed,
  seedBundledRegistryForOrg,
  verifyAuditChain,
  withOrg,
} from "../src/index.js";
import * as schema from "../src/schema.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";

async function canConnect() {
  // Generous connect timeout: this runs during vitest's module-import phase,
  // which can block the event loop long enough that a too-tight timeout races the
  // cold connection and spuriously skips the whole suite on a healthy local DB.
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end().catch(() => undefined);
  }
}

describe("db", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; DB integration tests skipped", () =>
      undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);

  beforeAll(async () => {
    await Promise.all([migrate(databaseUrl), migrate(databaseUrl), migrate(databaseUrl)]);
  });

  afterAll(async () => {
    await client.end();
  });

  it("stores migration checksums and rejects edits to applied SQL before applying more", async () => {
    const migrationsDir = await mkdtemp(join(tmpdir(), "facility-migrations-"));
    const schemaName = `migration_test_${randomUUID().replaceAll("-", "_")}`;
    const isolated = postgres(databaseUrl, { max: 1 });
    try {
      await isolated.unsafe(`CREATE SCHEMA "${schemaName}"`);
      await isolated.unsafe(`SET search_path TO "${schemaName}"`);
      await writeFile(join(migrationsDir, "0001_first.sql"), "CREATE TABLE first (id text);\n");

      const first = await applyMigrations(isolated, { migrationsDir, log: () => undefined });
      expect(first.applied).toEqual(["0001_first.sql"]);
      const checksumRows = await isolated<{ checksum: string | null }[]>`
        SELECT checksum FROM _facility_migrations WHERE name = '0001_first.sql'
      `;
      expect(checksumRows[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);

      const second = await applyMigrations(isolated, { migrationsDir, log: () => undefined });
      expect(second.skipped).toEqual(["0001_first.sql"]);
      await isolated`UPDATE _facility_migrations SET checksum = NULL WHERE name = '0001_first.sql'`;
      const legacy = await applyMigrations(isolated, { migrationsDir, log: () => undefined });
      expect(legacy.backfilled).toEqual(["0001_first.sql"]);

      await writeFile(join(migrationsDir, "0001_first.sql"), "CREATE TABLE first (id text);\n\n");
      await writeFile(join(migrationsDir, "0002_second.sql"), "CREATE TABLE second (id text);\n");
      await expect(
        applyMigrations(isolated, { migrationsDir, log: () => undefined }),
      ).rejects.toBeInstanceOf(MigrationChecksumError);
      const secondTable = await isolated<{ name: string | null }[]>`
        SELECT to_regclass('second')::text AS name
      `;
      expect(secondTable[0]?.name).toBeNull();

      await writeFile(join(migrationsDir, "0001_first.sql"), "CREATE TABLE first (id text);\n");
      await writeFile(
        join(migrationsDir, "0002_second.sql"),
        "CREATE TABLE rolled_back (id text); SELECT * FROM table_that_does_not_exist;\n",
      );
      await expect(
        applyMigrations(isolated, { migrationsDir, log: () => undefined }),
      ).rejects.toBeInstanceOf(MigrationExecutionError);
      const rollbackRows = await isolated<{ ledger: number; table_name: string | null }[]>`
        SELECT
          (SELECT count(*)::int FROM _facility_migrations WHERE name = '0002_second.sql') AS ledger,
          to_regclass('rolled_back')::text AS table_name
      `;
      expect(rollbackRows[0]).toEqual({ ledger: 0, table_name: null });
    } finally {
      await isolated.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => undefined);
      await isolated.end();
      await rm(migrationsDir, { recursive: true, force: true });
    }
  });

  it("times out cleanly when another deploy holds the database lock", async () => {
    const blocker = postgres(databaseUrl, { max: 1 });
    const events: Array<{ phase: string; status: string }> = [];
    try {
      await blocker`SELECT pg_advisory_lock(hashtext('facility:migrations'))`;
      await expect(
        deployDatabase(databaseUrl, {
          includeDemoData: false,
          lockPollMs: 5,
          lockTimeoutMs: 20,
          log: (event) => events.push(event),
        }),
      ).rejects.toBeInstanceOf(MigrationLockTimeoutError);
      expect(events).toContainEqual(expect.objectContaining({ phase: "lock", status: "failed" }));
      expect(events).not.toContainEqual(
        expect.objectContaining({ phase: "migrations", status: "started" }),
      );
    } finally {
      await blocker`SELECT pg_advisory_unlock(hashtext('facility:migrations'))`.catch(
        () => undefined,
      );
      await blocker.end();
    }
  });

  it("enforces GitHub-delivery, CI-repair, and active-preview idempotency in Postgres", async () => {
    const orgId = newId("org");
    const projectId = newId("proj");
    await db.insert(schema.orgs).values({
      id: orgId,
      name: "Idempotency constraints",
      slug: `idempotency-${orgId}`,
      settings: {},
    });
    await db.insert(schema.projects).values({
      id: projectId,
      orgId,
      name: "Idempotency constraints",
      slug: "idempotency",
      settings: {},
    });

    const run = (overrides: Partial<typeof schema.runs.$inferInsert> = {}) => ({
      id: newId("run"),
      orgId,
      projectId,
      mode: "builder",
      engine: "codex",
      trigger: {},
      sandbox: {},
      gh: {},
      createdBy: { type: "test", id: "db-idempotency" },
      ...overrides,
    });

    const deliveryId = `delivery-${randomUUID()}`;
    await db.insert(schema.runs).values(run({ githubDeliveryId: deliveryId }));
    await expect(
      db.insert(schema.runs).values(run({ githubDeliveryId: deliveryId })),
    ).rejects.toMatchObject({
      cause: { code: "23505", constraint_name: "runs_org_github_delivery_uidx" },
    });

    const ciRepairKey = randomUUID().replaceAll("-", "");
    await db
      .insert(schema.runs)
      .values(
        run({ ciRepairKey, githubDeliveryId: `delivery-${randomUUID()}`, mode: "ci_doctor" }),
      );
    await expect(
      db
        .insert(schema.runs)
        .values(
          run({ ciRepairKey, githubDeliveryId: `delivery-${randomUUID()}`, mode: "ci_doctor" }),
        ),
    ).rejects.toMatchObject({
      cause: { code: "23505", constraint_name: "runs_org_ci_repair_key_uidx" },
    });

    const previewRun = await db.insert(schema.runs).values(run()).returning({ id: schema.runs.id });
    const runId = previewRun[0]?.id;
    if (!runId) throw new Error("preview idempotency run fixture missing");
    const expiresAt = new Date(Date.now() + 60_000);
    await db.insert(schema.previewSandboxes).values({
      id: newId("sbx"),
      orgId,
      projectId,
      runId,
      status: "failed",
      driver: "aws",
      config: {},
      expiresAt,
      createdBy: { type: "test", id: "terminal-preview" },
    });
    await db.insert(schema.previewSandboxes).values({
      id: newId("sbx"),
      orgId,
      projectId,
      runId,
      status: "provisioning",
      driver: "aws",
      config: {},
      expiresAt,
      createdBy: { type: "test", id: "active-preview" },
    });
    await expect(
      db.insert(schema.previewSandboxes).values({
        id: newId("sbx"),
        orgId,
        projectId,
        runId,
        status: "running",
        driver: "aws",
        config: {},
        expiresAt,
        createdBy: { type: "test", id: "duplicate-active-preview" },
      }),
    ).rejects.toMatchObject({
      cause: { code: "23505", constraint_name: "preview_sandboxes_run_uidx" },
    });
  });

  it("runs schema and system-data reconciliation behind one deploy entry point", async () => {
    const observer = postgres(databaseUrl, { max: 1 });
    // Open the observer before the very short empty-database reconciliation;
    // otherwise connection startup can finish only after the deploy unlocks.
    await observer`SELECT 1`;
    const events: Array<{
      migrationsApplied?: number;
      migrationsSkipped?: number;
      phase: string;
      status: string;
    }> = [];
    const observeLock = () => observer<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext('facility:migrations')) AS acquired
    `;
    let reconciliationLock: Promise<Awaited<ReturnType<typeof observeLock>>> | undefined;
    try {
      await deployDatabase(databaseUrl, {
        includeDemoData: false,
        log: (event) => {
          events.push(event);
          if (event.phase === "reconciliation" && event.status === "started") {
            // postgres.js queries are lazy; attaching then() here makes this
            // observation race reconciliation, not the post-deploy assertion.
            reconciliationLock = observeLock().then((rows) => rows);
          }
        },
      });
      expect((await reconciliationLock)?.[0]?.acquired).toBe(false);
    } finally {
      await observer.end();
    }
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "lock", status: "completed" }),
        expect.objectContaining({ phase: "migrations", status: "completed" }),
        expect.objectContaining({ phase: "reconciliation", status: "completed" }),
        expect.objectContaining({ phase: "deploy", status: "completed" }),
      ]),
    );
    const migrationEvent = events.find(
      (event) => event.phase === "migrations" && event.status === "completed",
    );
    expect(migrationEvent?.migrationsApplied).toBe(0);
    expect(migrationEvent?.migrationsSkipped).toBeGreaterThan(0);
  });

  it("round-trips typed rows across core tables", async () => {
    const orgId = newId("org");
    const userId = newId("user");
    const projectId = newId("proj");
    const roleId = `role_test_${orgId}`;
    await db
      .insert(schema.orgs)
      .values({ id: orgId, name: "Test Org", slug: `org-${orgId}`, settings: {} });
    await db
      .insert(schema.users)
      .values({ id: userId, email: `${userId}@example.com`, status: "active" });
    await db
      .insert(schema.roles)
      .values({ id: roleId, orgId, name: "custom", permissions: ["projects:read"] });
    await db.insert(schema.orgMembers).values({ id: newId("user"), orgId, userId, roleId });
    await db
      .insert(schema.projects)
      .values({ id: projectId, orgId, name: "Project", slug: "project", settings: {} });
    await db.insert(schema.repos).values({
      id: newId("repo"),
      orgId,
      projectId,
      owner: `owner-${orgId}`,
      name: "repo",
      defaultBranch: "main",
    });
    await db.insert(schema.runs).values({
      id: newId("run"),
      orgId,
      projectId,
      mode: "builder",
      engine: "codex",
      createdBy: { type: "user", id: userId },
    });

    const rows = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    expect(rows[0]?.orgId).toBe(orgId);
  });

  it("scoped helpers refuse cross-org reads", async () => {
    const orgA = newId("org");
    const orgB = newId("org");
    const projectId = newId("proj");
    await db.insert(schema.orgs).values([
      { id: orgA, name: "A", slug: `a-${orgA}`, settings: {} },
      { id: orgB, name: "B", slug: `b-${orgB}`, settings: {} },
    ]);
    await db
      .insert(schema.projects)
      .values({ id: projectId, orgId: orgA, name: "Secret", slug: "secret", settings: {} });
    expect(await withOrg(db, orgA).projects.byId(projectId)).not.toBeNull();
    expect(await withOrg(db, orgB).projects.byId(projectId)).toBeNull();
  });

  it("inserts audit events with a core-compatible hash chain", async () => {
    const orgId = newId("org");
    await db
      .insert(schema.orgs)
      .values({ id: orgId, name: "Audit", slug: `audit-${orgId}`, settings: {} });
    const first = await insertAuditEvent(db, {
      orgId,
      actor: { type: "system", id: "test" },
      action: "org.created",
      target: { type: "org", id: orgId },
      payload: { ok: true },
    });
    const second = await insertAuditEvent(db, {
      orgId,
      actor: { type: "system", id: "test" },
      action: "project.created",
      target: { type: "project", id: "p" },
      payload: {},
    });
    expect(first?.hash).toBe(
      hashChain(null, {
        actor: first?.actor,
        action: first?.action,
        target: first?.target,
        payload: first?.payload,
      }),
    );
    expect(second?.prevHash).toBe(first?.hash);
  });

  it("keeps the audit chain valid when JSON persistence omits undefined fields", async () => {
    const orgId = newId("org");
    await db
      .insert(schema.orgs)
      .values({ id: orgId, name: "Audit JSON", slug: `audit-json-${orgId}`, settings: {} });

    const event = await insertAuditEvent(db, {
      orgId,
      actor: { type: "agent", id: "run_success" },
      action: "run.finished",
      target: { type: "run", id: "run_success" },
      payload: { status: "succeeded", error: undefined, values: [undefined, "kept"] },
    });

    expect(event?.payload).toEqual({ status: "succeeded", values: [null, "kept"] });
    await expect(verifyAuditChain(db, orgId)).resolves.toEqual({
      ok: true,
      firstBreakSeq: null,
    });
  });

  it("seeds idempotently", async () => {
    await seed(databaseUrl);
    const before = (await db.select({ value: count() }).from(schema.registryItems))[0]?.value ?? 0;
    await seed(databaseUrl);
    const after = (await db.select({ value: count() }).from(schema.registryItems))[0]?.value ?? 0;
    expect(after).toBe(before);
  });

  it("seeds a newly admitted organization through the typed transaction path", async () => {
    const orgId = newId("org");
    await db.insert(schema.orgs).values({
      id: orgId,
      name: "Admission Seed Org",
      slug: `admission-seed-${orgId}`,
      settings: {},
    });

    await expect(seedBundledRegistryForOrg(db, orgId)).resolves.toBeUndefined();
    const profiles = await db
      .select({ name: schema.sandboxProfiles.name, resources: schema.sandboxProfiles.resources })
      .from(schema.sandboxProfiles)
      .where(eq(schema.sandboxProfiles.orgId, orgId));
    expect(profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Default runner",
          resources: { cpu: 2, memory_mb: 4096, timeout_min: 60 },
        }),
        expect.objectContaining({
          name: "Analysis runner",
          resources: { cpu: 2, memory_mb: 4096, timeout_min: 60 },
        }),
        expect.objectContaining({
          name: "Builder runner",
          resources: { cpu: 2, memory_mb: 4096, timeout_min: 60 },
        }),
      ]),
    );
  });

  it("seeds bundled Project Owner and learning agents enabled", async () => {
    await seed(databaseUrl);
    const agents = await db
      .select()
      .from(schema.agentDefs)
      .where(inArray(schema.agentDefs.id, ["agent_dev_project_owner", "agent_dev_learning"]));
    expect(agents).toHaveLength(2);
    expect(agents.map((agent) => [agent.name, agent.enabled]).sort()).toEqual([
      ["learning", true],
      ["project-owner", true],
    ]);
    const po = agents.find((agent) => agent.name === "project-owner");
    expect(po?.engine).toBe("claude_code");
    expect(po?.model).toEqual({ model: "claude-sonnet-5" });
  });

  it("non-demo seed populates org essentials without demo projects", async () => {
    const orgId = newId("org");
    await db.insert(schema.orgs).values({
      id: orgId,
      name: "Prod Seed Org",
      slug: `prod-seed-${orgId}`,
      settings: {},
    });
    await seed(databaseUrl, { includeDemoData: false });
    const seededActionTypes = await db
      .select()
      .from(schema.actionTypes)
      .where(eq(schema.actionTypes.orgId, orgId));
    const seededProfiles = await db
      .select()
      .from(schema.sandboxProfiles)
      .where(eq(schema.sandboxProfiles.orgId, orgId));
    const seededProjects = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.orgId, orgId));
    const bundledItems = await db
      .select()
      .from(schema.registryItems)
      .where(eq(schema.registryItems.orgId, orgId));
    expect(seededActionTypes.map((action) => action.name).sort()).toEqual([
      "budget_override",
      "guard_candidate",
      "issue_update",
      "kb_amendment",
      "kickstart_review",
      "learning_validation",
      "mcp_tool_call",
      "plan_acceptance",
      "rule_proposal",
      "skill_proposal",
      "task_creation",
    ]);
    expect(seededProfiles.map((profile) => profile.name).sort()).toEqual([
      "Analysis runner",
      "Builder runner",
      "Default runner",
    ]);
    expect(seededProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Default runner",
          resources: { cpu: 2, memory_mb: 4096, timeout_min: 60 },
        }),
        expect.objectContaining({
          name: "Analysis runner",
          resources: { cpu: 2, memory_mb: 4096, timeout_min: 60 },
        }),
        expect.objectContaining({
          name: "Builder runner",
          resources: { cpu: 2, memory_mb: 4096, timeout_min: 60 },
        }),
      ]),
    );
    expect(seededActionTypes.find((action) => action.name === "plan_acceptance")?.executor).toEqual(
      {
        type: "internal",
        config: {},
      },
    );
    expect(seededProjects).toHaveLength(0);
    expect(bundledItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "learning-agent", kind: "agent_contract" }),
        expect.objectContaining({ name: "product-chain", kind: "harness" }),
      ]),
    );

    const learningItem = bundledItems.find((item) => item.name === "learning-agent");
    if (!learningItem) throw new Error("learning-agent fixture missing");
    await db
      .update(schema.registryVersions)
      .set({ content: "stale bundled contract", contentHash: "stale" })
      .where(eq(schema.registryVersions.itemId, learningItem.id));
    await seed(databaseUrl, { includeDemoData: false });
    const refreshedLearning = (
      await db
        .select()
        .from(schema.registryVersions)
        .where(eq(schema.registryVersions.itemId, learningItem.id))
        .limit(1)
    )[0];
    expect(refreshedLearning?.content).toContain("<progress_protocol>");
    expect(refreshedLearning?.content).toContain(".agent-sdlc/progress.md");
    expect(refreshedLearning?.content).toContain("<submission_protocol>");
    expect(refreshedLearning?.contentHash).not.toBe("stale");

    const planAcceptance = seededActionTypes.find((action) => action.name === "plan_acceptance");
    if (!planAcceptance) throw new Error("plan_acceptance fixture missing");
    await db
      .update(schema.actionTypes)
      .set({ executor: { type: "webhook", config: { url: "https://hooks.invalid/plan" } } })
      .where(eq(schema.actionTypes.id, planAcceptance.id));
    await seed(databaseUrl, { includeDemoData: false });
    expect(
      await db.select().from(schema.actionTypes).where(eq(schema.actionTypes.orgId, orgId)),
    ).toHaveLength(seededActionTypes.length);
    expect(
      await db.select().from(schema.sandboxProfiles).where(eq(schema.sandboxProfiles.orgId, orgId)),
    ).toHaveLength(seededProfiles.length);
    expect(
      (
        await db
          .select()
          .from(schema.actionTypes)
          .where(eq(schema.actionTypes.id, planAcceptance.id))
          .limit(1)
      )[0]?.executor,
    ).toEqual({ type: "webhook", config: { url: "https://hooks.invalid/plan" } });
  });

  it("moves only managed agents to their tenant's optimized profile", async () => {
    const orgA = newId("org");
    const orgB = newId("org");
    const projectA = newId("proj");
    const projectB = newId("proj");
    await db.insert(schema.orgs).values([
      { id: orgA, name: "Analysis A", slug: `analysis-a-${orgA}`, settings: {} },
      { id: orgB, name: "Analysis B", slug: `analysis-b-${orgB}`, settings: {} },
    ]);
    await db.insert(schema.projects).values([
      { id: projectA, orgId: orgA, name: "Analysis A", slug: "analysis", settings: {} },
      { id: projectB, orgId: orgB, name: "Analysis B", slug: "analysis", settings: {} },
    ]);
    await seed(databaseUrl, { includeDemoData: false });

    const contractA = (
      await db
        .select({ id: schema.registryItems.id })
        .from(schema.registryItems)
        .where(eq(schema.registryItems.orgId, orgA))
        .limit(1)
    )[0];
    const contractB = (
      await db
        .select({ id: schema.registryItems.id })
        .from(schema.registryItems)
        .where(eq(schema.registryItems.orgId, orgB))
        .limit(1)
    )[0];
    if (!contractA || !contractB) throw new Error("analysis migration contract fixtures missing");

    const customProfileId = newId("sbx");
    await db.insert(schema.sandboxProfiles).values({
      id: customProfileId,
      orgId: orgA,
      name: "Custom analysis",
      driver: "docker",
      image: "custom-runner:test",
      setup: {},
      resources: {},
      network: {},
    });
    const fixtures = [
      {
        id: newId("agent"),
        orgId: orgA,
        projectId: projectA,
        name: "review",
        contractItemId: contractA.id,
        sandboxProfileId: defaultSandboxProfileId(orgA),
      },
      {
        id: newId("agent"),
        orgId: orgA,
        projectId: projectA,
        name: "architect",
        contractItemId: contractA.id,
        sandboxProfileId: customProfileId,
      },
      {
        id: newId("agent"),
        orgId: orgA,
        projectId: projectA,
        name: "security-sweep",
        contractItemId: contractA.id,
        sandboxProfileId: null,
      },
      {
        id: newId("agent"),
        orgId: orgA,
        projectId: projectA,
        name: "builder",
        contractItemId: contractA.id,
        sandboxProfileId: defaultSandboxProfileId(orgA),
      },
      {
        id: newId("agent"),
        orgId: orgB,
        projectId: projectB,
        name: "codex-architect",
        contractItemId: contractB.id,
        sandboxProfileId: defaultSandboxProfileId(orgB),
      },
    ].map((fixture) => ({
      ...fixture,
      engine: "codex",
      model: {},
      triggers: [],
      permissions: [],
      enabled: true,
      // These rows model agents created before the managed Analysis profile was
      // introduced. Later API edits advance updatedAt and are not migrated.
      createdAt: new Date("2020-01-01T00:00:00Z"),
      updatedAt: new Date("2020-01-01T00:00:00Z"),
    }));
    await db.insert(schema.agentDefs).values(fixtures);

    await seed(databaseUrl, { includeDemoData: false });
    const assignments = new Map(
      (
        await db
          .select({ id: schema.agentDefs.id, sandboxProfileId: schema.agentDefs.sandboxProfileId })
          .from(schema.agentDefs)
          .where(
            inArray(
              schema.agentDefs.id,
              fixtures.map((fixture) => fixture.id),
            ),
          )
      ).map((agent) => [agent.id, agent.sandboxProfileId]),
    );
    expect(assignments.get(fixtures[0]?.id ?? "")).toBe(analysisSandboxProfileId(orgA));
    expect(assignments.get(fixtures[1]?.id ?? "")).toBe(customProfileId);
    expect(assignments.get(fixtures[2]?.id ?? "")).toBeNull();
    expect(assignments.get(fixtures[3]?.id ?? "")).toBe(builderSandboxProfileId(orgA));
    expect(assignments.get(fixtures[4]?.id ?? "")).toBe(analysisSandboxProfileId(orgB));
    expect(assignments.get(fixtures[4]?.id ?? "")).not.toBe(defaultSandboxProfileId(orgA));

    await db
      .update(schema.agentDefs)
      .set({ sandboxProfileId: defaultSandboxProfileId(orgA), updatedAt: new Date() })
      .where(eq(schema.agentDefs.id, fixtures[0]?.id ?? ""));
    await seed(databaseUrl, { includeDemoData: false });
    expect(
      (
        await db
          .select({ sandboxProfileId: schema.agentDefs.sandboxProfileId })
          .from(schema.agentDefs)
          .where(eq(schema.agentDefs.id, fixtures[0]?.id ?? ""))
          .limit(1)
      )[0]?.sandboxProfileId,
    ).toBe(defaultSandboxProfileId(orgA));
  });

  it("allows only one plan-acceptance builder run per architect plan under a race", async () => {
    const orgId = newId("org");
    const projectId = newId("proj");
    const architectRunId = newId("run");
    await db.insert(schema.orgs).values({
      id: orgId,
      name: "Plan Dispatch Race",
      slug: `plan-dispatch-race-${orgId}`,
      settings: {},
    });
    await db.insert(schema.projects).values({
      id: projectId,
      orgId,
      name: "Plan Dispatch Race",
      slug: "plan-dispatch-race",
      settings: {},
    });
    const insertRun = (id: string, proposalId: string) =>
      db.insert(schema.runs).values({
        id,
        orgId,
        projectId,
        mode: "builder",
        engine: "codex",
        trigger: { source: "plan_acceptance", proposalId, architectRunId },
        createdBy: { type: "system", id: "test" },
      });
    const attempts = await Promise.allSettled([
      insertRun(newId("run"), newId("prop")),
      insertRun(newId("run"), newId("prop")),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.runs)
        .where(sql`${schema.runs.trigger} @> ${JSON.stringify({ architectRunId })}::jsonb`),
    ).toHaveLength(1);
  });

  it("applies metering precision and index migrations in order", async () => {
    const columns = (await db.execute(
      sql`
        SELECT table_name, column_name, data_type
        FROM information_schema.columns
        WHERE (table_name = 'llm_requests' AND column_name IN ('task_id', 'agent_def_id', 'priced', 'cost_cents'))
           OR (table_name = 'spend_counters' AND column_name = 'spent_cents')
           OR (table_name = 'analytics_daily' AND column_name IN ('cost_cents', 'outcomes_assessed', 'outcomes_accepted'))
           OR (table_name = 'provider_credentials' AND column_name = 'auth_mode')
           OR (table_name = 'projects' AND column_name = 'builder_plan_policy')
           OR (table_name = 'runs' AND column_name = 'workspace_base_sha')
           OR (table_name = 'run_deliveries' AND column_name = 'base_sha')
      `,
    )) as Iterable<{ table_name: string; column_name: string; data_type: string }>;
    const columnTypes = new Map(
      Array.from(columns).map((row) => [`${row.table_name}.${row.column_name}`, row.data_type]),
    );
    expect(columnTypes.get("llm_requests.task_id")).toBe("text");
    expect(columnTypes.get("llm_requests.agent_def_id")).toBe("text");
    expect(columnTypes.get("llm_requests.priced")).toBe("boolean");
    expect(columnTypes.get("llm_requests.cost_cents")).toBe("numeric");
    expect(columnTypes.get("spend_counters.spent_cents")).toBe("numeric");
    expect(columnTypes.get("analytics_daily.cost_cents")).toBe("numeric");
    expect(columnTypes.get("analytics_daily.outcomes_assessed")).toBe("integer");
    expect(columnTypes.get("analytics_daily.outcomes_accepted")).toBe("integer");
    expect(columnTypes.get("provider_credentials.auth_mode")).toBe("text");
    expect(columnTypes.get("projects.builder_plan_policy")).toBe("text");
    expect(columnTypes.get("runs.workspace_base_sha")).toBe("text");
    expect(columnTypes.get("run_deliveries.base_sha")).toBe("text");
    const indexes = (await db.execute(
      sql`
        SELECT indexname
        FROM pg_indexes
        WHERE indexname IN (
          'llm_requests_org_created_group_idx',
          'llm_requests_org_project_created_group_idx',
          'runs_org_queued_idx',
          'runs_org_project_queued_idx',
          'runs_org_status_queued_idx',
          'runs_org_project_status_queued_idx',
          'audit_events_org_seq_idx',
          'registry_versions_org_item_version_idx',
          'sandbox_profiles_org_created_idx',
          'runs_created_idx',
          'llm_requests_created_idx',
          'outcomes_terminal_idx',
          'llm_requests_run_idx',
          'api_keys_run_live_idx',
          'virtual_keys_run_live_idx',
          'registry_versions_one_active_uidx',
          'runs_plan_acceptance_proposal_uidx',
          'runs_plan_acceptance_architect_run_uidx',
          'webhook_deliveries_pending_idx',
          'webhook_deliveries_org_created_idx',
          'idempotency_records_expiry_idx',
          'gh_pull_requests_repo_number_uidx',
          'gh_pull_requests_org_project_state_idx',
          'gh_pull_requests_repo_head_sha_idx',
          'gh_pull_requests_closing_issues_idx',
          'gh_ci_events_repo_pull_observed_idx',
          'gh_ci_events_org_project_observed_idx',
          'gh_ci_events_source_pull_uidx'
        )
      `,
    )) as Iterable<{ indexname: string }>;
    expect(new Set(Array.from(indexes).map((row) => row.indexname))).toEqual(
      new Set([
        "llm_requests_org_created_group_idx",
        "llm_requests_org_project_created_group_idx",
        "runs_org_queued_idx",
        "runs_org_project_queued_idx",
        "runs_org_status_queued_idx",
        "runs_org_project_status_queued_idx",
        "audit_events_org_seq_idx",
        "registry_versions_org_item_version_idx",
        "sandbox_profiles_org_created_idx",
        // Analytics rollup trailing-window indexes (migration 0008).
        "runs_created_idx",
        "llm_requests_created_idx",
        "outcomes_terminal_idx",
        // Run-finalization aggregate by run_id (migration 0009).
        "llm_requests_run_idx",
        // Orphaned run-scoped-key sweep partial live-key indexes (migration 0010).
        "api_keys_run_live_idx",
        "virtual_keys_run_live_idx",
        // One-active-version-per-item guard (migration 0011).
        "registry_versions_one_active_uidx",
        // Plan-acceptance retries cannot create duplicate builder runs (migration 0019).
        "runs_plan_acceptance_proposal_uidx",
        // Duplicate proposals for one architect plan cannot double-dispatch (migration 0020).
        "runs_plan_acceptance_architect_run_uidx",
        // Durable integration outbox and API replay records (migrations 0021-0022).
        "webhook_deliveries_pending_idx",
        "webhook_deliveries_org_created_idx",
        "idempotency_records_expiry_idx",
        // First-class GitHub PR mirror (migration 0029).
        "gh_pull_requests_repo_number_uidx",
        "gh_pull_requests_org_project_state_idx",
        "gh_pull_requests_repo_head_sha_idx",
        "gh_pull_requests_closing_issues_idx",
        // Append-only CI rollup transitions for story timelines (migration 0041).
        "gh_ci_events_repo_pull_observed_idx",
        "gh_ci_events_org_project_observed_idx",
        "gh_ci_events_source_pull_uidx",
      ]),
    );
    const pullRequestChecks = (await db.execute(
      sql`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'gh_pull_requests'::regclass
          AND conname IN (
            'gh_pull_requests_state_check',
            'gh_pull_requests_ci_state_check',
            'gh_pull_requests_repo_number_uidx'
          )
      `,
    )) as Iterable<{ conname: string }>;
    expect(new Set(Array.from(pullRequestChecks).map((row) => row.conname))).toEqual(
      new Set([
        "gh_pull_requests_state_check",
        "gh_pull_requests_ci_state_check",
        "gh_pull_requests_repo_number_uidx",
      ]),
    );
    const ciEventChecks = (await db.execute(
      sql`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'gh_ci_events'::regclass
          AND conname = 'gh_ci_events_state_check'
      `,
    )) as Iterable<{ conname: string }>;
    expect(Array.from(ciEventChecks).map((row) => row.conname)).toEqual([
      "gh_ci_events_state_check",
    ]);
    const projectChecks = (await db.execute(
      sql`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'projects'::regclass
          AND conname = 'projects_builder_plan_policy_check'
      `,
    )) as Iterable<{ conname: string }>;
    expect(Array.from(projectChecks).map((row) => row.conname)).toEqual([
      "projects_builder_plan_policy_check",
    ]);
    const applied = (await db.execute(
      sql`
        SELECT name
        FROM _facility_migrations
        ORDER BY name
      `,
    )) as Iterable<{ name: string }>;
    // A developer database can include later migrations from another worktree;
    // assert this checkout's latest migration was applied without assuming it
    // is the newest row in that shared database.
    expect(Array.from(applied).map((row) => row.name)).toContain("0043_builder_plan_policy.sql");
    expect(Array.from(applied).map((row) => row.name)).toContain(
      "0042_run_base_sha_provenance.sql",
    );
    const providerCredentialChecks = (await db.execute(
      sql`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'provider_credentials'::regclass
          AND conname IN (
            'provider_credentials_auth_mode_check',
            'provider_credentials_oauth_provider_check'
          )
      `,
    )) as Iterable<{ conname: string }>;
    expect(new Set(Array.from(providerCredentialChecks).map((row) => row.conname))).toEqual(
      new Set([
        "provider_credentials_auth_mode_check",
        "provider_credentials_oauth_provider_check",
      ]),
    );
    const previewDriverConstraint = (await db.execute(
      sql`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'preview_sandboxes'::regclass
          AND conname = 'preview_sandboxes_driver_check'
      `,
    )) as Iterable<{ definition: string }>;
    expect(Array.from(previewDriverConstraint)[0]?.definition).toContain("vercel");
    const previewRunIndex = (await db.execute(
      sql`
        SELECT indexdef
        FROM pg_indexes
        WHERE tablename = 'preview_sandboxes'
          AND indexname = 'preview_sandboxes_run_uidx'
      `,
    )) as Iterable<{ indexdef: string }>;
    const previewRunIndexDefinition = Array.from(previewRunIndex)[0]?.indexdef ?? "";
    expect(previewRunIndexDefinition).toContain("status");
    expect(previewRunIndexDefinition).toContain("provisioning");
    expect(previewRunIndexDefinition).toContain("running");
    expect(previewRunIndexDefinition).not.toContain("failed");
    const invalidOutcomeRollups = (await db.execute(
      sql`
        SELECT count(*)::int AS count
        FROM analytics_daily
        WHERE outcomes_one_shot > outcomes_merged
           OR outcomes_accepted > outcomes_assessed
      `,
    )) as Iterable<{ count: number }>;
    expect(Array.from(invalidOutcomeRollups)[0]?.count).toBe(0);

    const schedulerTable = (await db.execute(
      sql`SELECT to_regclass('scheduler_watermarks') AS name`,
    )) as Iterable<{ name: string | null }>;
    expect(Array.from(schedulerTable)[0]?.name).toBe("scheduler_watermarks");
    const schedulerColumns = (await db.execute(
      sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'scheduler_watermarks'
          AND column_name IN ('cursor', 'scan_started_at')
      `,
    )) as Iterable<{ column_name: string }>;
    expect(new Set(Array.from(schedulerColumns).map((row) => row.column_name))).toEqual(
      new Set(["cursor", "scan_started_at"]),
    );

    // Budget enum/limit + scope-coherence CHECK constraints backstop every write
    // path (migrations 0013 + 0014).
    const budgetChecks = (await db.execute(
      sql`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'budgets'::regclass AND contype = 'c'
      `,
    )) as Iterable<{ conname: string }>;
    expect(new Set(Array.from(budgetChecks).map((row) => row.conname))).toEqual(
      new Set([
        "budgets_scope_check",
        "budgets_period_check",
        "budgets_mode_check",
        "budgets_limit_cents_check",
        "budgets_scope_coherence_check",
      ]),
    );

    const interactiveChecks = (await db.execute(
      sql`
        SELECT conname
        FROM pg_constraint
        WHERE conname in (
          'steer_messages_kind_check',
          'conversations_status_check',
          'conversation_messages_role_check',
          'conversation_messages_seq_positive_check'
        )
      `,
    )) as Iterable<{ conname: string }>;
    expect(new Set(Array.from(interactiveChecks).map((row) => row.conname))).toEqual(
      new Set([
        "steer_messages_kind_check",
        "conversations_status_check",
        "conversation_messages_role_check",
        "conversation_messages_seq_positive_check",
      ]),
    );
  });
});
