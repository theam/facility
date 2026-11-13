import { can } from "@facility/core";
import { apiKeys, type FacilityDb, orgMembers, roles, users } from "@facility/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { ApiError } from "../errors.js";

function userAuthorityRows(db: FacilityDb, orgId: string, userIds: string[]) {
  return db
    .select({ userId: users.id, grants: roles.permissions })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .innerJoin(roles, eq(roles.id, orgMembers.roleId))
    .where(
      and(
        eq(orgMembers.orgId, orgId),
        inArray(users.id, userIds),
        eq(users.status, "active"),
        or(isNull(roles.orgId), eq(roles.orgId, orgId)),
      ),
    );
}

/** Snapshot evidence for read-only projections, never authorization for a write.
 * Mutations must still call authorizePrincipal and hold its authority locks. */
export async function observeUserAuthorities(
  db: FacilityDb,
  orgId: string,
  userIds: string[],
  required: readonly string[],
) {
  if (!userIds.length) return new Set<string>();
  const rows = await userAuthorityRows(db, orgId, userIds);
  return new Set(
    rows
      .filter((row) => required.every((permission) => can(row.grants, permission)))
      .map((row) => row.userId),
  );
}

/** Durable jobs re-read current authority; captured permission arrays never authorize an API call. */
export async function authorizePrincipal(
  db: FacilityDb,
  scope: { orgId: string; projectId: string },
  actor: { type: "user" | "key"; id: string },
  required: readonly string[],
  errorCode = "execution_authorization_revoked",
) {
  if (await principalHolds(db, scope, actor, required, true)) return;
  throw revoked(errorCode);
}

/** The same check as authorizePrincipal without its row locks. Snapshot evidence
 * for read-only projections, never authorization for a write. */
export async function observePrincipal(
  db: FacilityDb,
  scope: { orgId: string; projectId: string },
  actor: { type: "user" | "key"; id: string },
  required: readonly string[],
  errorCode = "execution_authorization_revoked",
) {
  if (await principalHolds(db, scope, actor, required, false)) return;
  throw revoked(errorCode);
}

function revoked(errorCode: string) {
  return new ApiError(
    403,
    errorCode,
    "The authorizer no longer has permission to perform this action",
  );
}

async function principalHolds(
  db: FacilityDb,
  scope: { orgId: string; projectId: string },
  actor: { type: "user" | "key"; id: string },
  required: readonly string[],
  lock: boolean,
) {
  if (actor.type === "user") {
    const query = userAuthorityRows(db, scope.orgId, [actor.id]).limit(1);
    const [row] = lock ? await query.for("share") : await query;
    return !!row && required.every((permission) => can(row.grants, permission));
  }
  const query = db
    .select({ key: apiKeys, grants: roles.permissions })
    .from(apiKeys)
    .innerJoin(roles, eq(roles.id, apiKeys.roleId))
    .where(
      and(
        eq(apiKeys.orgId, scope.orgId),
        eq(apiKeys.id, actor.id),
        isNull(apiKeys.revokedAt),
        or(isNull(roles.orgId), eq(roles.orgId, scope.orgId)),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for("share") : await query;
  return (
    !!row &&
    required.every((permission) => can(row.grants, permission)) &&
    ((row.key.scopeType === "project" && row.key.projectId === scope.projectId) ||
      (row.key.scopeType === "org" && row.key.projectId === null))
  );
}

export async function authorizeWorkspaceExecution(
  db: FacilityDb,
  scope: { orgId: string; projectId: string },
  actor: { type: "user" | "key"; id: string },
  errorCode = "workspace_execution_authorization_revoked",
) {
  return authorizePrincipal(db, scope, actor, ["workspaces:execute"], errorCode);
}
