import { z } from "zod";

export const CONSULTATION_LIMITS = {
  requestBytes: 8_000,
  agentPromptBytes: 12_000,
  inputBytes: 65_536,
  responseBytes: 131_072,
  outputBytes: 32_768,
  outputTokens: 2_048,
  fileBytes: 8_192,
  files: 4,
  projectConcurrency: 4,
  timeoutMs: 30_000,
  deadlineMs: 120_000,
} as const;

const boundedText = (bytes: number) =>
  z
    .string()
    .min(1)
    .max(bytes)
    .refine(
      (v) =>
        !v.includes("\0") && v.trim().length > 0 && new TextEncoder().encode(v).length <= bytes,
      "Text exceeds its byte limit",
    );
const Id = z.string().min(1).max(200);
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ConsultationTaskStateSchema = z.object({
  hash: Digest,
  capturedAt: z.string().datetime(),
  planRevision: z.number().int().nonnegative(),
  decisionRevision: z.number().int().nonnegative(),
  deliveryScopeRevision: z.number().int().nonnegative(),
  deliveryCandidateRevision: z.string().nullable(),
});
export const ConsultationPath = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => {
    const parts = value.split("/");
    return (
      !value.includes("\\") &&
      !/[:?%#]/.test(value) &&
      ![...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) &&
      parts.every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          part !== ".git" &&
          !/^\.env(?:\.|$)/i.test(part),
      ) &&
      !/\.(?:pem|key|p12|pfx)$/i.test(value)
    );
  }, "Choose a regular committed source file using a relative repository path");
export const ConsultationSource = z
  .object({ repository_id: Id, commit_sha: Sha, path: ConsultationPath })
  .strict();
export const RequestConsultationBody = z
  .object({
    agent: z.string().min(1).max(64),
    expected_agent_hash: z.string().min(1).max(128),
    expected_catalog_sha: Sha,
    message: boundedText(CONSULTATION_LIMITS.requestBytes),
    sources: z.array(ConsultationSource).max(CONSULTATION_LIMITS.files).default([]),
    idempotency_key: boundedText(200).refine((v) => v.length >= 8),
  })
  .strict()
  .refine(
    (v) => new Set(v.sources.map((s) => JSON.stringify(s))).size === v.sources.length,
    "Source files must be unique",
  );
export const ConsultationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export const CancelConsultationBody = z
  .object({ idempotency_key: boundedText(200).refine((v) => v.length >= 8) })
  .strict();
export const ConsultationState = z.enum([
  "queued",
  "preparing",
  "running",
  "succeeded",
  "incomplete",
  "failed",
  "canceled",
]);
export const ConsultationSchema = z.object({
  id: Id,
  storyId: Id,
  state: ConsultationState,
  executor: z.literal("provider_api_text"),
  agent: z.object({
    name: z.string(),
    engine: z.enum(["codex", "claude_code"]),
    model: z.string(),
    reasoningEffort: z.string().nullable(),
    manifestHash: z.string(),
    catalogSha: Sha,
  }),
  provider: z.enum(["openai", "anthropic"]),
  providerModel: z.string().nullable(),
  request: z.string(),
  result: z.string().nullable(),
  resultHash: Digest.nullable(),
  errorCode: z.string().nullable(),
  actor: z.object({
    type: z.enum(["user", "service"]),
    id: z.string(),
    name: z.string().nullable(),
  }),
  context: z.object({
    hash: Digest.nullable(),
    taskState: ConsultationTaskStateSchema.nullable().default(null),
    throughMessageSeq: z.number().int().nonnegative(),
    omittedMessages: z.number().int().nonnegative().nullable(),
    summaryIncluded: z.boolean().nullable(),
    omissions: z.array(z.string()),
    requestedSources: z.array(ConsultationSource),
    workspaceFilesIncluded: z.literal(false),
    files: z.array(
      z.object({
        repositoryId: Id,
        repository: z.string(),
        commitSha: Sha,
        path: z.string(),
        hash: Digest,
        bytes: z.number().int().nonnegative(),
      }),
    ),
  }),
  billing: z.object({
    costsVisible: z.boolean(),
    state: z.enum(["not_started", "reserved", "started", "confirmed", "unconfirmed", "unbilled"]),
    estimatedCents: z.number().nonnegative().nullable(),
    costCents: z.number().nonnegative().nullable(),
  }),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
  cancelRequestedAt: z.string().datetime().nullable(),
});
export const ConsultationsSchema = z.object({
  items: z.array(ConsultationSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export const ConsultationOptionsSchema = z.object({
  costsVisible: z.boolean(),
  executor: z.literal("provider_api_text"),
  catalogSha: Sha,
  agents: z.array(
    z.object({
      name: z.string(),
      engine: z.enum(["claude_code", "codex"]),
      model: z.string(),
      reasoningEffort: z.string().nullable(),
      manifestHash: z.string(),
      eligible: z.boolean(),
      reason: z.string().nullable(),
      estimateCents: z.number().nonnegative().nullable(),
    }),
  ),
  repositories: z.array(
    z.object({ id: Id, repository: z.string(), branch: z.string(), commitSha: Sha }),
  ),
  limits: z.object({
    files: z.number().int(),
    fileBytes: z.number().int(),
    requestBytes: z.number().int(),
    outputTokens: z.number().int(),
  }),
});
export const ConsultationHandoffSchema = z.object({
  consultationId: Id,
  resultHash: Digest,
  agent: z.string(),
  message: z.string(),
  requiresExplicitSend: z.literal(true),
});
export type StoryConsultation = z.infer<typeof ConsultationSchema>;
export type RequestConsultation = z.infer<typeof RequestConsultationBody>;
export type ConsultationOptions = z.infer<typeof ConsultationOptionsSchema>;
