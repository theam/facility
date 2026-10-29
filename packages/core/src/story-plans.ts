import { z } from "zod";
import { DeliveryPullRequestInput } from "./story-delivery.js";

const Revision = z.number().int().min(0).max(2_147_483_646);
const RequestKey = z.string().min(8).max(200);
const Text = z
  .string()
  .min(1)
  .max(100_000)
  .refine((value) => value.trim().length > 0, "Write a plan before proposing it")
  .refine((value) => !value.includes("\0"), "NUL is not supported");
export const ProposeStoryPlanBody = z
  .object({
    expected_revision: Revision,
    markdown: Text,
    repositories: z.array(DeliveryPullRequestInput.shape.repository).min(1).max(50),
    agents: z.array(z.string().min(1).max(64)).min(1).max(20),
    source_message_id: z.string().min(1).max(200).optional(),
    idempotency_key: RequestKey,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.repositories.map((name) => name.toLowerCase())).size !==
      value.repositories.length
    )
      context.addIssue({
        code: "custom",
        path: ["repositories"],
        message: "Choose each repository once",
      });
    if (new Set(value.agents).size !== value.agents.length)
      context.addIssue({ code: "custom", path: ["agents"], message: "Choose each agent once" });
  });
export const PlanDecisionIntent = z.enum(["approve", "reject"]);
export const RequestPlanDecisionBody = z
  .object({
    expected_revision: Revision.refine((value) => value > 0, "A plan revision is required"),
    expected_decision_revision: Revision,
    intent: PlanDecisionIntent,
    reason: z
      .string()
      .trim()
      .max(2000)
      .refine((value) => !value.includes("\0"), "NUL is not supported")
      .optional(),
    idempotency_key: RequestKey,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.intent === "reject" && !value.reason)
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Explain the requested change before rejecting a plan",
      });
  });
export const ConfirmPlanDecisionBody = z
  .object({
    proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    idempotency_key: RequestKey,
  })
  .strict();
export const StoryPlanQuery = z.object({
  before_revision: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  before_decision_revision: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export const StoryPlanRepositoriesQuery = z.object({
  q: z.string().trim().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export const StoryPlanRepositoriesSchema = z.object({
  items: z.array(z.object({ repository: z.string(), primary: z.boolean() })).max(50),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nullable(),
});

export const PlanActorSchema = z.object({
  type: z.enum(["user", "service"]),
  id: z.string(),
  name: z.string().nullable(),
});
export const PlanRepositorySchema = z.object({ repositoryId: z.string(), repository: z.string() });
export const PlanAgentSchema = z.object({
  name: z.string(),
  manifestHash: z.string(),
  engine: z.enum(["claude_code", "codex"]),
  model: z.string(),
  repositoryId: z.string(),
  catalogCommitSha: z.string(),
  observedAt: z.string(),
});
export const StoryPlanSchema = z.object({
  revision: z.number().int(),
  digest: z.string(),
  markdown: z.string(),
  repositories: z.array(PlanRepositorySchema).max(50),
  agents: z.array(PlanAgentSchema).max(20),
  proposedBy: PlanActorSchema,
  proposedAt: z.string(),
  source: z
    .object({ messageId: z.string(), turnId: z.string().nullable(), role: z.string() })
    .nullable(),
});
export const StoryPlanDecisionSchema = z.object({
  id: z.string(),
  decisionRevision: z.number().int(),
  planRevision: z.number().int(),
  planDigest: z.string(),
  intent: PlanDecisionIntent,
  reason: z.string().nullable(),
  confirmedBy: PlanActorSchema.extend({ type: z.literal("user") }),
  confirmedAt: z.string(),
  method: z.literal("interactive_session"),
  requestId: z.string(),
});
export const PlanDecisionRequestSchema = z.object({
  id: z.string(),
  planRevision: z.number().int(),
  planDigest: z.string(),
  decisionRevision: z.number().int(),
  intent: PlanDecisionIntent,
  reason: z.string().nullable(),
  requestedBy: PlanActorSchema,
  requestedAt: z.string(),
  expiresAt: z.string(),
  boundUserId: z.string().nullable(),
  status: z.enum(["pending", "expired", "superseded", "confirmed"]),
  confirmationUrl: z.string(),
});
export const StoryPlanStateSchema = z.object({
  revision: z.number().int(),
  decisionRevision: z.number().int(),
  status: z.enum(["none", "proposed", "approved", "rejected"]),
});
export const StoryPlansSchema = z.object({
  schemaVersion: z.literal(1),
  orgId: z.string(),
  projectId: z.string(),
  storyId: z.string(),
  generatedAt: z.string(),
  state: StoryPlanStateSchema,
  plan: StoryPlanSchema.nullable(),
  decision: StoryPlanDecisionSchema.nullable(),
  history: z.object({
    items: z.array(StoryPlanSchema.omit({ markdown: true })),
    hasMore: z.boolean(),
    nextBeforeRevision: z.number().int().nullable(),
  }),
  decisions: z.object({
    items: z.array(StoryPlanDecisionSchema),
    hasMore: z.boolean(),
    nextBeforeRevision: z.number().int().nullable(),
  }),
  pending: z.object({ items: z.array(PlanDecisionRequestSchema), hasMore: z.boolean() }),
});
export const PlanDecisionRequestResult = z.object({
  request: PlanDecisionRequestSchema,
  state: StoryPlanStateSchema,
});
export const PlanDecisionReviewSchema = z.object({
  schemaVersion: z.literal(1),
  orgId: z.string(),
  projectId: z.string(),
  storyId: z.string(),
  request: PlanDecisionRequestSchema,
  plan: StoryPlanSchema,
  state: StoryPlanStateSchema,
  decision: StoryPlanDecisionSchema.nullable(),
  proof: z.string().nullable(),
});

export type ProposeStoryPlan = z.infer<typeof ProposeStoryPlanBody>;
export type RequestPlanDecision = z.infer<typeof RequestPlanDecisionBody>;
export type StoryPlans = z.infer<typeof StoryPlansSchema>;
export type StoryPlan = z.infer<typeof StoryPlanSchema>;
export type StoryPlanDecision = z.infer<typeof StoryPlanDecisionSchema>;
export type PlanDecisionRequest = z.infer<typeof PlanDecisionRequestSchema>;
export type PlanDecisionReview = z.infer<typeof PlanDecisionReviewSchema>;
export type PlanActor = z.infer<typeof PlanActorSchema>;
export type PlanAgent = z.infer<typeof PlanAgentSchema>;
export type PlanRepository = z.infer<typeof PlanRepositorySchema>;
