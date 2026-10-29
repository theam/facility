import { createHash } from "node:crypto";
import { ConsultationTaskStateSchema } from "@facility/core";
import type { FacilityDb } from "@facility/db";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { ConsultationScope } from "./consultation-sources.js";
import { readStoryDelivery } from "./delivery.js";
import { readStoryPlans } from "./plans.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("base64url");
const Stored = z.object({
  data: z.object({ orgId: z.string(), projectId: z.string(), storyId: z.string() }).passthrough(),
  provenance: ConsultationTaskStateSchema,
  omissions: z.array(z.string()),
});

/** One repeatable-read local snapshot. No pending confirmation URLs/proofs enter the prompt. */
export async function captureConsultationTaskState(db: FacilityDb, scope: ConsultationScope) {
  return db.transaction(
    async (raw) => {
      const tx = raw as unknown as FacilityDb;
      const plans = await readStoryPlans(tx, scope, {
        webUrl: "https://facility.invalid",
        limit: 1,
      });
      const delivery = await readStoryDelivery(tx, scope);
      const omissions: string[] = [];
      const plan = plans.plan
        ? {
            ...plans.plan,
            markdown: Buffer.byteLength(plans.plan.markdown) <= 12_000 ? plans.plan.markdown : null,
          }
        : null;
      if (plans.plan && plan?.markdown === null)
        omissions.push(
          `Plan revision ${plans.plan.revision} text exceeds 12000 bytes and is omitted; its digest and scope remain identified`,
        );
      const data = {
        ...scope,
        plans: { state: plans.state, plan, decision: plans.decision },
        delivery: {
          scope: delivery.scope,
          candidate: delivery.candidate,
          observedAt: delivery.generatedAt,
          pullRequests: delivery.pullRequests.map(
            ({
              repository,
              number,
              required,
              primary,
              origin,
              state,
              draft,
              headSha,
              observedAt,
              stale,
              checks,
              reviews,
            }) => ({
              repository,
              number,
              required,
              primary,
              origin,
              state,
              draft,
              headSha,
              observedAt,
              stale,
              checks,
              reviews: {
                state: reviews.state,
                currentHeadCount: reviews.currentHeadCount,
                unverifiedHeadCount: reviews.unverifiedHeadCount,
                truncated: reviews.truncated,
                latest: reviews.latest.map(({ state, commitSha, current }) => ({
                  state,
                  commitSha,
                  current,
                })),
              },
            }),
          ),
        },
      };
      if (Buffer.byteLength(JSON.stringify(data)) > 32_768)
        throw new ApiError(
          409,
          "consultation_task_context_too_large",
          "The task's plan and delivery metadata exceed the consultation snapshot limit",
        );
      return Stored.parse({
        data,
        provenance: {
          hash: hash(data),
          capturedAt: new Date().toISOString(),
          planRevision: plans.state.revision,
          decisionRevision: plans.state.decisionRevision,
          deliveryScopeRevision: delivery.scope.revision,
          deliveryCandidateRevision: delivery.candidate.revision,
        },
        omissions,
      });
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export function readConsultationTaskState(value: unknown, scope: ConsultationScope) {
  if (value === undefined) return null; // Earlier saved consultations remain readable with unknown metadata.
  const parsed = Stored.parse(value);
  if (
    parsed.data.orgId !== scope.orgId ||
    parsed.data.projectId !== scope.projectId ||
    parsed.data.storyId !== scope.storyId ||
    hash(parsed.data) !== parsed.provenance.hash
  )
    throw new ApiError(
      500,
      "consultation_context_invalid",
      "The saved task-state snapshot does not match its scope and digest",
    );
  return parsed;
}
