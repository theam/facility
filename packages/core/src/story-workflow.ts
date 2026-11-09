import { z } from "zod";
import { PlanActorSchema } from "./story-plans.js";

const Revision = z.number().int().min(0).max(2_147_483_646);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const RequestKey = z.string().min(8).max(200);
const StoryWorkflowPolicyFields = z
  .object({
    planApprovalAgents: z.array(z.string().min(1).max(64)).max(20).default([]),
    holdAfterFailure: z.boolean().default(false),
    requireDeliveryAcceptance: z.boolean().default(false),
    requirePreviewForAcceptance: z.boolean().default(false),
  })
  .strict();
export const StoryWorkflowPolicySchema = StoryWorkflowPolicyFields.superRefine((value, context) => {
  if (new Set(value.planApprovalAgents).size !== value.planApprovalAgents.length)
    context.addIssue({
      code: "custom",
      path: ["planApprovalAgents"],
      message: "Choose each agent once",
    });
  if (value.planApprovalAgents.some((name) => name.trim() !== name || name.includes("\0")))
    context.addIssue({
      code: "custom",
      path: ["planApprovalAgents"],
      message: "Use configured agent names",
    });
  if (value.requirePreviewForAcceptance && !value.requireDeliveryAcceptance)
    context.addIssue({
      code: "custom",
      path: ["requirePreviewForAcceptance"],
      message: "Enable delivery acceptance before requiring a preview",
    });
})
  .transform((value) => ({ ...value, planApprovalAgents: [...value.planApprovalAgents].sort() }))
  .pipe(StoryWorkflowPolicyFields.required());
export const StoryWorkflowPolicyStateSchema = z.object({
  revision: Revision,
  policy: StoryWorkflowPolicySchema,
});
export const ReviewWorkflowPolicyBody = z
  .object({
    expected_revision: Revision,
    policy: StoryWorkflowPolicySchema,
    idempotency_key: RequestKey,
  })
  .strict();
export const WorkflowPolicyReviewSchema = z.object({
  expectedRevision: Revision,
  policy: StoryWorkflowPolicySchema,
  nonce: z.string().min(1).max(200),
  expiresAt: z.string().datetime(),
  proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const ConfirmWorkflowPolicyBody = z
  .object({
    expected_revision: Revision,
    policy: StoryWorkflowPolicySchema,
    nonce: z.string().min(1).max(200),
    expires_at: z.string().datetime(),
    proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    idempotency_key: RequestKey,
  })
  .strict();
export const RequestDeliveryAcceptanceBody = z
  .object({
    expected_candidate_revision: Digest,
    expected_plan_revision: Revision,
    expected_decision_revision: Revision,
    idempotency_key: RequestKey,
  })
  .strict();
export const ConfirmDeliveryAcceptanceBody = z
  .object({
    proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    idempotency_key: RequestKey,
  })
  .strict();
export const DeliveryAcceptanceSnapshotSchema = z.object({
  candidateRevision: Digest,
  scopeRevision: Revision,
  planRevision: Revision,
  planDigest: Digest.nullable(),
  decisionRevision: Revision,
  policyRevision: Revision,
  acceptanceRevision: Revision,
  previewGeneration: Digest.nullable(),
  pullRequests: z
    .array(
      z.object({
        repository: z.string(),
        number: z.number().int().positive(),
        headSha: z.string(),
        url: z.string().nullable(),
      }),
    )
    .min(1)
    .max(50),
});
export const DeliveryAcceptanceReceiptSchema = z.object({
  id: z.string(),
  revision: Revision,
  requestId: z.string(),
  snapshot: DeliveryAcceptanceSnapshotSchema,
  confirmedBy: PlanActorSchema.extend({ type: z.literal("user") }),
  confirmedAt: z.string(),
  method: z.literal("interactive_session"),
});
export const DeliveryAcceptanceRequestSchema = z.object({
  id: z.string(),
  snapshot: DeliveryAcceptanceSnapshotSchema,
  requestedBy: PlanActorSchema,
  requestedAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(["pending", "confirmed", "expired", "superseded"]),
  confirmationUrl: z.string(),
});
export const StoryDeliveryAcceptanceSchema = z.object({
  schemaVersion: z.literal(1),
  orgId: z.string(),
  projectId: z.string(),
  storyId: z.string(),
  required: z.boolean(),
  status: z.enum(["missing", "current", "stale"]),
  receipt: DeliveryAcceptanceReceiptSchema.nullable(),
});
export const DeliveryAcceptanceReviewSchema = z.object({
  schemaVersion: z.literal(1),
  orgId: z.string(),
  projectId: z.string(),
  storyId: z.string(),
  request: DeliveryAcceptanceRequestSchema,
  proof: z.string().nullable(),
  receipt: DeliveryAcceptanceReceiptSchema.nullable(),
});
export const StoryWorkflowStatusSchema = z.object({
  schemaVersion: z.literal(1),
  orgId: z.string(),
  projectId: z.string(),
  storyId: z.string(),
  policy: StoryWorkflowPolicyStateSchema,
  plan: z.object({
    revision: Revision,
    decisionRevision: Revision,
    status: z.enum(["none", "proposed", "approved", "rejected"]),
  }),
  queuedAgents: z.array(z.string()).max(50),
  blockedReason: z.string().nullable(),
  acceptance: StoryDeliveryAcceptanceSchema,
});
export type StoryWorkflowPolicy = z.infer<typeof StoryWorkflowPolicySchema>;
export type StoryWorkflowPolicyState = z.infer<typeof StoryWorkflowPolicyStateSchema>;
export type DeliveryAcceptanceSnapshot = z.infer<typeof DeliveryAcceptanceSnapshotSchema>;
export type StoryDeliveryAcceptance = z.infer<typeof StoryDeliveryAcceptanceSchema>;
export type DeliveryAcceptanceReceipt = z.infer<typeof DeliveryAcceptanceReceiptSchema>;
export type DeliveryAcceptanceRequest = z.infer<typeof DeliveryAcceptanceRequestSchema>;
export type StoryWorkflowStatus = z.infer<typeof StoryWorkflowStatusSchema>;
