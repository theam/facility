import { z } from "zod";
import { readDecisionBlock } from "./decision-block.js";
import { DecisionBriefSchema } from "./decision-brief.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Reference = z
  .object({
    repositoryId: z.string().min(1).max(200),
    number: z.number().int().min(1).max(2_147_483_647),
    headSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    required: z.boolean(),
    primary: z.boolean(),
  })
  .strict();
export const DeliveryBriefSubjectSchema = z
  .object({
    scopeRevision: z.number().int().min(0),
    candidateRevision: Digest,
    pullRequests: z.array(Reference).min(1).max(50),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.pullRequests.map((pull) => `${pull.repositoryId}:${pull.number}`);
    if (
      new Set(keys).size !== keys.length ||
      value.pullRequests.filter((pull) => pull.primary).length !== 1 ||
      value.pullRequests.some((pull) => pull.primary && !pull.required)
    )
      context.addIssue({
        code: "custom",
        message: "Use unique PR references and exactly one required primary",
      });
  });

/** Author statements bound to every head, including optional delivery PRs. */
export const DeliveryDecisionBriefSchema = z
  .object({
    schemaVersion: z.literal(1),
    subject: DeliveryBriefSubjectSchema,
    brief: DecisionBriefSchema,
  })
  .strict();
export const DeliveryBriefSourceSchema = z.object({
  messageId: z.string(),
  seq: z.number().int(),
  createdAt: z.string(),
  digest: Digest.nullable(),
  turn: z
    .object({ id: z.string(), agentName: z.string(), engine: z.string(), model: z.string() })
    .nullable(),
});
const Saved = {
  source: DeliveryBriefSourceSchema,
  subject: DeliveryBriefSubjectSchema,
  brief: DecisionBriefSchema,
};
export const DeliveryDecisionBriefProjectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }),
  z.object({ status: z.literal("available"), ...Saved }),
  z.object({
    status: z.literal("stale"),
    ...Saved,
    reason: z.enum(["scope_changed", "heads_changed", "candidate_changed"]),
  }),
  z.object({
    status: z.literal("unverifiable"),
    ...Saved,
    reason: z.enum(["source_unavailable", "observations_unavailable", "observations_stale"]),
  }),
  z.object({
    status: z.literal("invalid"),
    source: DeliveryBriefSourceSchema,
    reason: z.enum([
      "too_large",
      "duplicate",
      "malformed",
      "unsupported_version",
      "invalid_fields",
    ]),
  }),
]);
export type DeliveryDecisionBrief = z.infer<typeof DeliveryDecisionBriefSchema>;
export type DeliveryDecisionBriefProjection = z.infer<typeof DeliveryDecisionBriefProjectionSchema>;
export type DeliveryBriefSource = z.infer<typeof DeliveryBriefSourceSchema>;

export function readDeliveryDecisionBrief(markdown: string) {
  // Ordinary final responses, including large transcripts, do not replace a brief.
  if (!/(?:^|\n) {0,3}(?:`{3,}|~{3,})[\t ]*facility-delivery[\t ]*(?:\r?\n|$)/.test(markdown))
    return { status: "absent" as const };
  return readDecisionBlock(markdown, "facility-delivery", DeliveryDecisionBriefSchema, 32_000);
}
