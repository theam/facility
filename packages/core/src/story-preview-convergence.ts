import { z } from "zod";

export const PreviewGenerationRepositorySchema = z
  .object({
    repositoryId: z.string().min(1),
    repository: z.string().min(3),
    pullNumber: z.number().int().positive(),
    headRef: z.string().min(1).nullable(),
    headSha: z.string().regex(/^[a-f\d]{40}$/i),
    primary: z.boolean(),
  })
  .strict();

export const StoryPreviewConvergenceStateSchema = z.enum([
  "pending",
  "waiting",
  "applying",
  "blocked",
  "failed",
  "ready",
  "suspended",
]);

export const StoryPreviewConvergenceSchema = z.object({
  schemaVersion: z.literal(1),
  orgId: z.string(),
  projectId: z.string(),
  storyId: z.string(),
  revision: z.number().int().positive(),
  state: StoryPreviewConvergenceStateSchema,
  desired: z.object({
    generation: z.string().regex(/^[a-f\d]{64}$/i),
    deliveryRevision: z.string().regex(/^[a-f\d]{64}$/i),
    repositories: z.array(PreviewGenerationRepositorySchema).min(1).max(50),
    observedAt: z.string(),
  }),
  deployedGeneration: z
    .string()
    .regex(/^[a-f\d]{64}$/i)
    .nullable(),
  lastGoodGeneration: z
    .string()
    .regex(/^[a-f\d]{64}$/i)
    .nullable(),
  attempt: z
    .object({
      id: z.string(),
      number: z.number().int().positive(),
      generation: z.string().regex(/^[a-f\d]{64}$/i),
      state: z.enum(["applying", "succeeded", "failed", "blocked", "superseded"]),
      workspaceId: z.string().nullable(),
      cause: z.record(z.string(), z.unknown()),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
    })
    .nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryAt: z.string().nullable(),
    })
    .nullable(),
  updatedAt: z.string(),
});

export type PreviewGenerationRepository = z.infer<typeof PreviewGenerationRepositorySchema>;
export type StoryPreviewConvergence = z.infer<typeof StoryPreviewConvergenceSchema>;
export type StoryPreviewConvergenceState = z.infer<typeof StoryPreviewConvergenceStateSchema>;
