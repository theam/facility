/**
 * Regression tests for the review findings on #309. Each fixture is modelled
 * on the writer that produces it:
 *
 * - `request.audit` (app.ts) writes one `key.issued` per issue with the key
 *   id as target (me-members-roles.ts). A thousand identical rows model a
 *   replayed or duplicated log, not the lifecycle — and the reader must not
 *   care which.
 * - The `onResponse` hook (app.ts) writes `project.archived` on any 2xx from
 *   DELETE /v1/projects/:projectId. That route updates by id without checking
 *   a row was hit and answers 200 either way (projects.ts), so an unknown id
 *   leaves an event that names no project.
 * - Bundled roles come from the seed (packages/db/src/seed.ts), never from a
 *   migration.
 */
import { randomUUID } from "node:crypto";
import { newId } from "@facility/core";
import { apiKeys, auditEvents, createDb, migrate, orgs, projects, seed } from "@facility/db";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchingActions, verifyAuditRecord } from "../src/insights/audit-record.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";

async function canConnect() {
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe("audit-record review findings", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; audit-record review tests skipped", () =>
      undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org");
  const busyKeyId = newId("key"); // one key, key.issued repeated 1,002 times
  const quietKeyIds = Array.from({ length: 5 }, () => newId("key")); // one event each
  const archivedProjectId = newId("proj"); // DELETE on an existing project
  const unknownProjectId = newId("proj"); // DELETE on an id that never existed

  function keyRow(id: string) {
    return {
      id,
      orgId,
      name: `key-${id.slice(-6)}`,
      prefix: `fak_${id.slice(-8)}`,
      last4: id.slice(-4),
      hash: `hash-${id}`,
      scopeType: "org",
      roleId: "role_bundled_viewer",
    };
  }

  function event(action: string, target: { type: string; id: string }) {
    return { id: newId("evt"), orgId, actor: { type: "user", id: "maintainer" }, action, target };
  }

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await db
      .insert(orgs)
      .values({ id: orgId, name: "Review", slug: `audit-review-${suffix}`, settings: {} });
    await db.insert(projects).values({
      id: archivedProjectId,
      orgId,
      name: "Archived",
      slug: `archived-${suffix}`,
      settings: {},
      status: "archived",
    });
    await db.insert(apiKeys).values([keyRow(busyKeyId), ...quietKeyIds.map(keyRow)]);
    await db.insert(auditEvents).values([
      ...quietKeyIds.map((id) => event("key.issued", { type: "key", id })),
      // both DELETEs answered 200; the hook audited both
      event("project.archived", { type: "project", id: archivedProjectId }),
      event("project.archived", { type: "project", id: unknownProjectId }),
    ]);
    const busy = Array.from({ length: 1_002 }, () =>
      event("key.issued", { type: "key", id: busyKeyId }),
    );
    for (let index = 0; index < busy.length; index += 200) {
      await db.insert(auditEvents).values(busy.slice(index, index + 200));
    }
  });

  afterAll(async () => {
    await client.end();
  });

  describe("matching-event reads are bounded by the page", () => {
    it("1,002 identical key.issued rows come back as one (action, target) pair", async () => {
      const rows = await matchingActions(db, orgId, ["key.issued", "key.revoked"], [busyKeyId]);
      expect(rows).toEqual([{ action: "key.issued", targetId: busyKeyId }]);
    });

    it("a page of n targets and k actions never loads more than n × k rows", async () => {
      const targets = [busyKeyId, ...quietKeyIds];
      const rows = await matchingActions(db, orgId, ["key.issued", "key.revoked"], targets);
      expect(rows.length).toBeLessThanOrEqual(targets.length * 2);
      expect(rows).toHaveLength(6);
    });

    it("the unbounded shape this replaces loads every duplicate (the red side)", async () => {
      // The query actionsFor ran before the review: no DISTINCT, no cap.
      const rows = await db.execute(sql`
        select ${auditEvents.action} as action
        from ${auditEvents}
        where ${auditEvents.orgId} = ${orgId}
          and ${auditEvents.action} in ('key.issued', 'key.revoked')
          and ${auditEvents.target}->>'id' in (${busyKeyId})
      `);
      expect(rows.length).toBe(1_002);
    });

    it("the report is the same with pageSize 2 and the busy key is clean", async () => {
      const report = await verifyAuditRecord(db, { orgId, pageSize: 2 });
      expect(report.checkedKeys).toBe(6);
      expect(report.findings.filter((f) => f.targetId === busyKeyId)).toEqual([]);
      // the reverse pass still walks every paired event, two at a time
      expect(report.checkedEvents).toBe(1_002 + 5 + 2);
    });
  });

  describe("what the archive route actually writes", () => {
    it("archiving an existing project leaves a pair and no finding", async () => {
      const report = await verifyAuditRecord(db, { orgId });
      expect(report.findings.filter((f) => f.targetId === archivedProjectId)).toEqual([]);
    });

    it("archiving an unknown id leaves an event that names no project, and the report says so", async () => {
      // A signal about the route (it audits an archive it did not perform),
      // reported as event-without-state rather than hidden.
      const report = await verifyAuditRecord(db, { orgId });
      const findings = report.findings.filter((f) => f.targetId === unknownProjectId);
      expect(findings).toMatchObject([
        { check: "projects", shape: "event-without-state", action: "project.archived" },
      ]);
      expect(findings[0]?.detail).toContain("no such project exists");
    });
  });
});
