import type { RequestStoryConsultation } from "@facility/sdk";
import { readStoryDraft, writeStoryDraft } from "./story-draft";

export type ConsultationSourceDraft = {
  rowId: string;
  repositoryId: string;
  commitSha: string;
  path: string;
};
export type ConsultationDraft = {
  agent: string;
  question: string;
  sources: ConsultationSourceDraft[];
  attempt?: { body: RequestStoryConsultation; model: string };
};
export function consultationDraftKey(owner: string | undefined, project: string, story: string) {
  return owner ? `facility:consultation-draft:v1:${JSON.stringify([owner, project, story])}` : null;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
export function readConsultationDraft(key: string | null): ConsultationDraft | null {
  const stored = readStoryDraft(key);
  if (!stored || !text(stored.agent, 64)) return null;
  try {
    const data = object(JSON.parse(stored.message));
    if (!text(data.question, 8000) || !Array.isArray(data.sources) || data.sources.length > 4)
      return null;
    const sources: ConsultationSourceDraft[] = [];
    for (const item of data.sources) {
      const source = object(item);
      if (
        !text(source.rowId, 100) ||
        !source.rowId ||
        !text(source.repositoryId, 200) ||
        !text(source.commitSha, 40) ||
        !text(source.path, 500)
      )
        return null;
      sources.push({
        rowId: source.rowId,
        repositoryId: source.repositoryId,
        commitSha: source.commitSha,
        path: source.path,
      });
    }
    const draft: ConsultationDraft = { agent: stored.agent, question: data.question, sources };
    if (data.attempt !== undefined) {
      const attempt = object(data.attempt),
        body = object(attempt.body);
      if (
        !text(attempt.model, 160) ||
        body.agent !== draft.agent ||
        body.message !== draft.question ||
        !text(body.expected_agent_hash, 128) ||
        !body.expected_agent_hash ||
        !text(body.expected_catalog_sha, 40) ||
        !/^[a-f0-9]{40}$/.test(body.expected_catalog_sha) ||
        body.idempotency_key !== stored.idempotencyKey ||
        !stored.idempotencyKey
      )
        return null;
      const encodedSources = sources.map((source) => ({
        repository_id: source.repositoryId,
        commit_sha: source.commitSha,
        path: source.path,
      }));
      if (JSON.stringify(body.sources) !== JSON.stringify(encodedSources)) return null;
      draft.attempt = {
        model: attempt.model,
        body: {
          agent: draft.agent,
          expected_agent_hash: body.expected_agent_hash,
          expected_catalog_sha: body.expected_catalog_sha,
          message: draft.question,
          sources: encodedSources,
          idempotency_key: stored.idempotencyKey,
        },
      };
    }
    return draft;
  } catch {
    return null;
  }
}
export function writeConsultationDraft(key: string | null, draft: ConsultationDraft) {
  return writeStoryDraft(key, {
    agent: draft.agent,
    message:
      draft.question || draft.sources.length || draft.attempt
        ? JSON.stringify({
            question: draft.question,
            sources: draft.sources,
            attempt: draft.attempt,
          })
        : "",
    idempotencyKey: draft.attempt?.body.idempotency_key,
  });
}
