import { apiKeys, auditEvents, type FacilityDb, projectBudgets, projects } from "@facility/db";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

/**
 * Audit-record checks: read the control-plane audit log against the state
 * it narrates, using only what the platform already writes. Read-only;
 * observes and never gates.
 *
 * `audit_events` is an append log ordered by `createdAt` only. It cannot
 * tell a removed event from a quiet hour on its own, so the only way to
 * notice a gap is from the other side: durable state that an audited route
 * must have produced. Where an event names its entity, the two can be read
 * against each other in both directions:
 *
 * - keys: every API key has a `key.issued` event; every revoked key has a
 *   `key.revoked` event; every such event names a key that exists and is in
 *   that state. (`me-members-roles.ts` audits keys with the key id as target.)
 * - projects: an archived project has a `project.archived` event, and that
 *   event names a project that is archived. (The route audits with the
 *   project id as target.)
 * - budgets: a project with a budget has a `budget.updated` event, and that
 *   event names a project that has one.
 *
 * Not evaluable, and not claimed: actions whose target is the route rather
 * than the entity (`member.*`, `role.*`, `repo.*`, `project.created`,
 * `org.updated`), actions that leave no durable state (`auth.logout`,
 * `*.updated` on an unchanged row), and state written by bootstrap paths
 * that do not pass through an audited route (the insecure dev login's
 * default org and membership). A finding is a signal about the log, not a
 * judgement about the actor.
 */

export type AuditRecordCheck = "keys" | "projects" | "budgets";

export type AuditRecordFinding = {
  check: AuditRecordCheck;
  shape: "state-without-event" | "event-without-state";
  action: string;
  targetId: string;
  detail: string;
};

export type AuditRecordReport = {
  checkedKeys: number;
  checkedProjects: number;
  checkedBudgets: number;
  checkedEvents: number;
  findings: AuditRecordFinding[];
};

const PAIRED_ACTIONS = ["key.issued", "key.revoked", "project.archived", "budget.updated"];

const targetId = sql<string>`${auditEvents.target}->>'id'`;

export async function verifyAuditRecord(
  db: FacilityDb,
  input: { orgId: string; pageSize?: number },
): Promise<AuditRecordReport> {
  const pageSize = Math.min(Math.max(input.pageSize ?? 200, 1), 1_000);
  const findings: AuditRecordFinding[] = [];
  const report = { checkedKeys: 0, checkedProjects: 0, checkedBudgets: 0, checkedEvents: 0 };

  // ---- state -> log -------------------------------------------------------
  // keys, keyset-paginated by id
  let cursor: string | undefined;
  do {
    const page = await db
      .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, input.orgId), ...(cursor ? [gt(apiKeys.id, cursor)] : [])))
      .orderBy(asc(apiKeys.id))
      .limit(pageSize);
    if (page.length === 0) break;
    report.checkedKeys += page.length;
    const actionsByKey = await actionsFor(
      db,
      input.orgId,
      ["key.issued", "key.revoked"],
      page.map((key) => key.id),
    );
    for (const key of page) {
      const actions = actionsByKey.get(key.id) ?? new Set<string>();
      if (!actions.has("key.issued")) {
        findings.push({
          check: "keys",
          shape: "state-without-event",
          action: "key.issued",
          targetId: key.id,
          detail: `api key ${key.id} exists but the log has no key.issued for it`,
        });
      }
      if (key.revokedAt && !actions.has("key.revoked")) {
        findings.push({
          check: "keys",
          shape: "state-without-event",
          action: "key.revoked",
          targetId: key.id,
          detail: `api key ${key.id} was revoked at ${key.revokedAt.toISOString()} but the log has no key.revoked`,
        });
      }
    }
    cursor = page.length === pageSize ? page.at(-1)?.id : undefined;
  } while (cursor);

  // projects and budgets: org-scoped and small, read whole
  const orgProjects = await db
    .select({ id: projects.id, status: projects.status })
    .from(projects)
    .where(eq(projects.orgId, input.orgId));
  report.checkedProjects = orgProjects.length;
  const archived = orgProjects.filter((project) => project.status === "archived");
  const archivedEvents = await actionsFor(
    db,
    input.orgId,
    ["project.archived"],
    archived.map((project) => project.id),
  );
  for (const project of archived) {
    if (archivedEvents.get(project.id)?.has("project.archived")) continue;
    findings.push({
      check: "projects",
      shape: "state-without-event",
      action: "project.archived",
      targetId: project.id,
      detail: `project ${project.id} is archived but the log has no project.archived for it`,
    });
  }

  const budgets = await db
    .select({ projectId: projectBudgets.projectId })
    .from(projectBudgets)
    .where(eq(projectBudgets.orgId, input.orgId));
  report.checkedBudgets = budgets.length;
  const budgetEvents = await actionsFor(
    db,
    input.orgId,
    ["budget.updated"],
    budgets.map((budget) => budget.projectId),
  );
  for (const budget of budgets) {
    if (budgetEvents.get(budget.projectId)?.has("budget.updated")) continue;
    findings.push({
      check: "budgets",
      shape: "state-without-event",
      action: "budget.updated",
      targetId: budget.projectId,
      detail: `project ${budget.projectId} has a budget but the log has no budget.updated for it`,
    });
  }

  // ---- log -> state -------------------------------------------------------
  // The reverse pass: every paired event must still name state in the state
  // the event claims. Keyset-paginated over events by id.
  cursor = undefined;
  do {
    const page = await db
      .select({ id: auditEvents.id, action: auditEvents.action, targetId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.orgId, input.orgId),
          inArray(auditEvents.action, PAIRED_ACTIONS),
          ...(cursor ? [gt(auditEvents.id, cursor)] : []),
        ),
      )
      .orderBy(asc(auditEvents.id))
      .limit(pageSize);
    if (page.length === 0) break;
    report.checkedEvents += page.length;

    const keyIds = page.filter((e) => e.action.startsWith("key.")).map((e) => e.targetId);
    const projectIds = page.filter((e) => !e.action.startsWith("key.")).map((e) => e.targetId);
    const [keyRows, projectRows, budgetRows] = await Promise.all([
      keyIds.length === 0
        ? []
        : db
            .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
            .from(apiKeys)
            .where(and(eq(apiKeys.orgId, input.orgId), inArray(apiKeys.id, keyIds))),
      projectIds.length === 0
        ? []
        : db
            .select({ id: projects.id, status: projects.status })
            .from(projects)
            .where(and(eq(projects.orgId, input.orgId), inArray(projects.id, projectIds))),
      projectIds.length === 0
        ? []
        : db
            .select({ projectId: projectBudgets.projectId })
            .from(projectBudgets)
            .where(
              and(
                eq(projectBudgets.orgId, input.orgId),
                inArray(projectBudgets.projectId, projectIds),
              ),
            ),
    ]);
    const keyById = new Map(keyRows.map((row) => [row.id, row]));
    const projectById = new Map(projectRows.map((row) => [row.id, row]));
    const budgeted = new Set(budgetRows.map((row) => row.projectId));

    for (const event of page) {
      const id = event.targetId;
      if (event.action === "key.issued" && !keyById.has(id)) {
        findings.push({
          check: "keys",
          shape: "event-without-state",
          action: event.action,
          targetId: id,
          detail: `log says key.issued for ${id} but no such key exists`,
        });
      } else if (event.action === "key.revoked") {
        const key = keyById.get(id);
        if (!key) {
          findings.push({
            check: "keys",
            shape: "event-without-state",
            action: event.action,
            targetId: id,
            detail: `log says key.revoked for ${id} but no such key exists`,
          });
        } else if (!key.revokedAt) {
          findings.push({
            check: "keys",
            shape: "event-without-state",
            action: event.action,
            targetId: id,
            detail: `log says key.revoked for ${id} but the key is not revoked`,
          });
        }
      } else if (event.action === "project.archived") {
        const project = projectById.get(id);
        if (project?.status !== "archived") {
          findings.push({
            check: "projects",
            shape: "event-without-state",
            action: event.action,
            targetId: id,
            detail: project
              ? `log says project.archived for ${id} but the project is ${project.status}`
              : `log says project.archived for ${id} but no such project exists`,
          });
        }
      } else if (event.action === "budget.updated" && !budgeted.has(id)) {
        findings.push({
          check: "budgets",
          shape: "event-without-state",
          action: event.action,
          targetId: id,
          detail: `log says budget.updated for ${id} but the project has no budget`,
        });
      }
    }
    cursor = page.length === pageSize ? page.at(-1)?.id : undefined;
  } while (cursor);

  return { ...report, findings };
}

/** Which of the given actions the log holds for each target id, in one query per page. */
async function actionsFor(
  db: FacilityDb,
  orgId: string,
  actions: string[],
  targetIds: string[],
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (targetIds.length === 0) return map;
  const rows = await db
    .select({ action: auditEvents.action, targetId })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.orgId, orgId),
        inArray(auditEvents.action, actions),
        inArray(targetId, targetIds),
      ),
    );
  for (const row of rows) {
    const set = map.get(row.targetId) ?? new Set<string>();
    set.add(row.action);
    map.set(row.targetId, set);
  }
  return map;
}
