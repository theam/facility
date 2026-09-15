import type { FacilityDb } from "@facility/db";
import { stories } from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ApiError } from "../errors.js";

export const INTEGRATION_STATE_MAX_BYTES = 16 * 1024;
export const IntegrationStateBody = z
  .object({
    namespace: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/)
      .refine((key) => !["constructor", "prototype", "__proto__"].includes(key)),
    expected_revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    value: z.record(z.string(), z.json()).nullable(),
  })
  .strict();

export function replaceIntegrationNamespace(
  current: Record<string, unknown>,
  namespace: string,
  value: Record<string, unknown> | null,
) {
  const next = { ...current };
  if (value === null) delete next[namespace];
  else next[namespace] = value;
  if (Buffer.byteLength(JSON.stringify(next), "utf8") > INTEGRATION_STATE_MAX_BYTES) {
    throw new ApiError(
      413,
      "integration_state_too_large",
      "Story integration state is limited to 16 KiB",
    );
  }
  return next;
}

/** No story timestamp/event changes: bookkeeping must not trigger its own consumer. */
export async function updateIntegrationState(
  db: FacilityDb,
  scope: { orgId: string; projectId: string; storyId: string },
  body: z.infer<typeof IntegrationStateBody>,
) {
  return db.transaction(async (tx) => {
    const where = and(
      eq(stories.orgId, scope.orgId),
      eq(stories.projectId, scope.projectId),
      eq(stories.id, scope.storyId),
    );
    const [story] = await tx
      .select({
        integrationState: stories.integrationState,
        integrationStateRevision: stories.integrationStateRevision,
      })
      .from(stories)
      .where(where)
      .for("update")
      .limit(1);
    if (!story) throw new ApiError(404, "not_found", "Story not found");
    if (body.expected_revision !== story.integrationStateRevision) {
      throw new ApiError(
        409,
        "integration_state_revision_conflict",
        "Read current story integration state before retrying",
      );
    }
    const next = replaceIntegrationNamespace(story.integrationState, body.namespace, body.value);
    const [size] = await tx
      .select({ bytes: sql<number>`octet_length(${JSON.stringify(next)}::jsonb::text)` })
      .from(stories)
      .where(where);
    if (!size || size.bytes > INTEGRATION_STATE_MAX_BYTES)
      throw new ApiError(
        413,
        "integration_state_too_large",
        "Story integration state is limited to 16 KiB",
      );
    const revision = story.integrationStateRevision + 1;
    await tx
      .update(stories)
      .set({ integrationState: next, integrationStateRevision: revision })
      .where(where);
    return { namespace: body.namespace, value: next[body.namespace] ?? null, revision };
  });
}
