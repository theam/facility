import { newId } from "@facility/core";
import { auditEvents, type FacilityDb } from "@facility/db";
import type { FastifyRequest } from "fastify";

export async function writeAuditEvent(
  db: FacilityDb,
  request: FastifyRequest,
  action: string,
  target: { type: string; id?: string },
  payload: Record<string, unknown> = {},
) {
  const principal = request.principal;
  if (!principal) return;
  request.log.info(
    { action, target, payload, actor: { type: principal.type, id: principal.id } },
    "facility access event",
  );
  const projectId = (request.params as Record<string, string | undefined>)?.projectId;
  await db.insert(auditEvents).values({
    id: newId("evt"),
    orgId: principal.orgId,
    projectId,
    actor: { type: principal.type, id: principal.id },
    action,
    target,
    payload,
    requestId: request.id,
  });
}
