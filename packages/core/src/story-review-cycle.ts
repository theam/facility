import { z } from "zod";
import { ConsultationPath } from "./story-consultations.js";

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Repository = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .max(200);
const Id = z.string().min(1).max(100);
const PositiveInteger = z.number().int().positive();
const Text = z.string().trim().min(1).max(1_000);
const Agent = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const ReviewSourceSchema = z
  .object({
    repository: Repository,
    path: ConsultationPath,
    revision: z.enum(["base", "head"]).optional(),
  })
  .strict();
export const ReviewCyclePolicySchema = z
  .object({
    builderAgent: Agent,
    reviewerAgent: Agent,
    timeoutMinutes: z.number().int().min(1).max(120),
    maxCostCents: z.number().int().min(1).max(10_000),
    requiredPullLabel: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/)
      .optional(),
    requiredChecks: z
      .array(z.object({ repository: Repository, name: z.string().min(1).max(100) }).strict())
      .max(40)
      .optional(),
    sources: z.array(ReviewSourceSchema).max(12).optional(),
    syntheticTest: z
      .object({
        argv: z
          .array(
            z
              .string()
              .min(1)
              .max(250)
              .refine((text) => !text.includes("\0")),
          )
          .min(1)
          .max(16),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((policy) => policy.builderAgent !== policy.reviewerAgent, {
    path: ["reviewerAgent"],
    message: "Choose a different enabled agent for review",
  });

const PullIdentity = z.object({ repository: Repository, number: PositiveInteger });
export const PublishedReviewHeadSchema = PullIdentity.extend({ headSha: Sha }).strict();
export const ReviewedPullSchema = PublishedReviewHeadSchema.extend({ baseSha: Sha }).strict();
export const ReviewPullSnapshotSchema = ReviewedPullSchema.extend({
  repositoryId: z.string(),
  primary: z.boolean(),
  headRef: z.string().min(1).max(500),
  baseRef: z.string().min(1).max(500),
  url: z.url(),
  changedFiles: z.number().int().nonnegative(),
  checks: z.object({
    headSha: Sha.nullable(),
    state: z.enum(["pending", "success", "failure", "unobserved"]),
    observedAt: z.string().nullable(),
    runs: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          status: z.string(),
          conclusion: z.string().nullable(),
          observedAt: z.string(),
        }),
      )
      .max(100),
  }),
});
export const ReviewCandidateSchema = z.object({
  id: Digest,
  deliveryRevision: Digest,
  scopeRevision: z.number().int().nonnegative(),
  pullRequests: z.array(ReviewPullSnapshotSchema).min(1).max(50),
  preview: z
    .object({
      generation: Digest,
      observedAt: z.string(),
      sources: z
        .array(
          z.object({
            repository: Repository,
            headSha: Sha,
            submodules: z
              .array(
                z.object({
                  repository: Repository,
                  path: ConsultationPath,
                  pinnedSha: Sha,
                  headSha: Sha,
                }),
              )
              .max(100),
          }),
        )
        .max(50)
        .optional(),
    })
    .nullable(),
});

export const ReviewFindingSchema = PullIdentity.extend({
  id: Id,
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  category: z.enum(["acceptance", "correctness", "security", "data", "suggestion"]),
  requirement: Text,
  path: ConsultationPath,
  line: PositiveInteger,
  evidence: Text,
  impact: Text,
  fix: Text,
  disposition: z.enum(["open", "resolved"]),
  correction: z.enum(["within_plan", "requires_decision"]),
}).strict();

export const DeliveryReviewResultSchema = z
  .object({
    candidateId: Digest,
    reviewedPulls: z.array(ReviewedPullSchema).min(1).max(50),
    acceptance: z
      .array(
        z
          .object({
            id: Id,
            criterion: Text,
            state: z.enum(["verified", "violated", "unverified"]),
            evidence: Text,
          })
          .strict(),
      )
      .min(1)
      .max(30),
    findings: z.array(ReviewFindingSchema).max(30),
    missingEvidence: z.array(Text).max(15),
  })
  .strict();

export const ReviewCyclePhaseSchema = z.enum([
  "waiting_for_evidence",
  "review",
  "correction",
  "human_review",
  "decision_required",
]);
export const ReviewCycleStatusSchema = z.object({
  id: z.string(),
  phase: ReviewCyclePhaseSchema,
  builderAgent: Agent,
  reviewerAgent: Agent,
  reviewsStarted: z.number().int().min(0).max(2),
  correctionsStarted: z.number().int().min(0).max(1),
  deadline: z.string(),
  maxCostCents: z.number(),
  costCents: z.number().nonnegative().nullable(),
  reason: z.string().nullable(),
  activeTurnId: z.string().nullable(),
  candidate: ReviewCandidateSchema.nullable(),
  reviews: z
    .array(
      z.object({
        turnId: z.string(),
        reviewerManifestHash: z.string(),
        policyRevision: z.number(),
        planRevision: z.number(),
        candidate: ReviewCandidateSchema,
        result: DeliveryReviewResultSchema,
      }),
    )
    .max(2),
});

export type ReviewCyclePolicy = z.infer<typeof ReviewCyclePolicySchema>;
export type ReviewCandidate = z.infer<typeof ReviewCandidateSchema>;
export type ReviewCycleStatus = z.infer<typeof ReviewCycleStatusSchema>;
export type PublishedReviewHead = z.infer<typeof PublishedReviewHeadSchema>;
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type DeliveryReviewResult = z.infer<typeof DeliveryReviewResultSchema>;
