import {
  type AgentManifest,
  type AgentManifestSource,
  AgentNameSchema,
  parseAgentCatalog,
  parseAgentManifest,
} from "@facility/agents";
import { newId } from "@facility/core";
import {
  agentManifests,
  type FacilityDb,
  githubInstallations,
  projectRepositories,
} from "@facility/db";
import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import { FacilityGithubClient, type GithubClientFactory } from "../github/client.js";
import { readRepoFiles } from "../github/repo-files.js";

export type AgentCatalogSnapshot = {
  commitSha: string;
  sources: AgentManifestSource[];
};

export interface AgentCatalogSource {
  load(orgId: string, projectId: string): Promise<AgentCatalogSnapshot>;
  proposeUpdate?(
    orgId: string,
    projectId: string,
    input: AgentCatalogUpdate,
  ): Promise<AgentCatalogUpdateResult>;
}

export type AgentCatalogUpdate = {
  name: string;
  source: string;
  expectedCommitSha: string;
};

export type AgentCatalogUpdateResult = {
  agent: AgentManifest;
  baseCommitSha: string;
  branch: string;
  commitSha: string;
  pullRequest: { number: number; url: string };
};

export class AgentCatalogError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "AgentCatalogError";
  }
}

/** Reads the canonical .agents directory from the project's primary repository. */
export class GithubAgentCatalogSource implements AgentCatalogSource {
  constructor(
    private readonly db: FacilityDb,
    private readonly factory: GithubClientFactory,
  ) {}

  async load(orgId: string, projectId: string): Promise<AgentCatalogSnapshot> {
    const repository = await this.primaryRepository(orgId, projectId);
    if (!repository) {
      throw new AgentCatalogError(
        "primary_repository_not_found",
        "primary repository not found",
        404,
      );
    }
    if (!repository.installationId) {
      throw new AgentCatalogError(
        "github_installation_missing",
        "primary repository has no GitHub installation",
      );
    }
    const installation = (
      await this.db
        .select()
        .from(githubInstallations)
        .where(
          and(
            eq(githubInstallations.orgId, orgId),
            eq(githubInstallations.id, repository.installationId),
          ),
        )
        .limit(1)
    )[0];
    if (!installation || installation.suspendedAt) {
      throw new AgentCatalogError(
        "github_installation_unavailable",
        "GitHub installation is unavailable",
      );
    }

    try {
      const client = new FacilityGithubClient(await this.factory(installation.installationId), {
        owner: repository.owner,
        repo: repository.name,
        defaultBranch: repository.defaultBranch,
      });
      const commitSha = await client.getDefaultBranchSha();
      const files = await readRepoFiles(client, commitSha, [".agents"]);
      const sources = [...files.entries()]
        .filter(([path]) => /^\.agents\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(path))
        .map(([file, source]) => ({ file, source }))
        .sort((left, right) => left.file.localeCompare(right.file));
      return { commitSha, sources };
    } catch (error) {
      if (error instanceof AgentCatalogError) throw error;
      throw new AgentCatalogError(
        "agent_catalog_unavailable",
        "Agent catalog could not be refreshed from GitHub",
        503,
      );
    }
  }

  async proposeUpdate(
    orgId: string,
    projectId: string,
    input: AgentCatalogUpdate,
  ): Promise<AgentCatalogUpdateResult> {
    const parsedName = AgentNameSchema.safeParse(input.name);
    if (!parsedName.success) {
      throw new AgentCatalogError(
        "agent_name_invalid",
        "Agent names must use lowercase kebab-case characters only",
        400,
      );
    }
    const repository = await this.primaryRepository(orgId, projectId);
    if (!repository?.installationId) {
      throw new AgentCatalogError(
        "primary_repository_not_found",
        "primary repository or GitHub installation not found",
        404,
      );
    }
    const installation = (
      await this.db
        .select()
        .from(githubInstallations)
        .where(
          and(
            eq(githubInstallations.orgId, orgId),
            eq(githubInstallations.id, repository.installationId),
          ),
        )
        .limit(1)
    )[0];
    if (!installation || installation.suspendedAt) {
      throw new AgentCatalogError(
        "github_installation_unavailable",
        "GitHub installation is unavailable",
      );
    }

    const path = `.agents/${parsedName.data}.md`;
    const agent = parseAgentManifest(input.source, path);
    const client = new FacilityGithubClient(await this.factory(installation.installationId), {
      owner: repository.owner,
      repo: repository.name,
      defaultBranch: repository.defaultBranch,
    });
    const baseCommitSha = await client.getDefaultBranchSha();
    if (baseCommitSha !== input.expectedCommitSha) {
      throw new AgentCatalogError(
        "agent_catalog_changed",
        "The agent catalog changed in Git. Refresh the page and apply the edit again.",
      );
    }
    const current = (await readRepoFiles(client, baseCommitSha, [path])).get(path);
    if (!current) throw new AgentCatalogError("agent_not_found", "agent not found", 404);
    const branch = `facility/agent-${parsedName.data}`;
    const existing = (
      await client.listOpenPullRequestsForHead(branch, repository.defaultBranch)
    )[0];
    if (!existing && parseAgentManifest(current, path).hash === agent.hash) {
      throw new AgentCatalogError("agent_manifest_unchanged", "The agent manifest is unchanged");
    }

    if (existing) {
      const proposed = (await readRepoFiles(client, existing.headSha, [path])).get(path);
      if (proposed && parseAgentManifest(proposed, path).hash === agent.hash) {
        return {
          agent,
          baseCommitSha,
          branch,
          commitSha: existing.headSha,
          pullRequest: { number: existing.number, url: existing.url },
        };
      }
    }

    const parentSha = existing?.headSha ?? baseCommitSha;
    const parentCommit = await client.getCommit(parentSha);
    const blobSha = await client.createBlob(input.source);
    const treeSha = await client.createTree(parentCommit.treeSha, [
      { path, mode: "100644", type: "blob", sha: blobSha },
    ]);
    const commitSha = await client.createCommit(
      `feat: update ${parsedName.data} Facility agent`,
      treeSha,
      [parentSha],
    );
    if (existing) {
      await client.updateBranch(branch, commitSha);
    } else {
      try {
        await client.createBranch(branch, commitSha);
      } catch (error) {
        if ((error as { status?: number }).status !== 422) throw error;
        throw new AgentCatalogError(
          "agent_proposal_branch_exists",
          `Branch ${branch} already exists without an open pull request; resolve it in GitHub before retrying`,
        );
      }
    }
    const pullRequest =
      existing ??
      (await client.createPullRequest({
        title: `feat: update ${parsedName.data} Facility agent`,
        body: [
          `Updates \`${path}\` through Facility's shared manifest validator.`,
          "",
          `Base catalog commit: \`${baseCommitSha}\``,
          `Manifest hash: \`${agent.hash}\``,
          "",
          "Facility does not merge this pull request automatically.",
        ].join("\n"),
        head: branch,
      }));
    return {
      agent,
      baseCommitSha,
      branch,
      commitSha,
      pullRequest: { number: pullRequest.number, url: pullRequest.url },
    };
  }

  private async primaryRepository(orgId: string, projectId: string) {
    return (
      await this.db
        .select()
        .from(projectRepositories)
        .where(
          and(
            eq(projectRepositories.orgId, orgId),
            eq(projectRepositories.projectId, projectId),
            eq(projectRepositories.role, "primary"),
          ),
        )
        .limit(1)
    )[0];
  }
}

/** Materialized projection. Git remains the only source of truth for agent configuration. */
export class AgentCatalogService {
  constructor(
    private readonly db: FacilityDb,
    private readonly source: AgentCatalogSource,
  ) {}

  async sync(orgId: string, projectId: string): Promise<AgentManifest[]> {
    const snapshot = await this.source.load(orgId, projectId);
    const manifests = parseAgentCatalog(snapshot.sources);
    await this.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as FacilityDb;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`facility:agents:${orgId}:${projectId}`}))`,
      );
      for (const manifest of manifests) {
        await tx
          .insert(agentManifests)
          .values({
            id: newId("amf"),
            orgId,
            projectId,
            name: manifest.name,
            commitSha: snapshot.commitSha,
            path: manifest.file,
            contentHash: manifest.hash,
            manifest,
            syncedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [agentManifests.projectId, agentManifests.name],
            set: {
              commitSha: snapshot.commitSha,
              path: manifest.file,
              contentHash: manifest.hash,
              manifest,
              syncedAt: new Date(),
              updatedAt: new Date(),
            },
          });
      }
      const scope = and(eq(agentManifests.orgId, orgId), eq(agentManifests.projectId, projectId));
      await tx.delete(agentManifests).where(
        manifests.length > 0
          ? and(
              scope,
              notInArray(
                agentManifests.name,
                manifests.map((manifest) => manifest.name),
              ),
            )
          : scope,
      );
    });
    return manifests;
  }

  async list(orgId: string, projectId: string, options: { refresh?: boolean } = {}) {
    if (options.refresh !== false) {
      try {
        await this.sync(orgId, projectId);
      } catch (error) {
        if (!isRefreshUnavailable(error)) throw error;
        const cached = await this.listCached(orgId, projectId);
        if (cached.length > 0) return cached;
        throw error;
      }
    }
    return this.listCached(orgId, projectId);
  }

  private listCached(orgId: string, projectId: string) {
    return this.db
      .select()
      .from(agentManifests)
      .where(and(eq(agentManifests.orgId, orgId), eq(agentManifests.projectId, projectId)))
      .orderBy(asc(agentManifests.name));
  }

  async get(orgId: string, projectId: string, name: string, options: { refresh?: boolean } = {}) {
    if (options.refresh !== false) {
      try {
        await this.sync(orgId, projectId);
      } catch (error) {
        if (!isRefreshUnavailable(error)) throw error;
        const cached = await this.getCached(orgId, projectId, name);
        if (cached) return cached;
        throw error;
      }
    }
    const row = await this.getCached(orgId, projectId, name);
    if (!row) throw new AgentCatalogError("agent_not_found", "agent not found", 404);
    return row;
  }

  private async getCached(orgId: string, projectId: string, name: string) {
    const row = (
      await this.db
        .select()
        .from(agentManifests)
        .where(
          and(
            eq(agentManifests.orgId, orgId),
            eq(agentManifests.projectId, projectId),
            eq(agentManifests.name, name),
          ),
        )
        .limit(1)
    )[0];
    return row;
  }

  async proposeUpdate(orgId: string, projectId: string, input: AgentCatalogUpdate) {
    if (!this.source.proposeUpdate) {
      throw new AgentCatalogError(
        "agent_catalog_read_only",
        "This agent catalog source does not support Git proposals",
        501,
      );
    }
    return this.source.proposeUpdate(orgId, projectId, input);
  }
}

function isRefreshUnavailable(error: unknown): error is AgentCatalogError {
  return (
    error instanceof AgentCatalogError &&
    [
      "agent_catalog_unavailable",
      "github_installation_missing",
      "github_installation_unavailable",
    ].includes(error.code)
  );
}

export function manifestFromProjection(row: typeof agentManifests.$inferSelect): AgentManifest {
  return row.manifest as AgentManifest;
}
