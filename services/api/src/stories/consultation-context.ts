import { createHash } from "node:crypto";
import { CONSULTATION_LIMITS, ConsultationSource, type StoryConsultation } from "@facility/core";
import { type FacilityDb, storyMessages } from "@facility/db";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { ApiError } from "../errors.js";
import {
  type ConsultationFile,
  ConsultationRepositorySchema,
  type ConsultationSources,
  consultationRepositoryFingerprint,
  revalidateConsultationRepositories,
} from "./consultation-sources.js";
import type { ConsultationRow } from "./consultation-state.js";
import { readConsultationTaskState } from "./consultation-task-state.js";

export const consultationTextHash = (text: string) =>
  createHash("sha256").update(text).digest("base64url");
export async function prepareConsultationContext(
  db: FacilityDb,
  sources: ConsultationSources,
  row: ConsultationRow,
) {
  const scope = { orgId: row.orgId, projectId: row.projectId, storyId: row.storyId };
  const taskState = readConsultationTaskState(
    (row.contextData as { taskState?: unknown }).taskState,
    scope,
  );
  const inputs = z.array(ConsultationSource).max(CONSULTATION_LIMITS.files).parse(row.sourceInputs);
  const identities = z
    .array(ConsultationRepositorySchema)
    .min(1)
    .max(5)
    .parse((row.contextData as { requestIdentities?: unknown }).requestIdentities);
  await revalidateConsultationRepositories(db, sources, scope, identities);
  const files: ConsultationFile[] = [];
  for (const input of inputs) {
    const file = await sources.read(scope, input);
    const expected = identities.find((identity) => identity.id === file.repositoryId);
    if (
      !expected ||
      consultationRepositoryFingerprint(expected) !==
        consultationRepositoryFingerprint(file.identity)
    )
      throw new ApiError(
        409,
        "consultation_repository_changed",
        "A source repository changed during snapshot preparation",
      );
    files.push(file);
  }
  const messageScope = and(
    eq(storyMessages.orgId, row.orgId),
    eq(storyMessages.projectId, row.projectId),
    eq(storyMessages.storyId, row.storyId),
    lte(storyMessages.seq, row.throughMessageSeq),
  );
  const [recent, [count]] = await Promise.all([
    db
      .select({ seq: storyMessages.seq, role: storyMessages.role, body: storyMessages.body })
      .from(storyMessages)
      .where(messageScope)
      .orderBy(desc(storyMessages.seq))
      .limit(50),
    db.select({ total: sql<number>`count(*)::int` }).from(storyMessages).where(messageScope),
  ]);
  if (!count || count.total < recent.length)
    throw new ApiError(
      500,
      "consultation_context_invalid",
      "Conversation snapshot count is unavailable",
    );
  const initial = z
    .object({
      title: z.string().max(500),
      provider: z.string().max(100),
      externalId: z.string().max(500),
    })
    .parse((row.contextData as { initialStory?: unknown }).initialStory);
  const messages = recent.reverse();
  let summary = row.savedSummary;
  const omissions = [
    "Uncommitted workspace files are excluded",
    "Native implementation sessions, hooks, tools and project environment are excluded",
  ];
  if (taskState) omissions.push(...taskState.omissions);
  else
    omissions.push(
      "Structured plan and delivery metadata were not captured for this earlier request",
    );
  if (row.summaryOmitted)
    omissions.push("The saved conversation summary exceeded the snapshot limit and was omitted");
  const snapshot = () =>
    JSON.stringify({
      mode: "read_only_text_consultation",
      agent: {
        name: row.agentName,
        model: row.model,
        reasoningEffort: row.reasoningEffort,
        guidance: row.agentPrompt,
      },
      story: { id: row.storyId, ...initial },
      taskState: taskState?.data ?? null,
      conversation: { throughMessageSeq: row.throughMessageSeq, summary, messages },
      sources: files.map(({ repositoryId, repository, commitSha, path, hash, text }) => ({
        repositoryId,
        repository,
        commitSha,
        path,
        hash,
        text,
      })),
      omissions,
      question: row.request,
    });
  let prompt = snapshot();
  while (Buffer.byteLength(prompt) > 60_000 && messages.length > 0) {
    messages.shift();
    prompt = snapshot();
  }
  if (Buffer.byteLength(prompt) > 60_000 && summary) {
    summary = null;
    omissions.push("The saved summary was omitted to fit the source snapshot");
    prompt = snapshot();
  }
  if (Buffer.byteLength(prompt) > 60_000)
    throw new ApiError(
      409,
      "consultation_context_too_large",
      "Choose fewer or smaller source files, or shorten the consultation request",
    );
  const omittedMessages = count.total - messages.length;
  if (omittedMessages > 0) {
    omissions.push(`${omittedMessages} earlier conversation messages were omitted`);
    prompt = snapshot();
  }
  if (Buffer.byteLength(prompt) > 60_000)
    throw new ApiError(
      409,
      "consultation_context_too_large",
      "The consultation snapshot exceeds its byte limit",
    );
  const hash = consultationTextHash(prompt);
  const context: StoryConsultation["context"] = {
    hash,
    taskState: taskState?.provenance ?? null,
    throughMessageSeq: row.throughMessageSeq,
    omittedMessages,
    summaryIncluded: summary !== null,
    omissions,
    requestedSources: inputs,
    workspaceFilesIncluded: false,
    files: files.map(({ repositoryId, repository, commitSha, path, hash, bytes }) => ({
      repositoryId,
      repository,
      commitSha,
      path,
      hash,
      bytes,
    })),
  };
  return { prompt, hash, context, identities };
}
