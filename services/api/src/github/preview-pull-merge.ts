import type { PreviewGenerationRepository } from "@facility/core";
import { z } from "zod";
import {
  GithubWorkspaceCredentialError,
  type GithubWorkspaceCredentials,
} from "./workspace-credentials.js";

const sha = z.string().regex(/^[a-f\d]{40}$/i);
const pullSnapshot = z.object({
  number: z.number().int().positive(),
  merged: z.boolean(),
  head: z.object({ sha }),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
  merge_commit_sha: sha.nullable(),
});

export type PreviewPullMergeResolver = (
  target: PreviewGenerationRepository,
  credentials: GithubWorkspaceCredentials,
  signal?: AbortSignal,
) => Promise<string | null>;

/** A merged PR's integration commit is evidence only for its exact recorded head. */
export async function readPreviewPullMerge(
  target: PreviewGenerationRepository,
  credentials: GithubWorkspaceCredentials,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<string | null> {
  const key = target.repository.toLowerCase();
  const repository = credentials.repositories.find(
    (item) => `${item.owner}/${item.name}`.toLowerCase() === key,
  );
  if (!repository) {
    throw new GithubWorkspaceCredentialError(
      "preview_repository_mismatch",
      "The required preview repository is not connected to this project.",
    );
  }
  if (
    !Number.isSafeInteger(target.pullNumber) ||
    target.pullNumber < 1 ||
    !sha.safeParse(target.headSha).success
  ) {
    throw unavailable();
  }
  let tokens: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(
      credentials.environment.FACILITY_GITHUB_CREDENTIALS ?? "null",
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    tokens = parsed as Record<string, unknown>;
  } catch {
    throw invalidCredential();
  }
  const token = Object.hasOwn(tokens, key) ? tokens[key] : undefined;
  if (typeof token !== "string" || !token || /\s/.test(token)) throw invalidCredential();
  if (
    !Number.isFinite(credentials.expiresAt.getTime()) ||
    credentials.expiresAt.getTime() <= Date.now()
  ) {
    throw new GithubWorkspaceCredentialError(
      "github_token_expired",
      "The preview GitHub credential has expired.",
    );
  }
  signal?.throwIfAborted();
  let body: unknown;
  try {
    const response = await request(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${target.pullNumber}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "Facility",
          authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      },
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      throw unavailable();
    }
    body = await response.json();
    signal?.throwIfAborted();
  } catch {
    if (signal?.aborted) throw signal.reason;
    // Provider response bodies and transport errors can contain credentials.
    throw unavailable();
  }
  const parsed = pullSnapshot.safeParse(body);
  if (!parsed.success) throw unavailable();
  const pull = parsed.data;
  if (
    pull.number !== target.pullNumber ||
    pull.base.repo.full_name.toLowerCase() !== key ||
    pull.head.sha.toLowerCase() !== target.headSha.toLowerCase()
  ) {
    throw new GithubWorkspaceCredentialError(
      "preview_pull_request_changed",
      "GitHub no longer confirms the repository, number and exact head of the required preview PR.",
    );
  }
  // Open PRs also have a synthetic merge_commit_sha. It is never integration evidence.
  if (!pull.merged) return null;
  if (!pull.merge_commit_sha) throw unavailable();
  return pull.merge_commit_sha.toLowerCase();
}

function invalidCredential() {
  return new GithubWorkspaceCredentialError(
    "github_token_invalid",
    "The preview has no valid credential for this repository.",
  );
}

function unavailable() {
  return new GithubWorkspaceCredentialError(
    "preview_pull_request_unavailable",
    "GitHub could not confirm the required preview PR's integration state.",
  );
}
