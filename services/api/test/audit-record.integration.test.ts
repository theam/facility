import { randomUUID } from "node:crypto";
import { newId } from "@facility/core";
import {
  apiKeys,
  auditEvents,
  createDb,
  migrate,
  orgs,
  projectBudgets,
  projects,
} from "@facility/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditRecord } from "../src/insights/audit-record.js";

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

describe("audit-record checks", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; audit-record tests skipped", () => undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org");
  const otherOrgId = newId("org");

  // keys
  const cleanKeyId = newId("key"); // issued, event present
  const unloggedKeyId = newId("key"); // issued, no event at all
  const revokedCleanKeyId = newId("key"); // revoked, both events present
  const revokedUnloggedKeyId = newId("key"); // revoked, only key.issued logged
  const ghostKeyId = newId("key"); // key.issued in the log, row gone
  const notRevokedKeyId = newId("key"); // key.revoked in the log, key still active
  const otherOrgKeyId = newId("key");

  // projects
  const activeProjectId = newId("proj");
  const archivedCleanProjectId = newId("proj");
  const archivedUnloggedProjectId = newId("proj");
  const archivedEventActiveProjectId = newId("proj"); // log says archived, project is active
  const budgetCleanProjectId = newId("proj");
  const budgetUnloggedProjectId = newId("proj");
  const budgetEventNoBudgetProjectId = newId("proj");
  const otherOrgProjectId = newId("proj");

  function keyRow(id: string, org: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      orgId: org,
      name: `key-${id.slice(-6)}`,
      prefix: `fak_${id.slice(-8)}`,
      last4: id.slice(-4),
      hash: `hash-${id}`,
      scopeType: "org",
      roleId: "role_bundled_viewer",
      ...overrides,
    };
  }

  function event(org: string, action: string, target: { type: string; id: string }) {
    return {
      id: newId("evt"),
      orgId: org,
      actor: { type: "user", id: "maintainer" },
      action,
      target,
    };
  }

  function projectRow(id: string, org: string, status = "active") {
    return { id, orgId: org, name: id, slug: `${id.slice(-8)}-${suffix}`, settings: {}, status };
  }

  beforeAll(async () => {
    await migrate(databaseUrl);
    await db.insert(orgs).values([
      { id: orgId, name: "Audit", slug: `audit-${suffix}`, settings: {} },
      { id: otherOrgId, name: "OtherAudit", slug: `other-audit-${suffix}`, settings: {} },
    ]);
    await db
      .insert(projects)
      .values([
        projectRow(activeProjectId, orgId),
        projectRow(archivedCleanProjectId, orgId, "archived"),
        projectRow(archivedUnloggedProjectId, orgId, "archived"),
        projectRow(archivedEventActiveProjectId, orgId),
        projectRow(budgetCleanProjectId, orgId),
        projectRow(budgetUnloggedProjectId, orgId),
        projectRow(budgetEventNoBudgetProjectId, orgId),
        projectRow(otherOrgProjectId, otherOrgId),
      ]);
    const revokedAt = new Date("2026-09-06T12:00:00Z");
    await db.insert(apiKeys).values([
      keyRow(cleanKeyId, orgId),
      keyRow(unloggedKeyId, orgId),
      keyRow(revokedCleanKeyId, orgId, { revokedAt }),
      keyRow(revokedUnloggedKeyId, orgId, { revokedAt }),
      keyRow(notRevokedKeyId, orgId),
      keyRow(otherOrgKeyId, otherOrgId),
      // ghostKeyId deliberately has NO row: only its events survive
    ]);
    await db.insert(projectBudgets).values([
      {
        id: newId("bud"),
        orgId,
        projectId: budgetCleanProjectId,
        monthlyLimitCents: 100,
        warningPercent: 50,
        enabled: true,
      },
      {
        id: newId("bud"),
        orgId,
        projectId: budgetUnloggedProjectId,
        monthlyLimitCents: 100,
        warningPercent: 50,
        enabled: true,
      },
    ]);
    await db.insert(auditEvents).values([
      event(orgId, "key.issued", { type: "key", id: cleanKeyId }),
      event(orgId, "key.issued", { type: "key", id: revokedCleanKeyId }),
      event(orgId, "key.revoked", { type: "key", id: revokedCleanKeyId }),
      event(orgId, "key.issued", { type: "key", id: revokedUnloggedKeyId }),
      event(orgId, "key.issued", { type: "key", id: ghostKeyId }),
      event(orgId, "key.issued", { type: "key", id: notRevokedKeyId }),
      event(orgId, "key.revoked", { type: "key", id: notRevokedKeyId }),
      event(orgId, "project.archived", { type: "project", id: archivedCleanProjectId }),
      event(orgId, "project.archived", { type: "project", id: archivedEventActiveProjectId }),
      event(orgId, "budget.updated", { type: "project", id: budgetCleanProjectId }),
      event(orgId, "budget.updated", { type: "project", id: budgetEventNoBudgetProjectId }),
      // the other org's key and its event live in the other org
      event(otherOrgId, "key.issued", { type: "key", id: otherOrgKeyId }),
      // an unpaired action is not the log's job to reconcile
      event(orgId, "auth.logout", { type: "user", id: "maintainer" }),
    ]);
  });

  afterAll(async () => {
    await client.end();
  });

  const find = (findings: Awaited<ReturnType<typeof verifyAuditRecord>>["findings"], id: string) =>
    findings.filter((finding) => finding.targetId === id);

  it("counts what it read and stays silent on clean pairs", async () => {
    const report = await verifyAuditRecord(db, { orgId });
    expect(report).toMatchObject({ checkedKeys: 5, checkedProjects: 7, checkedBudgets: 2 });
    expect(report.checkedEvents).toBe(11); // the auth.logout is not a paired action
    expect(find(report.findings, cleanKeyId)).toEqual([]);
    expect(find(report.findings, revokedCleanKeyId)).toEqual([]);
    expect(find(report.findings, archivedCleanProjectId)).toEqual([]);
    expect(find(report.findings, budgetCleanProjectId)).toEqual([]);
    expect(find(report.findings, activeProjectId)).toEqual([]);
  });

  it("finds a key the log never saw issued", async () => {
    const report = await verifyAuditRecord(db, { orgId });
    expect(find(report.findings, unloggedKeyId)).toMatchObject([
      { check: "keys", shape: "state-without-event", action: "key.issued" },
    ]);
  });

  it("finds a revocation the log never recorded", async () => {
    const report = await verifyAuditRecord(db, { orgId });
    expect(find(report.findings, revokedUnloggedKeyId)).toMatchObject([
      { check: "keys", shape: "state-without-event", action: "key.revoked" },
    ]);
  });

  it("finds an issued-key event whose key row is gone", async () => {
    const report = await verifyAuditRecord(db, { orgId });
    expect(find(report.findings, ghostKeyId)).toMatchObject([
      { check: "keys", shape: "event-without-state", action: "key.issued" },
    ]);
  });

  it("finds a revocation the log claims that the key does not show", async () => {
    const report = await verifyAuditRecord(db, { orgId });
    expect(find(report.findings, notRevokedKeyId)).toMatchObject([
      { check: "keys", shape: "event-without-state", action: "key.revoked" },
    ]);
  });

  it("finds an archived project the log never saw archived, and the reverse", async () => {
    const report = await verifyAuditRecord(db, { orgId });
    expect(find(report.findings, archivedUnloggedProjectId)).toMatchObject([
      { check: "projects", shape: "state-without-event", action: "project.archived" },
    ]);
    const reverse = find(report.findings, archivedEventActiveProjectId);
    expect(reverse).toMatchObject([
      { check: "projects", shape: "event-without-state", action: "project.archived" },
    ]);
    expect(reverse[0]?.detail).toContain("the project is active");
  });

  it("finds a budget the log never saw set, and the reverse", async () => {
    const report = await verifyAuditRecord(db, { orgId });
    expect(find(report.findings, budgetUnloggedProjectId)).toMatchObject([
      { check: "budgets", shape: "state-without-event", action: "budget.updated" },
    ]);
    expect(find(report.findings, budgetEventNoBudgetProjectId)).toMatchObject([
      { check: "budgets", shape: "event-without-state", action: "budget.updated" },
    ]);
  });

  it("reports the same findings whatever the page size", async () => {
    const whole = await verifyAuditRecord(db, { orgId });
    const paged = await verifyAuditRecord(db, { orgId, pageSize: 2 });
    const key = (f: (typeof whole.findings)[number]) =>
      `${f.check}|${f.shape}|${f.action}|${f.targetId}`;
    expect(paged.findings.map(key).sort()).toEqual(whole.findings.map(key).sort());
    expect(paged.checkedEvents).toBe(whole.checkedEvents);
    // 4 key + 2 project + 2 budget findings
    expect(whole.findings).toHaveLength(8);
  });

  it("a deleted key row is visible from the log that still expects it", async () => {
    // The reverse pass, on the only thing that survives a deletion: the event.
    await db.delete(apiKeys).where(eq(apiKeys.id, cleanKeyId));
    const report = await verifyAuditRecord(db, { orgId });
    expect(find(report.findings, cleanKeyId)).toMatchObject([
      { check: "keys", shape: "event-without-state", action: "key.issued" },
    ]);
    expect(report.checkedKeys).toBe(4);
  });

  it("never inspects another org's log or state", async () => {
    const report = await verifyAuditRecord(db, { orgId: otherOrgId });
    expect(report).toMatchObject({ checkedKeys: 1, checkedProjects: 1, checkedBudgets: 0 });
    expect(report.checkedEvents).toBe(1);
    expect(report.findings).toEqual([]);
  });
});
