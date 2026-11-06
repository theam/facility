import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { expect, it } from "vitest";
import { applyMigrations } from "../src/migrate.js";

it("backfills known completeness conservatively without repricing old bills and preserves receipt constraints", async () => {
  const db = postgres(
    process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test",
    { max: 1, onnotice: () => {} },
  );
  const schema = `certainty_${randomUUID().replaceAll("-", "")}`;
  const temp = await mkdtemp(join(tmpdir(), "usage-certainty-migrations-"));
  const source = fileURLToPath(new URL("../migrations/v0.12/", import.meta.url));
  try {
    await db.unsafe(`create schema "${schema}"`);
    await db.unsafe(`set search_path to "${schema}"`);
    for (const name of await readdir(source))
      if (name.endsWith(".sql") && name !== "0020_usage_certainty.sql")
        await cp(join(source, name), join(temp, name));
    await applyMigrations(db, { migrationsDir: temp, log: () => {} });
    await db`insert into orgs(id,name,slug) values('o','test','test')`;
    await db`insert into projects(id,org_id,name,slug) values('p','o','test','test')`;
    await db`insert into stories(id,org_id,project_id,provider,external_id,title,created_by) values('s','o','p','manual','s','test','{}')`;
    await db`insert into story_conversations(id,org_id,project_id,story_id) values('c','o','p','s')`;
    for (const [id, status, priced] of [
      ["known", "failed", true],
      ["complete", "succeeded", false],
      ["unknown", "failed", false],
    ] as const) {
      await db`insert into turns(id,org_id,project_id,story_id,conversation_id,agent_name,manifest_hash,manifest,engine,model,state,trigger_type,created_by) values(${id},'o','p','s','c','builder','h','{}','codex','custom',${status},'manual','{}')`;
      await db`insert into turn_usage(id,org_id,project_id,story_id,turn_id,agent_name,engine,model,priced,cost_cents,source,status) values(${id},'o','p','s',${id},'builder','codex','custom',${priced},${priced ? 1 : null},${priced ? "provider" : "unpriced"},${status})`;
    }
    const oldBills =
      await db`select id,cost_cents,priced,source,status,created_at from turn_usage order by id`;
    const oldLedger =
      await db`select name,checksum,applied_at from _facility_migrations order by name`;
    await applyMigrations(db, { migrationsDir: source, log: () => {} });
    expect(
      await db`select id,cost_cents,priced,source,status,created_at from turn_usage order by id`,
    ).toEqual(oldBills);
    expect(
      await db`select name,checksum,applied_at from _facility_migrations where name <> '0020_usage_certainty.sql' order by name`,
    ).toEqual(oldLedger);
    expect(
      await db`select id,usage_complete,priced,cost_cents,settlement_reference from turn_usage order by id`,
    ).toEqual([
      {
        id: "complete",
        usage_complete: true,
        priced: false,
        cost_cents: null,
        settlement_reference: null,
      },
      {
        id: "known",
        usage_complete: true,
        priced: true,
        cost_cents: "1",
        settlement_reference: null,
      },
      {
        id: "unknown",
        usage_complete: false,
        priced: false,
        cost_cents: null,
        settlement_reference: null,
      },
    ]);
    await expect(
      db`update turn_usage set source='manual',priced=true where id='unknown'`,
    ).rejects.toMatchObject({ code: "23514" });
    const again = await applyMigrations(db, { migrationsDir: source, log: () => {} });
    expect(again.applied).toEqual([]);
  } finally {
    await db.unsafe(`drop schema if exists "${schema}" cascade`);
    await db.end();
    await rm(temp, { recursive: true, force: true });
  }
});
