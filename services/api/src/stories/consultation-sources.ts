import { createHash } from "node:crypto";
import { CONSULTATION_LIMITS, ConsultationSource } from "@facility/core";
import { type FacilityDb, githubInstallations, projectRepositories } from "@facility/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { AgentCatalogService, GithubAgentCatalogSource } from "../agents/catalog.js";
import { ApiError } from "../errors.js";
import type { GithubClientFactory, Octokit } from "../github/client.js";
import { repositoryDevelopmentBranch } from "../github/development-branch.js";

export type ConsultationScope = { orgId: string; projectId: string; storyId: string };
export type ConsultationRepository = {
  id: string;
  orgId: string;
  projectId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  role: string;
  installationId: string;
  installationNumber: number;
  installationAccountId: number;
};
export type ConsultationFile = {
  repositoryId: string;
  repository: string;
  commitSha: string;
  path: string;
  hash: string;
  bytes: number;
  text: string;
  identity: ConsultationRepository;
};
export const ConsultationRepositorySchema = z
  .object({
    id: z.string().min(1).max(200),
    orgId: z.string().min(1).max(200),
    projectId: z.string().min(1).max(200),
    owner: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    defaultBranch: z.string().min(1).max(500),
    role: z.enum(["primary", "related"]),
    installationId: z.string().min(1).max(200),
    installationNumber: z.number().int().nonnegative(),
    installationAccountId: z.number().int().nonnegative(),
  })
  .strict();
export function consultationRepositoryFingerprint(value: ConsultationRepository) {
  return JSON.stringify([
    value.id,
    value.orgId,
    value.projectId,
    value.owner,
    value.name,
    value.defaultBranch,
    value.role,
    value.installationId,
    value.installationNumber,
    value.installationAccountId,
  ]);
}
export interface ConsultationSources {
  catalog(scope: ConsultationScope): ReturnType<AgentCatalogService["refreshSnapshot"]>;
  repositories(
    scope: ConsultationScope,
  ): Promise<Array<{ id: string; repository: string; branch: string; commitSha: string }>>;
  identity(
    scope: ConsultationScope,
    repositoryId: string,
    db?: FacilityDb,
  ): Promise<ConsultationRepository>;
  read(
    scope: ConsultationScope,
    source: { repository_id: string; commit_sha: string; path: string },
  ): Promise<ConsultationFile>;
}
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const denied = () =>
  new ApiError(
    409,
    "consultation_source_invalid",
    "The source must be a bounded regular UTF-8 file at the selected commit",
  );

/** This facade has fixed read capabilities and one deadline; mutation methods cannot reach Octokit. */
function underDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(
      new ApiError(
        503,
        "consultation_source_timeout",
        "The source snapshot could not be read within its deadline",
        undefined,
        true,
      ),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () =>
      reject(
        new ApiError(
          503,
          "consultation_source_timeout",
          "The source snapshot could not be read within its deadline",
          undefined,
          true,
        ),
      );
    signal.addEventListener("abort", aborted, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}
function readOnlyFactory(factory: GithubClientFactory, signal: AbortSignal): GithubClientFactory {
  return async (installationId) => {
    const client = await underDeadline(factory(installationId), signal);
    const request = { signal, timeout: 10_000 };
    const noWrite = async (): Promise<never> => {
      throw new ApiError(403, "consultation_write_denied", "Consultation sources are read-only");
    };
    return {
      request: async (route, args = {}) => {
        if (
          !client.request ||
          ![
            "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
            "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
          ].includes(route)
        )
          throw denied();
        return underDeadline(
          client.request(route, {
            owner: args.owner,
            repo: args.repo,
            ...(route.includes("trees")
              ? { tree_sha: args.tree_sha }
              : { file_sha: args.file_sha }),
            request,
          }),
          signal,
        );
      },
      rest: {
        git: {
          getCommit: (args) =>
            underDeadline(
              client.rest.git.getCommit({
                owner: args.owner,
                repo: args.repo,
                commit_sha: args.commit_sha,
                request,
              }),
              signal,
            ),
          createBlob: noWrite,
          createTree: noWrite,
          createCommit: noWrite,
          createRef: noWrite,
          updateRef: noWrite,
        },
        repos: {
          getContent: (args) =>
            underDeadline(
              client.rest.repos.getContent({
                owner: args.owner,
                repo: args.repo,
                path: args.path,
                ref: args.ref,
                request,
              }),
              signal,
            ),
          getBranch: (args) =>
            underDeadline(
              client.rest.repos.getBranch({
                owner: args.owner,
                repo: args.repo,
                branch: args.branch,
                request,
              }),
              signal,
            ),
          createInOrg: noWrite,
        },
        pulls: { create: noWrite },
      },
    } satisfies Octokit;
  };
}

export class GithubConsultationSources implements ConsultationSources {
  constructor(
    private readonly db: FacilityDb,
    private readonly factory: GithubClientFactory,
  ) {}

  catalog(scope: ConsultationScope) {
    return new AgentCatalogService(
      this.db,
      new GithubAgentCatalogSource(
        this.db,
        readOnlyFactory(this.factory, AbortSignal.timeout(10_000)),
      ),
    ).refreshSnapshot(scope.orgId, scope.projectId);
  }

  async identity(
    scope: ConsultationScope,
    repositoryId: string,
    db: FacilityDb = this.db,
  ): Promise<ConsultationRepository> {
    const [row] = await db
      .select({ repository: projectRepositories, installation: githubInstallations })
      .from(projectRepositories)
      .innerJoin(
        githubInstallations,
        and(
          eq(githubInstallations.id, projectRepositories.installationId),
          eq(githubInstallations.orgId, projectRepositories.orgId),
        ),
      )
      .where(
        and(
          eq(projectRepositories.orgId, scope.orgId),
          eq(projectRepositories.projectId, scope.projectId),
          eq(projectRepositories.id, repositoryId),
          isNull(githubInstallations.suspendedAt),
        ),
      )
      .limit(1)
      .for("share");
    if (!row?.repository.installationId)
      throw new ApiError(
        403,
        "consultation_repository_unavailable",
        "The connected source repository is unavailable in this project",
      );
    return {
      id: row.repository.id,
      orgId: row.repository.orgId,
      projectId: row.repository.projectId,
      owner: row.repository.owner,
      name: row.repository.name,
      defaultBranch: row.repository.defaultBranch,
      role: row.repository.role,
      installationId: row.repository.installationId,
      installationNumber: row.installation.installationId,
      installationAccountId: row.installation.accountId,
    };
  }

  async repositories(scope: ConsultationScope) {
    const rows = await this.db
      .select({ id: projectRepositories.id })
      .from(projectRepositories)
      .where(
        and(
          eq(projectRepositories.orgId, scope.orgId),
          eq(projectRepositories.projectId, scope.projectId),
        ),
      )
      .orderBy(asc(projectRepositories.owner), asc(projectRepositories.name))
      .limit(26);
    if (rows.length > 25)
      throw new ApiError(
        409,
        "consultation_repository_limit",
        "Consultation source selection supports at most 25 connected repositories",
      );
    const factory = readOnlyFactory(this.factory, AbortSignal.timeout(10_000));
    const result: Array<{ id: string; repository: string; branch: string; commitSha: string }> = [];
    for (let start = 0; start < rows.length; start += 4) {
      result.push(
        ...(await Promise.all(
          rows.slice(start, start + 4).map(async ({ id }) => {
            const repository = await this.identity(scope, id);
            const branch = await repositoryDevelopmentBranch(this.db, repository);
            const client = await factory(repository.installationNumber);
            const response = await client.rest.repos.getBranch({
              owner: repository.owner,
              repo: repository.name,
              branch,
            });
            if (!sha(response.data.commit.sha)) throw denied();
            return {
              id,
              repository: `${repository.owner}/${repository.name}`,
              branch,
              commitSha: response.data.commit.sha,
            };
          }),
        )),
      );
    }
    return result;
  }

  async read(
    scope: ConsultationScope,
    sourceInput: { repository_id: string; commit_sha: string; path: string },
  ): Promise<ConsultationFile> {
    const source = ConsultationSource.parse(sourceInput);
    const parts = source.path.split("/");
    if (parts.length > 12) throw denied();
    const identity = await this.identity(scope, source.repository_id);
    const client = await readOnlyFactory(
      this.factory,
      AbortSignal.timeout(10_000),
    )(identity.installationNumber);
    if (!client.request) throw denied();
    const repository = { owner: identity.owner, repo: identity.name };
    const commit = await client.rest.git.getCommit({
      ...repository,
      commit_sha: source.commit_sha,
    });
    if (commit.data.sha !== source.commit_sha || !sha(commit.data.tree.sha)) throw denied();
    let treeSha = commit.data.tree.sha;
    let blobSha: string | undefined;
    for (let index = 0; index < parts.length; index++) {
      const tree = (
        await client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
          ...repository,
          tree_sha: treeSha,
        })
      ).data as {
        sha?: unknown;
        truncated?: unknown;
        tree?: Array<{ path?: unknown; type?: unknown; mode?: unknown; sha?: unknown }>;
      };
      if (
        tree.sha !== treeSha ||
        tree.truncated !== false ||
        !Array.isArray(tree.tree) ||
        tree.tree.length > 10_000
      )
        throw denied();
      const matches = tree.tree.filter((entry) => entry.path === parts[index]);
      const entry = matches[0];
      if (matches.length !== 1 || !entry || !sha(entry.sha)) throw denied();
      if (index < parts.length - 1) {
        if (entry.type !== "tree" || entry.mode !== "040000") throw denied();
        treeSha = entry.sha;
      } else {
        if (entry.type !== "blob" || !["100644", "100755"].includes(String(entry.mode)))
          throw denied();
        blobSha = entry.sha;
      }
    }
    if (!blobSha) throw denied();
    const blob = (
      await client.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
        ...repository,
        file_sha: blobSha,
      })
    ).data as { sha?: unknown; size?: unknown; encoding?: unknown; content?: unknown };
    if (
      blob.sha !== blobSha ||
      !Number.isSafeInteger(blob.size) ||
      Number(blob.size) < 0 ||
      Number(blob.size) > CONSULTATION_LIMITS.fileBytes ||
      blob.encoding !== "base64" ||
      typeof blob.content !== "string" ||
      blob.content.length > 12_000 ||
      !/^[A-Za-z0-9+/=\r\n]*$/.test(blob.content)
    )
      throw denied();
    const bytes = Buffer.from(blob.content.replaceAll("\n", "").replaceAll("\r", ""), "base64");
    if (
      bytes.length !== blob.size ||
      createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== blobSha ||
      bytes.includes(0)
    )
      throw denied();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw denied();
    }
    if (text.startsWith("version https://git-lfs.github.com/spec/v1")) throw denied();
    return {
      repositoryId: identity.id,
      repository: `${identity.owner}/${identity.name}`,
      commitSha: source.commit_sha,
      path: source.path,
      hash: createHash("sha256").update(bytes).digest("base64url"),
      bytes: bytes.length,
      text,
      identity,
    };
  }
}

/** Revalidate selected connections under row locks without reversing the plan topology/story lock order. */
export async function revalidateConsultationRepositories(
  db: FacilityDb,
  sources: ConsultationSources,
  scope: ConsultationScope,
  identities: ConsultationRepository[],
) {
  const verified = identities.map((identity) => ConsultationRepositorySchema.parse(identity));
  const byId = new Map<string, ConsultationRepository>();
  for (const identity of verified) {
    const previous = byId.get(identity.id);
    if (
      previous &&
      consultationRepositoryFingerprint(previous) !== consultationRepositoryFingerprint(identity)
    )
      throw new ApiError(
        409,
        "consultation_repository_changed",
        "A source repository changed during snapshot preparation",
      );
    byId.set(identity.id, identity);
  }
  const unique = [...byId.values()];
  for (const before of unique.sort((a, b) => a.id.localeCompare(b.id))) {
    const after = await sources.identity(scope, before.id, db);
    if (consultationRepositoryFingerprint(before) !== consultationRepositoryFingerprint(after))
      throw new ApiError(
        409,
        "consultation_repository_changed",
        "A source repository connection changed; prepare a new consultation",
      );
  }
  const ids = unique.filter((r) => r.role === "primary").map((r) => r.id);
  if (ids.length !== 1)
    throw new ApiError(
      409,
      "consultation_catalog_scope_unverified",
      "The canonical agent repository was not verified",
    );
  const [primary] = await db
    .select({ id: projectRepositories.id })
    .from(projectRepositories)
    .where(
      and(
        eq(projectRepositories.orgId, scope.orgId),
        eq(projectRepositories.projectId, scope.projectId),
        eq(projectRepositories.role, "primary"),
        inArray(projectRepositories.id, ids),
      ),
    )
    .limit(1);
  if (!primary)
    throw new ApiError(
      409,
      "consultation_repository_changed",
      "The canonical agent repository changed",
    );
}
