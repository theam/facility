import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDb,
  LegacyDatabaseError,
  MigrationChecksumError,
  MigrationExecutionError,
  migrate,
  seed,
} from "../src/index.js";
import * as schema from "../src/schema.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";

describe("Facility 0.12 database", () => {
  const { db, client } = createDb(databaseUrl);

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: false });
  });

  afterAll(async () => client.end());

  it("installs only the 0.12 control-plane and persistent-workspace tables", async () => {
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const rows = await sql<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
      `;
      const names = rows.map((row) => row.tablename);
      expect(names).toEqual(
        expect.arrayContaining([
          "agent_manifests",
          "agent_schedules",
          "github_webhook_events",
          "preview_sessions",
          "project_repositories",
          "stories",
          "story_conversations",
          "story_messages",
          "turn_events",
          "turns",
          "workspace_events",
          "workspaces",
        ]),
      );
      expect(names).not.toEqual(
        expect.arrayContaining([
          "runs",
          "run_events",
          "proposals",
          "receipts",
          "budgets",
          "registry_items",
          "preview_sandboxes",
          "inbound_events",
        ]),
      );
    } finally {
      await sql.end();
    }
  });

  it("refuses a 0.11 database before creating migration metadata", async () => {
    const schemaName = `legacy_${randomUUID().replaceAll("-", "_")}`;
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
      await sql.unsafe(`SET search_path TO "${schemaName}"`);
      await sql`CREATE TABLE runs (id text PRIMARY KEY)`;
      await sql`INSERT INTO runs (id) VALUES ('legacy-run')`;
      const before = await sql<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = ${schemaName} ORDER BY tablename
      `;
      await expect(
        applyMigrations(sql, { migrationsDir: join(tmpdir(), "unused") }),
      ).rejects.toBeInstanceOf(LegacyDatabaseError);
      const metadata = await sql<{ value: string | null }[]>`
        SELECT to_regclass('_facility_migrations')::text AS value
      `;
      expect(metadata[0]?.value).toBeNull();
      const after = await sql<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = ${schemaName} ORDER BY tablename
      `;
      expect(after).toEqual(before);
      await expect(sql`SELECT id FROM runs`).resolves.toEqual([{ id: "legacy-run" }]);
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await sql.end();
    }
  });

  it("keeps migration checksums immutable and failed migrations atomic", async () => {
    const migrationsDir = await mkdtemp(join(tmpdir(), "facility-012-migrations-"));
    const schemaName = `migration_${randomUUID().replaceAll("-", "_")}`;
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
      await sql.unsafe(`SET search_path TO "${schemaName}"`);
      await writeFile(join(migrationsDir, "0001_first.sql"), "CREATE TABLE first (id text);\n");
      await applyMigrations(sql, { migrationsDir, log: () => undefined });
      await writeFile(join(migrationsDir, "0001_first.sql"), "CREATE TABLE first (id text);\n\n");
      await expect(
        applyMigrations(sql, { migrationsDir, log: () => undefined }),
      ).rejects.toBeInstanceOf(MigrationChecksumError);

      await writeFile(join(migrationsDir, "0001_first.sql"), "CREATE TABLE first (id text);\n");
      await writeFile(
        join(migrationsDir, "0002_bad.sql"),
        "CREATE TABLE rolled_back (id text); SELECT * FROM missing_table;\n",
      );
      await expect(
        applyMigrations(sql, { migrationsDir, log: () => undefined }),
      ).rejects.toBeInstanceOf(MigrationExecutionError);
      const result = await sql<{ tableName: string | null; ledger: number }[]>`
        SELECT
          to_regclass('rolled_back')::text AS "tableName",
          (SELECT count(*)::int FROM _facility_migrations WHERE name = '0002_bad.sql') AS ledger
      `;
      expect(result[0]).toEqual({ tableName: null, ledger: 0 });
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await sql.end();
      await rm(migrationsDir, { recursive: true, force: true });
    }
  });

  it("rejects cross-organization repository, event, artifact, and preview references", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const orgA = `org_a_${suffix}`;
    const orgB = `org_b_${suffix}`;
    const projectA = `proj_a_${suffix}`;
    const projectB = `proj_b_${suffix}`;
    const userA = `user_a_${suffix}`;
    const userB = `user_b_${suffix}`;
    const installationA = `int_a_${suffix}`;
    const installationB = `int_b_${suffix}`;
    const installationNumber = Number.parseInt(suffix.slice(0, 10), 16);
    await db.insert(schema.orgs).values([
      { id: orgA, name: "A", slug: `a-${suffix}`, settings: {} },
      { id: orgB, name: "B", slug: `b-${suffix}`, settings: {} },
    ]);
    await db.insert(schema.projects).values([
      { id: projectA, orgId: orgA, name: "A", slug: "project", settings: {} },
      { id: projectB, orgId: orgB, name: "B", slug: "project", settings: {} },
    ]);
    await db.insert(schema.users).values([
      { id: userA, email: `${suffix}-a@example.test` },
      { id: userB, email: `${suffix}-b@example.test` },
    ]);
    await db.insert(schema.orgMembers).values([
      { id: `member_a_${suffix}`, orgId: orgA, userId: userA, roleId: "role_bundled_owner" },
      { id: `member_b_${suffix}`, orgId: orgB, userId: userB, roleId: "role_bundled_owner" },
    ]);
    await db.insert(schema.githubInstallations).values([
      {
        id: installationA,
        orgId: orgA,
        installationId: installationNumber,
        accountId: 1,
        accountLogin: "a",
        targetType: "Organization",
      },
      {
        id: installationB,
        orgId: orgB,
        installationId: installationNumber + 1,
        accountId: 2,
        accountLogin: "b",
        targetType: "Organization",
      },
    ]);

    await expect(
      db.insert(schema.projectRepositories).values({
        id: `repo_${suffix}`,
        orgId: orgA,
        projectId: projectA,
        installationId: installationB,
        owner: "a",
        name: "repo",
        defaultBranch: "main",
        role: "primary",
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    const storyId = `story_${suffix}`;
    const workspaceId = `ws_${suffix}`;
    const conversationId = `conv_${suffix}`;
    await db.insert(schema.stories).values({
      id: storyId,
      orgId: orgA,
      projectId: projectA,
      provider: "manual",
      externalId: suffix,
      title: "Scoped story",
      createdBy: { type: "user", id: userA },
    });
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      orgId: orgA,
      projectId: projectA,
      storyId,
      provider: "fake",
      volumeRef: `/tmp/${workspaceId}`,
      state: "running",
    });
    await db.insert(schema.storyConversations).values({
      id: conversationId,
      orgId: orgA,
      projectId: projectA,
      storyId,
    });
    const turnId = `turn_${suffix}`;
    await db.insert(schema.turns).values({
      id: turnId,
      orgId: orgA,
      projectId: projectA,
      storyId,
      conversationId,
      agentName: "builder",
      manifestHash: suffix,
      manifest: {},
      engine: "codex",
      model: "gpt-test",
      triggerType: "manual",
      createdBy: { type: "user", id: userA },
    });

    await expect(
      db.insert(schema.workspaceEvents).values({
        orgId: orgB,
        workspaceId,
        seq: 1,
        type: "forged",
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(
      db.insert(schema.storyArtifacts).values({
        id: `artifact_${suffix}`,
        orgId: orgB,
        projectId: projectB,
        storyId,
        turnId,
        kind: "log",
        label: "forged",
        uri: "memory://forged",
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(
      db.insert(schema.previewSessions).values({
        id: `psess_${suffix}`,
        orgId: orgA,
        projectId: projectA,
        storyId,
        workspaceId,
        userId: userB,
        service: "app",
        tokenHash: suffix,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });
});
