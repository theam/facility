import { z } from "zod";

export const DeliveryPullRequestInput = z
  .object({
    repository: z
      .string()
      .min(3)
      .max(240)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    number: z.number().int().min(1).max(2_147_483_647),
    required: z.boolean().default(true),
    primary: z.boolean().default(false),
  })
  .strict();

export const ReplaceStoryDeliveryBody = z
  .object({
    expected_revision: z.number().int().min(0).max(2_147_483_646),
    declared_complete: z.boolean(),
    pull_requests: z.array(DeliveryPullRequestInput).max(50),
    idempotency_key: z.string().min(8).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, pull] of value.pull_requests.entries()) {
      const identity = `${pull.repository.toLowerCase()}#${pull.number}`;
      if (seen.has(identity))
        context.addIssue({
          code: "custom",
          path: ["pull_requests", index],
          message: "A pull request can appear only once",
        });
      seen.add(identity);
      if (pull.primary && !pull.required)
        context.addIssue({
          code: "custom",
          path: ["pull_requests", index, "required"],
          message: "The primary pull request must be required",
        });
    }
    const primaryCount = value.pull_requests.filter((pull) => pull.primary).length;
    if (value.pull_requests.length > 0 && primaryCount !== 1)
      context.addIssue({
        code: "custom",
        path: ["pull_requests"],
        message: "Choose exactly one delivery primary",
      });
    if (value.declared_complete && value.pull_requests.length === 0)
      context.addIssue({
        code: "custom",
        path: ["declared_complete"],
        message: "A complete PR set must contain a required primary",
      });
  });

export const StoryDeliveryQuery = z.object({
  include_available: z.enum(["true", "false"]).default("false"),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const Review = z.object({
  reviewId: z.string(),
  author: z.string().nullable(),
  state: z.string(),
  commitSha: z.string().nullable(),
  submittedAt: z.string().nullable(),
  url: z.string().nullable(),
  current: z.boolean(),
});
export const DeliveryPullRequestSchema = z.object({
  repositoryId: z.string(),
  repository: z.string(),
  number: z.number().int(),
  required: z.boolean(),
  primary: z.boolean(),
  origin: z.enum(["registered", "legacy"]),
  title: z.string().nullable(),
  url: z.string().nullable(),
  state: z.enum(["open", "closed", "merged", "unobserved"]),
  draft: z.boolean().nullable(),
  headSha: z.string().nullable(),
  headRef: z.string().nullable(),
  baseRef: z.string().nullable(),
  observedAt: z.string().nullable(),
  stale: z.boolean(),
  checks: z.object({
    state: z.enum(["unobserved", "pending", "success", "failure"]),
    headSha: z.string().nullable(),
    current: z.boolean(),
    observedAt: z.string().nullable(),
  }),
  reviews: z.object({
    state: z.enum(["unobserved", "recorded", "partial"]),
    currentHeadCount: z.number().int(),
    unverifiedHeadCount: z.number().int(),
    truncated: z.boolean(),
    latest: z.array(Review).max(5),
  }),
});
export const AvailableDeliveryPullRequestSchema = z.object({
  repositoryId: z.string(),
  repository: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  headSha: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  stale: z.boolean(),
});
export const StoryDeliverySchema = z.object({
  schemaVersion: z.literal(1),
  orgId: z.string(),
  projectId: z.string(),
  storyId: z.string(),
  generatedAt: z.string(),
  scope: z.object({
    revision: z.number().int(),
    declaredComplete: z.boolean(),
    origin: z.enum(["registered", "legacy"]),
    updatedAt: z.string().nullable(),
    updatedBy: z.object({ type: z.enum(["user", "service"]), id: z.string() }).nullable(),
  }),
  pullRequests: z.array(DeliveryPullRequestSchema).max(50),
  candidate: z.object({
    revision: z.string().nullable(),
    state: z.enum(["scope_incomplete", "unobserved", "stale", "recorded"]),
    requiredCount: z.number().int(),
    mergedCount: z.number().int(),
    allRequiredMerged: z.boolean().nullable(),
  }),
  available: z
    .object({
      items: z.array(AvailableDeliveryPullRequestSchema),
      hasMore: z.boolean(),
      nextOffset: z.number().int().nullable(),
    })
    .nullable(),
});

export type StoryDelivery = z.infer<typeof StoryDeliverySchema>;
export type DeliveryPullRequest = z.infer<typeof DeliveryPullRequestSchema>;
export type ReplaceStoryDelivery = z.infer<typeof ReplaceStoryDeliveryBody>;
