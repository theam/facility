import { type FacilityDb, projectRepositories } from "@facility/db";
import { and, asc, eq } from "drizzle-orm";
import {
  AgentCatalogError,
  type AgentCatalogSnapshot,
  type AgentCatalogSource,
  type AgentCatalogUpdate,
} from "../agents/catalog.js";
import { isAgentManifestPath, isProjectSkillPath } from "../agents/catalog-files.js";
import type { GithubGitIdentity } from "../github/git-identity.js";
import type {
  GithubWorkspaceCredentials,
  WorkspaceRepository,
} from "../github/workspace-credentials.js";
import {
  type LocalSnapshotProvider,
  ProjectEnvironmentError,
  type ProjectManifest,
  type ProjectManifestSource,
  parseProjectManifest,
} from "../workspaces/project-environment.js";
import { LocalRepositoryError, type LocalRepositoryHost } from "./local.js";

export type RepositorySource = "github" | "local";
export type ProjectRepositoryRow = typeof projectRepositories.$inferSelect;

/** Local repositories share one owner sentinel that GitHub logins cannot use. */
export const LOCAL_REPOSITORY_OWNER = "_local";

export const DEFAULT_LOCAL_GIT_IDENTITY: GithubGitIdentity = {
  name: "Facility Agent",
  email: "facility-agent@localhost",
};

/** Repository access that a workspace needs before preparation. */
export interface RepositoryAccess {
  issue(orgId: string, projectId: string): Promise<GithubWorkspaceCredentials>;
}

export function isLocalAlias(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) && !/\.git$/i.test(value);
}

export async function projectRepositoryRows(db: FacilityDb, orgId: string, projectId: string) {
  return db
    .select()
    .from(projectRepositories)
    .where(and(eq(projectRepositories.orgId, orgId), eq(projectRepositories.projectId, projectId)))
    .orderBy(
      asc(projectRepositories.role),
      asc(projectRepositories.owner),
      asc(projectRepositories.name),
    );
}

/**
 * The project's repository source is its primary repository's source. Projects
 * never mix sources: a local workflow must not depend on GitHub credentials, and
 * a GitHub workflow keeps its existing single-provider contract.
 */
export function projectSource(rows: Array<Pick<ProjectRepositoryRow, "role" | "source">>) {
  const sources = new Set(rows.map((row) => row.source));
  if (sources.size > 1) {
    throw new ProjectEnvironmentError(
      "repository_sources_mixed",
      "A project's repositories must all be GitHub repositories or all be local repositories",
    );
  }
  return (rows.find((row) => row.role === "primary")?.source ?? "github") as RepositorySource;
}

export async function loadProjectSource(db: FacilityDb, orgId: string, projectId: string) {
  return projectSource(await projectRepositoryRows(db, orgId, projectId));
}

/** Issues GitHub credentials only for GitHub projects. Local projects never reach GitHub. */
export class ProjectRepositoryAccess implements RepositoryAccess {
  constructor(
    private readonly db: FacilityDb,
    private readonly github: RepositoryAccess,
    private readonly localIdentity: GithubGitIdentity = DEFAULT_LOCAL_GIT_IDENTITY,
  ) {}

  async issue(orgId: string, projectId: string): Promise<GithubWorkspaceCredentials> {
    const rows = await projectRepositoryRows(this.db, orgId, projectId);
    if (projectSource(rows) === "github") return this.github.issue(orgId, projectId);
    if (!rows.some((row) => row.role === "primary")) {
      throw new ProjectEnvironmentError(
        "project_repositories_missing",
        "project must have one primary repository",
      );
    }
    return {
      repositories: rows.map(
        (row): WorkspaceRepository => ({
          id: row.id,
          source: "local",
          owner: row.owner,
          name: row.name,
          defaultBranch: row.defaultBranch,
          role: row.role as "primary" | "related",
        }),
      ),
      // Local preparation needs no repository credential. Model credentials stay separate.
      environment: {},
      expiresAt: new Date(8_640_000_000_000_000),
      gitIdentity: this.localIdentity,
    };
  }
}

/** Resolves and packages committed history from registered local repositories. */
export class LocalRepositorySnapshots implements LocalSnapshotProvider {
  constructor(
    private readonly db: FacilityDb,
    readonly host: LocalRepositoryHost,
  ) {}

  async repository(orgId: string, projectId: string, repositoryId?: string) {
    const row = (
      await this.db
        .select()
        .from(projectRepositories)
        .where(
          and(
            eq(projectRepositories.orgId, orgId),
            eq(projectRepositories.projectId, projectId),
            repositoryId
              ? eq(projectRepositories.id, repositoryId)
              : eq(projectRepositories.role, "primary"),
          ),
        )
        .limit(1)
    )[0];
    if (row?.source !== "local" || !row.sourcePath) {
      throw new LocalRepositoryError(
        "local_repository_not_found",
        "Local repository not found in this project",
        404,
      );
    }
    return row as ProjectRepositoryRow & { sourcePath: string };
  }

  async resolve(orgId: string, projectId: string, repositoryId?: string) {
    const row = await this.repository(orgId, projectId, repositoryId);
    return { row, commit: await this.host.resolve(row.sourcePath, row.defaultBranch) };
  }

  async snapshot(orgId: string, projectId: string, repositoryId: string, commit?: string) {
    const row = await this.repository(orgId, projectId, repositoryId);
    const revision = commit ?? (await this.host.resolve(row.sourcePath, row.defaultBranch));
    const [bundle, warnings] = await Promise.all([
      this.host.snapshot(row.sourcePath, revision),
      this.host.warnings(row.sourcePath, revision),
    ]);
    return { commit: revision, branch: row.defaultBranch, bundle, warnings };
  }
}

/** Reads `.facility.yml` from the primary repository's default branch at one pinned commit. */
export class LocalProjectManifestSource implements ProjectManifestSource {
  constructor(private readonly snapshots: LocalRepositorySnapshots) {}

  async load(orgId: string, projectId: string): Promise<ProjectManifest> {
    const { row, commit } = await this.snapshots.resolve(orgId, projectId);
    const source = await this.snapshots.host.readFile(row.sourcePath, commit, ".facility.yml");
    if (source === undefined) {
      throw new ProjectEnvironmentError(
        "project_manifest_not_found",
        `primary repository must contain .facility.yml on ${row.defaultBranch}`,
      );
    }
    return {
      ...parseProjectManifest(source),
      sourceRevision: { repositoryId: row.id, commitSha: commit },
    };
  }
}

/** Reads the committed `.agents` catalog and skills from a local repository. */
export class LocalAgentCatalogSource implements AgentCatalogSource {
  constructor(private readonly snapshots: LocalRepositorySnapshots) {}

  async load(orgId: string, projectId: string): Promise<AgentCatalogSnapshot> {
    try {
      const { row, commit } = await this.snapshots.resolve(orgId, projectId);
      const files = await this.snapshots.host.files(
        row.sourcePath,
        commit,
        [".agents", ".claude/skills"],
        (path) => isAgentManifestPath(path) || isProjectSkillPath(path),
      );
      const entries = [...files.entries()].sort(([left], [right]) => left.localeCompare(right));
      return {
        commitSha: commit,
        sources: entries
          .filter(([path]) => isAgentManifestPath(path))
          .map(([file, source]) => ({ file, source })),
        skills: entries
          .filter(([path]) => isProjectSkillPath(path))
          .map(([file, source]) => ({ file, source })),
      };
    } catch (error) {
      if (error instanceof LocalRepositoryError && error.statusCode === 404) {
        throw new AgentCatalogError("primary_repository_not_found", error.message, 404);
      }
      // Access refusals are never softened into a cached, "temporarily unavailable" read.
      if (error instanceof LocalRepositoryError && [403, 409].includes(error.statusCode)) {
        throw new AgentCatalogError(error.code, error.message, error.statusCode);
      }
      // A temporarily unavailable host path falls back to the last validated projection.
      throw new AgentCatalogError(
        "agent_catalog_unavailable",
        error instanceof Error
          ? `Agent catalog could not be read from the local repository: ${error.message}`
          : "Agent catalog could not be read from the local repository",
        503,
      );
    }
  }
}

export class SourceAwareProjectManifestSource implements ProjectManifestSource {
  constructor(
    private readonly db: FacilityDb,
    private readonly github: ProjectManifestSource,
    private readonly local: ProjectManifestSource,
  ) {}

  async load(orgId: string, projectId: string) {
    return (await loadProjectSource(this.db, orgId, projectId)) === "local"
      ? this.local.load(orgId, projectId)
      : this.github.load(orgId, projectId);
  }
}

export class SourceAwareAgentCatalogSource implements AgentCatalogSource {
  constructor(
    private readonly db: FacilityDb,
    private readonly github: AgentCatalogSource,
    private readonly local: AgentCatalogSource,
  ) {}

  async load(orgId: string, projectId: string) {
    return (await loadProjectSource(this.db, orgId, projectId)) === "local"
      ? this.local.load(orgId, projectId)
      : this.github.load(orgId, projectId);
  }

  async proposeUpdate(orgId: string, projectId: string, input: AgentCatalogUpdate) {
    if (
      (await loadProjectSource(this.db, orgId, projectId)) === "local" ||
      !this.github.proposeUpdate
    ) {
      throw new AgentCatalogError(
        "agent_catalog_read_only",
        "Edit .agents/ in the local repository and commit the change; Facility reads the committed catalog",
        501,
      );
    }
    return this.github.proposeUpdate(orgId, projectId, input);
  }
}
