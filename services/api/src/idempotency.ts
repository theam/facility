import { createHash } from "node:crypto";
import { type FacilityDb, idempotencyRecords } from "@facility/db";
import { and, eq, lt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const IDEMPOTENCY_PENDING_TIMEOUT_MS = 15 * 60_000;

export async function beginIdempotentRequest(
  db: FacilityDb,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  // Every authenticated mutation may opt into replay safety simply by sending
  // the header. Public webhook/internal routes have no permission declaration
  // and retain their own delivery-specific replay rules.
  if (
    !["POST", "PATCH", "PUT", "DELETE"].includes(request.method) ||
    !request.routeOptions.config?.permission
  ) {
    return;
  }
  const rawKey = request.headers["idempotency-key"];
  const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  if (key === undefined) return;
  if (typeof key !== "string" || key.length < 8 || key.length > 200) {
    throw new ApiError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must contain between 8 and 200 characters",
    );
  }
  const principal = request.principal;
  if (!principal) throw new ApiError(401, "unauthorized", "Authentication required");
  const path = request.url.split("?")[0] ?? request.url;
  const keyHash = sha256(key);
  const requestHash = sha256(stableJson(request.body));
  const id = `idem_${sha256(
    `${principal.orgId}:${principal.type}:${principal.id}:${request.method}:${path}:${keyHash}`,
  )}`;
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS);
  const inserted = await db
    .insert(idempotencyRecords)
    .values({
      id,
      orgId: principal.orgId,
      principalId: `${principal.type}:${principal.id}`,
      method: request.method,
      path,
      keyHash,
      requestHash,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: idempotencyRecords.id });
  if (inserted.length > 0) {
    request.idempotencyId = id;
    reply.header("idempotency-status", "created");
    return;
  }
  const existing = (
    await db
      .select()
      .from(idempotencyRecords)
      .where(and(eq(idempotencyRecords.id, id), eq(idempotencyRecords.orgId, principal.orgId)))
      .limit(1)
  )[0];
  if (!existing) {
    throw new ApiError(409, "idempotency_conflict", "Idempotency request conflicted");
  }
  if (existing.expiresAt <= new Date()) {
    await db.delete(idempotencyRecords).where(eq(idempotencyRecords.id, id));
    return beginIdempotentRequest(db, request, reply);
  }
  if (existing.requestHash !== requestHash) {
    throw new ApiError(
      409,
      "idempotency_key_reused",
      "Idempotency-Key was already used with a different request body",
    );
  }
  if (existing.state !== "completed" || existing.statusCode === null) {
    const staleBefore = new Date(Date.now() - IDEMPOTENCY_PENDING_TIMEOUT_MS);
    const reclaimed = await db
      .delete(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.id, id),
          eq(idempotencyRecords.orgId, principal.orgId),
          eq(idempotencyRecords.state, "pending"),
          lt(idempotencyRecords.updatedAt, staleBefore),
        ),
      )
      .returning({ id: idempotencyRecords.id });
    if (reclaimed.length > 0) return beginIdempotentRequest(db, request, reply);
    reply.header("retry-after", "1");
    throw new ApiError(
      409,
      "idempotency_in_progress",
      "A request with this Idempotency-Key is still in progress",
    );
  }
  request.idempotencyReplayed = true;
  reply.header("idempotency-status", "replayed");
  // The stored JSON body already passed the route serializer on the original
  // request. Bypass route-level Date serializers here because JSONB restores
  // timestamps as strings, which is exactly what was sent on the wire.
  reply.type("application/json").serializer((value) => JSON.stringify(value));
  return reply.status(existing.statusCode).send(existing.responseBody);
}

export async function completeIdempotentRequest(
  db: FacilityDb,
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
) {
  const id = request.idempotencyId;
  if (!id) return;
  if (reply.statusCode >= 500) {
    await db.delete(idempotencyRecords).where(eq(idempotencyRecords.id, id));
    request.idempotencyId = undefined;
    return;
  }
  const responseBody = parsePayload(payload);
  const completed = await db
    .update(idempotencyRecords)
    .set({
      state: "completed",
      statusCode: reply.statusCode,
      responseBody,
      updatedAt: new Date(),
    })
    .where(and(eq(idempotencyRecords.id, id), eq(idempotencyRecords.state, "pending")))
    .returning({ id: idempotencyRecords.id });
  if (completed.length !== 1) {
    throw new Error(`Idempotency record ${id} could not be completed`);
  }
  request.idempotencyId = undefined;
}

/**
 * A handler committed but its transport disappeared before onSend could
 * persist the actual response. Seal the key as non-replayable rather than
 * deleting/reclaiming an outcome that may already have external side effects.
 */
export async function finalizeIndeterminateIdempotentRequest(
  db: FacilityDb,
  request: FastifyRequest,
) {
  const id = request.idempotencyId;
  if (!id) return;
  const completed = await db
    .update(idempotencyRecords)
    .set({
      state: "completed",
      statusCode: 409,
      responseBody: {
        error: {
          code: "idempotency_outcome_indeterminate",
          message: "The original request may have completed; automatic replay is refused",
        },
      },
      updatedAt: new Date(),
    })
    .where(and(eq(idempotencyRecords.id, id), eq(idempotencyRecords.state, "pending")))
    .returning({ id: idempotencyRecords.id });
  if (completed.length !== 1) {
    throw new Error(`Idempotency record ${id} could not be sealed as indeterminate`);
  }
  request.idempotencyId = undefined;
}

/** Remove a pending replay record when its client disconnected before a response. */
export async function abandonIdempotentRequest(db: FacilityDb, request: FastifyRequest) {
  const id = request.idempotencyId;
  if (!id) return;
  const deleted = await db
    .delete(idempotencyRecords)
    .where(and(eq(idempotencyRecords.id, id), eq(idempotencyRecords.state, "pending")))
    .returning({ id: idempotencyRecords.id });
  if (deleted.length !== 1) {
    throw new Error(`Pending idempotency record ${id} could not be abandoned`);
  }
  request.idempotencyId = undefined;
}

export async function expireIdempotencyRecords(db: FacilityDb, now = new Date()) {
  const rows = await db
    .delete(idempotencyRecords)
    .where(lt(idempotencyRecords.expiresAt, now))
    .returning({ id: idempotencyRecords.id });
  return rows.length;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function parsePayload(payload: unknown) {
  if (Buffer.isBuffer(payload)) return JSON.parse(payload.toString("utf8"));
  if (typeof payload === "string") return payload ? JSON.parse(payload) : null;
  return payload ?? null;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
