import { type AgentManifest, type AgentManifestSource, parseAgentCatalog } from "@facility/agents";
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
}

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
    const repository = (
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
