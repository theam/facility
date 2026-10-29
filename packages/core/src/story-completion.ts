import { z } from "zod";

export const DeliveryIntegrationMode = z.enum(["none", "manual", "repository_dispatch"]);

export const DeliveryNoticePolicySchema = z
  .object({
    in_app: z.boolean().default(true),
  })
  .strict();

export const DeliveryIntegrationPolicySchema = z
  .object({
    mode: DeliveryIntegrationMode.default("none"),
    repository: z
      .string()
      .min(3)
      .max(240)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "repository_dispatch" && value.repository === null)
      context.addIssue({
        code: "custom",
        path: ["repository"],
        message: "Choose a connected repository for repository_dispatch",
      });
    if (value.mode !== "repository_dispatch" && value.repository !== null)
      context.addIssue({
        code: "custom",
        path: ["repository"],
        message: "A repository is used only with repository_dispatch",
      });
  });

export const RecordDeliveryIntegrationBody = z
  .object({
    candidate_revision: z.string().regex(/^[a-f0-9]{64}$/),
    event_id: z.string().uuid().nullable().default(null),
    state: z.enum(["succeeded", "failed"]),
    summary: z.string().trim().min(1).max(2_000),
    evidence_url: z.string().url().max(2_000).nullable().default(null),
    idempotency_key: z.string().min(8).max(200),
  })
  .strict();

export const RequestStoryCompletionBody = z
  .object({
    candidate_revision: z.string().regex(/^[a-f0-9]{64}$/),
    confirm: z.literal(true),
    idempotency_key: z.string().min(8).max(200),
  })
  .strict();

const Actor = z.object({ type: z.enum(["user", "service"]), id: z.string() });

export const StoryCompletionSchema = z.object({
  schemaVersion: z.literal(1),
  orgId: z.string(),
  projectId: z.string(),
  storyId: z.string(),
  generatedAt: z.string(),
  candidate: z.object({
    revision: z.string().nullable(),
    state: z.enum(["scope_incomplete", "unobserved", "stale", "recorded"]),
    requiredCount: z.number().int(),
    mergedCount: z.number().int(),
    allRequiredMerged: z.boolean().nullable(),
  }),
  integration: z.object({
    policy: DeliveryIntegrationPolicySchema,
    candidateRevision: z.string().nullable(),
    state: z.enum([
      "not_required",
      "pending",
      "dispatching",
      "dispatched",
      "succeeded",
      "failed",
      "stale",
    ]),
    attempt: z.number().int(),
    eventId: z.string().nullable(),
    repository: z.string().nullable(),
    summary: z.string().nullable(),
    evidenceUrl: z.string().nullable(),
    errorCode: z.string().nullable(),
    recordedBy: Actor.nullable(),
    recordedAt: z.string().nullable(),
  }),
  source: z.object({
    kind: z.enum(["github_issue", "other"]),
    state: z.enum(["open", "closed", "unavailable"]),
    url: z.string().nullable(),
  }),
  completion: z.object({
    candidateRevision: z.string().nullable(),
    state: z.enum(["not_requested", "pending", "closing", "failed", "completed", "stale"]),
    attempt: z.number().int(),
    errorCode: z.string().nullable(),
    requestedBy: Actor.nullable(),
    requestedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  }),
  notices: DeliveryNoticePolicySchema,
  retention: z.object({
    workspaceState: z.string().nullable(),
    computeSuspended: z.boolean(),
    storageRetained: z.boolean(),
    archived: z.boolean(),
    deleted: z.boolean(),
  }),
  nextAction: z.enum([
    "declare_delivery",
    "review",
    "merge",
    "configure_integration",
    "record_integration",
    "wait_integration",
    "inspect_integration_failure",
    "request_completion",
    "wait_completion",
    "retry_completion",
    "completed",
  ]),
});

export type DeliveryIntegrationPolicy = z.infer<typeof DeliveryIntegrationPolicySchema>;
export type DeliveryNoticePolicy = z.infer<typeof DeliveryNoticePolicySchema>;
export type StoryCompletion = z.infer<typeof StoryCompletionSchema>;
export type RecordDeliveryIntegration = z.infer<typeof RecordDeliveryIntegrationBody>;
export type RequestStoryCompletion = z.infer<typeof RequestStoryCompletionBody>;
