import { hashChain, newId } from "@facility/core";
import { count, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, insertAuditEvent, migrate, seed, withOrg } from "../src/index.js";
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
    await migrate(databaseUrl);
  });

  afterAll(async () => {
    await client.end();
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

  it("seeds idempotently", async () => {
    await seed(databaseUrl);
    const before = (await db.select({ value: count() }).from(schema.registryItems))[0]?.value ?? 0;
    await seed(databaseUrl);
    const after = (await db.select({ value: count() }).from(schema.registryItems))[0]?.value ?? 0;
    expect(after).toBe(before);
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
    expect(seededActionTypes.map((action) => action.name).sort()).toEqual([
      "budget_override",
      "guard_candidate",
      "kb_amendment",
      "kickstart_review",
      "learning_validation",
      "mcp_tool_call",
      "plan_acceptance",
      "rule_proposal",
      "skill_proposal",
      "task_creation",
    ]);
    expect(seededProfiles.map((profile) => profile.name)).toEqual(["Default runner"]);
    expect(seededActionTypes.find((action) => action.name === "plan_acceptance")?.executor).toEqual(
      {
        type: "internal",
        config: {},
      },
    );
    expect(seededProjects).toHaveLength(0);

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
          'runs_plan_acceptance_architect_run_uidx'
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
      ]),
    );
    const applied = (await db.execute(
      sql`
        SELECT name
        FROM _facility_migrations
        ORDER BY name
      `,
    )) as Iterable<{ name: string }>;
    expect(
      Array.from(applied)
        .map((row) => row.name)
        .at(-1),
    ).toBe("0020_plan_acceptance_architect_run_guard.sql");
    const invalidOutcomeRollups = (await db.execute(
      sql`
        SELECT count(*)::int AS count
        FROM analytics_daily
        WHERE outcomes_one_shot > outcomes_merged
           OR outcomes_accepted > outcomes_assessed
      `,
    )) as Iterable<{ count: number }>;
    expect(Array.from(invalidOutcomeRollups)[0]?.count).toBe(0);

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
