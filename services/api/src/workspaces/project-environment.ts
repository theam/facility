import { createHash, randomUUID } from "node:crypto";
import { newId } from "@facility/core";
import type { FacilityDb } from "@facility/db";
import { githubInstallations, projectRepositories, storyArtifacts, workspaces } from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import { parseDocument } from "yaml";
import { z } from "zod";
import { FacilityGithubClient, type GithubClientFactory } from "../github/client.js";
import { decodeContent } from "../github/repo-files.js";
import type {
  GithubWorkspaceCredentials,
  WorkspaceRepository,
} from "../github/workspace-credentials.js";
import { appendWorkspaceEvent } from "./events.js";
import { isSafeGitBranch } from "./git-branch.js";
import type {
  CreateWorkspace,
  PreviewEndpoint,
  WorkspaceCommandResult,
  WorkspaceLocator,
  WorkspaceRuntime,
} from "./runtime.js";

/**
 * `github.com/owner/name` names a GitHub repository. `local:alias` names a local
 * repository by the alias it was registered under, so machine paths stay out of
 * the committed manifest.
 */
const RepositoryName = z
  .string()
  .min(3)
  .max(240)
  .transform((value, context) => {
    const local = /^local:([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/.exec(value);
    if (local?.[1] && !/\.git$/i.test(local[1])) return `local:${local[1]}`;
    const match =
      /^(?:https:\/\/)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
    if (!match) {
      context.addIssue({
        code: "custom",
        message: "must be github.com/owner/repository or local:alias",
      });
      return z.NEVER;
    }
    return `${match[1]}/${match[2]}`;
  });

const ServiceSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    protocol: z.enum(["http", "https"]).default("http"),
    websocket: z.boolean().default(true),
  })
  .strict();

const EnvironmentName = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);

export const ProjectManifestSchema = z
  .object({
    version: z.literal(1).default(1),
    repositories: z
      .object({
        primary: RepositoryName,
        related: z.array(RepositoryName).default([]),
      })
      .strict(),
    environment: z
      .object({
        image: z.string().min(1).max(500).optional(),
        resources: z
          .object({
            cpu: z.number().int().min(1).max(32),
            memory_mb: z.number().int().min(512).max(65_536),
          })
          .strict()
          .optional(),
        setup: z.string().min(1).max(4_000).optional(),
        start: z.string().min(1).max(4_000),
        ready: z.string().min(1).max(4_000).optional(),
        stop: z.string().min(1).max(4_000).optional(),
        seed: z.string().min(1).max(4_000).optional(),
        browser_test: z.string().min(1).max(4_000).optional(),
        /** Named review checks, run on request against the story's current commit. */
        checks: z
          .record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), z.string().min(1).max(4_000))
          .refine((checks) => Object.keys(checks).length <= 20, "at most 20 checks")
          .optional(),
        secrets: z.array(EnvironmentName).default([]),
        variables: z.array(EnvironmentName).default([]),
        services: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), ServiceSchema).default({}),
      })
      .strict(),
  })
  .strict();

export type ProjectManifest = z.infer<typeof ProjectManifestSchema> & {
  hash: string;
  /** Local sources: the primary repository commit this manifest was read from. */
  sourceRevision?: { repositoryId: string; commitSha: string };
};

/** Packages committed local history for import into a workspace. */
export interface LocalSnapshotProvider {
  snapshot(
    orgId: string,
    projectId: string,
    repositoryId: string,
    commit?: string,
  ): Promise<{ commit: string; branch: string; bundle: Buffer; warnings: string[] }>;
}

export type LocalCheckResult = {
  name: string;
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
};

/** One creation contract for API/UI/MCP, GitHub triggers and scheduled stories. */
export function projectWorkspaceInput(
  manifest: ProjectManifest,
  defaultImage: string,
): Omit<CreateWorkspace, "id"> {
  const resources = manifest.environment.resources;
  return {
    image: manifest.environment.image ?? defaultImage,
    ...(resources ? { resources: { cpu: resources.cpu, memoryMb: resources.memory_mb } } : {}),
    ports: Object.entries(manifest.environment.services).map(([service, value]) => ({
      service,
      port: value.port,
      protocol: value.protocol,
      websocket: value.websocket,
    })),
  };
}

export class ProjectEnvironmentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ProjectEnvironmentError";
  }
}

export function parseProjectManifest(source: string): ProjectManifest {
  const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new ProjectEnvironmentError(
      "project_manifest_invalid",
      document.errors.map((error) => error.message).join("; "),
    );
  }
  const result = ProjectManifestSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!result.success) {
    throw new ProjectEnvironmentError(
      "project_manifest_invalid",
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
        .join("; "),
    );
  }
  return {
    ...result.data,
    hash: createHash("sha256").update(source.replace(/\r\n?/g, "\n")).digest("hex"),
  };
}

export interface ProjectManifestSource {
  load(orgId: string, projectId: string): Promise<ProjectManifest>;
}

export class GithubProjectManifestSource implements ProjectManifestSource {
  constructor(
    private readonly db: FacilityDb,
    private readonly factory: GithubClientFactory,
  ) {}

  async load(orgId: string, projectId: string) {
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
    if (!repository?.installationId) {
      throw new ProjectEnvironmentError(
        "primary_repository_not_found",
        "project primary repository or GitHub installation is missing",
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
      throw new ProjectEnvironmentError(
        "github_installation_unavailable",
        "GitHub installation is unavailable",
      );
    }
    const client = new FacilityGithubClient(await this.factory(installation.installationId), {
      owner: repository.owner,
      repo: repository.name,
      defaultBranch: repository.defaultBranch,
    });
    const content = (await client.getContent(".facility.yml", repository.defaultBranch)) as {
      type?: string;
      content?: string;
      encoding?: string;
    };
    if (content.type !== "file" || typeof content.content !== "string") {
      throw new ProjectEnvironmentError(
        "project_manifest_not_found",
        "primary repository must contain .facility.yml",
      );
    }
    return parseProjectManifest(decodeContent(content.content, content.encoding));
  }
}

type EnvironmentInput = {
  orgId: string;
  projectId: string;
  workspace: WorkspaceLocator;
  manifest: ProjectManifest;
  credentials: GithubWorkspaceCredentials;
  readinessTimeoutMs?: number;
};

export class ProjectEnvironmentService {
  constructor(
    private readonly db: FacilityDb,
    private readonly runtime: WorkspaceRuntime,
    private readonly gitBaseUrl = "https://github.com",
    private readonly environmentValue: (projectId: string, name: string) => string | undefined = (
      projectId,
      name,
    ) => process.env[projectEnvironmentVariableName(projectId, name)],
    private readonly workspaceValues: (scope: {
      orgId: string;
      projectId: string;
      workspaceId: string;
    }) => Promise<Record<string, string>> = async () => ({}),
    private readonly localSnapshots?: LocalSnapshotProvider,
  ) {}

  async prepare(
    input: EnvironmentInput & {
      branch: string;
      previousSetupChecksum?: string | null;
      cleanSetup?: boolean;
    },
  ) {
    assertRepositoryContract(input.manifest, input.credentials.repositories);
    const preparedInput = await this.withDeclaredEnvironment(input);
    await this.run(preparedInput, "mkdir -p repos", ".", "environment.repositories");
    for (const repository of preparedInput.credentials.repositories) {
      await this.runCommand(
        preparedInput,
        "mkdir",
        ["-p", `repos/${repository.owner}`],
        ".",
        "repository directory",
      );
      const cwd = repositoryPath(repository);
      const present = await this.runtime.exec(preparedInput.workspace, {
        command: "git",
        args: ["-C", cwd, "rev-parse", "--git-dir"],
        env: preparedInput.credentials.environment,
      });
      if (repository.source === "local") {
        // Later turns keep the workspace's history. Refreshing from the host is explicit.
        // The source ref, not the directory, marks a completed import: an interrupted
        // import leaves an empty repository that must be imported again.
        const imported =
          present.exitCode === 0 &&
          (
            await this.runtime.exec(preparedInput.workspace, {
              command: "git",
              args: [
                "-C",
                cwd,
                "rev-parse",
                "--verify",
                "--quiet",
                `${localSourceRef(repository)}^{commit}`,
              ],
              env: preparedInput.credentials.environment,
            })
          ).exitCode === 0;
        if (!imported) {
          const pinned = preparedInput.manifest.sourceRevision;
          await this.importLocal(
            preparedInput,
            repository,
            cwd,
            pinned && pinned.repositoryId === repository.id ? pinned.commitSha : undefined,
          );
        }
      } else {
        if (present.exitCode !== 0) {
          await this.runCommand(
            preparedInput,
            "git",
            ["clone", `${this.gitBaseUrl}/${repository.owner}/${repository.name}.git`, cwd],
            ".",
            `clone ${repository.owner}/${repository.name}`,
          );
        }
        await this.runCommand(
          preparedInput,
          "git",
          ["fetch", "--all", "--prune"],
          cwd,
          "git fetch",
        );
      }
      await this.runCommand(
        preparedInput,
        "git",
        ["config", "user.name", preparedInput.credentials.gitIdentity.name],
        cwd,
        "git identity",
      );
      await this.runCommand(
        preparedInput,
        "git",
        ["config", "user.email", preparedInput.credentials.gitIdentity.email],
        cwd,
        "git identity",
      );
      if (repository.role === "primary") await this.ensureBranch(preparedInput, repository, cwd);
    }

    const setupChecksum = await this.setupChecksum(preparedInput);
    const setupRequired = input.cleanSetup || input.previousSetupChecksum !== setupChecksum;
    if (setupRequired) {
      if (preparedInput.manifest.environment.setup) {
        await this.run(
          preparedInput,
          preparedInput.manifest.environment.setup,
          primaryPath(preparedInput.credentials),
          "environment.setup",
        );
        if (preparedInput.manifest.environment.seed) {
          await this.run(
            preparedInput,
            preparedInput.manifest.environment.seed,
            primaryPath(preparedInput.credentials),
            "environment.seed",
          );
        }
      }
      await this.db
        .update(workspaces)
        .set({ setupChecksum, updatedAt: new Date() })
        .where(
          and(
            eq(workspaces.orgId, preparedInput.orgId),
            eq(workspaces.id, preparedInput.workspace.id),
          ),
        );
    }
    return this.startServices(preparedInput, setupChecksum);
  }

  /** Reuse the agent's files and data; preview access must never prepare Git or reseed. */
  async startPrepared(input: EnvironmentInput & { setupChecksum: string }) {
    assertRepositoryContract(input.manifest, input.credentials.repositories);
    const preparedInput = await this.withDeclaredEnvironment(input);
    const ready = preparedInput.manifest.environment.ready;
    const alreadyReady = ready
      ? (await this.command(preparedInput, ready, primaryPath(preparedInput.credentials)))
          .exitCode === 0
      : false;
    return this.startServices(preparedInput, input.setupChecksum, alreadyReady);
  }

  private async startServices(
    preparedInput: EnvironmentInput,
    setupChecksum: string,
    alreadyReady = false,
  ) {
    if (!alreadyReady) {
      await this.run(
        preparedInput,
        preparedInput.manifest.environment.start,
        primaryPath(preparedInput.credentials),
        "environment.start",
      );
      if (preparedInput.manifest.environment.ready) await this.waitUntilReady(preparedInput);
    }
    const endpoints = await this.runtime.expose(
      preparedInput.workspace,
      services(preparedInput.manifest),
    );
    const setupOrigins = preparedInput.credentials.environment.FACILITY_PREVIEW_ORIGINS;
    if (setupOrigins) {
      const origins = JSON.parse(setupOrigins) as Record<string, string>;
      for (const [service, origin] of Object.entries(origins)) {
        if (
          !endpoints.some(
            (endpoint) =>
              endpoint.service === service &&
              endpoint.access === "native" &&
              endpoint.url === origin,
          )
        )
          throw new ProjectEnvironmentError(
            "project_preview_origin_changed",
            "Preview origin changed during setup; refusing to publish a mismatched application",
          );
      }
    }
    await this.db
      .update(workspaces)
      .set({
        endpoints,
        state: "running",
        error: null,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaces.orgId, preparedInput.orgId),
          eq(workspaces.id, preparedInput.workspace.id),
        ),
      );
    await appendWorkspaceEvent(
      this.db,
      preparedInput.workspace.id,
      preparedInput.orgId,
      "environment.ready",
      {
        services: endpoints.map((endpoint) => ({ service: endpoint.service, port: endpoint.port })),
        setupChecksum,
      },
    );
    return {
      endpoints,
      primaryCwd: primaryPath(preparedInput.credentials),
      setupChecksum,
      processEnvironment: preparedInput.credentials.environment,
      secretNames: preparedInput.manifest.environment.secrets,
    };
  }

  async runBrowserTest(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    turnId?: string;
    workspace: WorkspaceLocator;
    manifest: ProjectManifest;
    credentials: GithubWorkspaceCredentials;
  }) {
    const script = input.manifest.environment.browser_test;
    if (!script) {
      throw new ProjectEnvironmentError(
        "browser_test_not_configured",
        ".facility.yml does not define environment.browser_test",
      );
    }
    const preparedInput = await this.withDeclaredEnvironment({ ...input, branch: "browser-test" });
    const artifactDirectory = `.facility/artifacts/browser-${Date.now()}`;
    await this.runCommand(
      preparedInput,
      "mkdir",
      ["-p", artifactDirectory],
      primaryPath(preparedInput.credentials),
      "browser artifact directory",
    );
    const result = await this.runtime.exec(input.workspace, {
      command: "sh",
      args: ["-lc", script],
      cwd: primaryPath(preparedInput.credentials),
      env: {
        ...preparedInput.credentials.environment,
        FACILITY_ARTIFACT_DIR: artifactDirectory,
      },
      timeoutMs: 30 * 60 * 1_000,
    });
    const safeResult = redactResult(
      result,
      preparedInput.credentials.environment,
      preparedInput.manifest.environment.secrets,
    );
    if (result.exitCode !== 0) throw commandFailure("environment.browser_test", script, safeResult);
    const files = await this.runtime.exec(input.workspace, {
      command: "find",
      args: [artifactDirectory, "-type", "f", "-maxdepth", "2", "-print"],
      cwd: primaryPath(preparedInput.credentials),
      env: preparedInput.credentials.environment,
    });
    const artifacts = files.stdout
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => ({
        id: newId("art"),
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: input.storyId,
        turnId: input.turnId,
        kind: path.endsWith(".png") ? "screenshot" : path.includes("trace") ? "trace" : "report",
        label: path.split("/").at(-1) ?? "browser artifact",
        uri: `workspace://${input.workspace.id}/${primaryPath(preparedInput.credentials)}/${path}`,
        metadata: { path },
      }));
    if (artifacts.length > 0) await this.db.insert(storyArtifacts).values(artifacts);
    await appendWorkspaceEvent(
      this.db,
      input.workspace.id,
      input.orgId,
      "environment.browser_test",
      {
        exitCode: result.exitCode,
        stdout: tail(safeResult.stdout),
        stderr: tail(safeResult.stderr),
        durationMs: result.durationMs,
        artifacts: artifacts.map((artifact) => artifact.uri),
      },
    );
    return { result: safeResult, artifacts };
  }

  private async withDeclaredEnvironment<
    T extends {
      orgId: string;
      projectId: string;
      workspace: WorkspaceLocator;
      manifest: ProjectManifest;
      credentials: GithubWorkspaceCredentials;
    },
  >(input: T): Promise<T> {
    const managed = await this.workspaceValues({
      orgId: input.orgId,
      projectId: input.projectId,
      workspaceId: input.workspace.id,
    });
    const names = [...input.manifest.environment.variables, ...input.manifest.environment.secrets];
    const originsName = "FACILITY_PREVIEW_ORIGINS";
    const origins = names.includes(originsName)
      ? await this.runtime.previewOrigins?.(input.workspace, services(input.manifest))
      : undefined;
    const originsValue =
      origins && Object.keys(origins).length ? JSON.stringify(origins) : undefined;
    const values: Record<string, string> = {};
    const missing: Array<{ name: string; operatorName: string }> = [];
    for (const name of names) {
      const operatorName = projectEnvironmentVariableName(input.projectId, name);
      // This reserved value comes only from the scoped runtime, never operator,
      // managed or repository credentials. Unsupported/opted-out providers fail
      // only manifests that explicitly request it; legacy projects are unchanged.
      const value =
        name === originsName
          ? originsValue
          : (managed[name] ?? this.environmentValue(input.projectId, name));
      if (value === undefined) missing.push({ name, operatorName });
      else values[name] = value;
    }
    if (missing.length > 0) {
      throw new ProjectEnvironmentError(
        "project_environment_missing",
        `Required project environment is missing: ${missing.map(({ name }) => name).join(", ")}`,
        { missing },
      );
    }
    const environment = { ...input.credentials.environment, ...values, ...managed };
    delete environment[originsName];
    if (originsValue !== undefined) environment[originsName] = originsValue;
    return {
      ...input,
      manifest: {
        ...input.manifest,
        environment: {
          ...input.manifest.environment,
          secrets: [...new Set([...input.manifest.environment.secrets, ...Object.keys(managed)])],
        },
      },
      credentials: {
        ...input.credentials,
        environment,
      },
    };
  }

  private async setupChecksum(input: EnvironmentInput) {
    const head = await this.runtime.exec(input.workspace, {
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: primaryPath(input.credentials),
      env: input.credentials.environment,
    });
    if (head.exitCode !== 0) {
      throw commandFailure(
        "environment.setup_checksum",
        "git rev-parse HEAD",
        redactResult(head, input.credentials.environment, input.manifest.environment.secrets),
      );
    }
    return createHash("sha256")
      .update(`${input.manifest.hash}:${head.stdout.trim()}`)
      .digest("hex");
  }

  private async ensureBranch(
    input: Parameters<ProjectEnvironmentService["prepare"]>[0],
    repository: WorkspaceRepository,
    cwd: string,
  ) {
    if (!isSafeGitBranch(input.branch)) {
      throw new ProjectEnvironmentError("story_branch_invalid", "story branch is invalid");
    }
    const local = await this.runtime.exec(input.workspace, {
      command: "git",
      args: ["show-ref", "--verify", `refs/heads/${input.branch}`],
      cwd,
      env: input.credentials.environment,
    });
    if (repository.source === "local") {
      // A local story branch starts at the imported source commit and is never reset.
      await this.runCommand(
        input,
        "git",
        local.exitCode === 0
          ? ["switch", input.branch]
          : ["switch", "-c", input.branch, localSourceRef(repository)],
        cwd,
        "git branch",
      );
      return;
    }
    const remote = await this.runtime.exec(input.workspace, {
      command: "git",
      args: ["show-ref", "--verify", `refs/remotes/origin/${input.branch}`],
      cwd,
      env: input.credentials.environment,
    });
    await this.runCommand(
      input,
      "git",
      local.exitCode === 0
        ? ["switch", input.branch]
        : remote.exitCode === 0
          ? ["switch", "-c", input.branch, "--track", `origin/${input.branch}`]
          : ["switch", "-c", input.branch, `origin/${repository.defaultBranch}`],
      cwd,
      "git branch",
    );
  }

  /**
   * Imports a pinned local commit into a new workspace repository. The host
   * repository is only read; history arrives as a Git bundle and the imported
   * commit is recorded on the workspace.
   */
  private async importLocal(
    input: EnvironmentInput,
    repository: WorkspaceRepository,
    cwd: string,
    revision?: string,
  ) {
    const snapshot = await this.localSnapshot(input, repository, revision);
    await this.runCommand(input, "git", ["init", "--quiet", cwd], ".", "local import");
    await this.fetchLocalBundle(input, repository, cwd, snapshot.bundle);
    // Story branches live under facility/. A default branch named `facility` (or
    // inside facility/) would block them, so it is not materialized; the imported
    // source ref remains the base either way.
    await this.runCommand(
      input,
      "git",
      storyNamespaceConflict(repository.defaultBranch)
        ? ["checkout", "--quiet", "--detach", localSourceRef(repository)]
        : ["checkout", "--quiet", "-B", repository.defaultBranch, localSourceRef(repository)],
      cwd,
      "local import",
    );
    await this.recordSourceRevision(input, repository, snapshot.commit);
    await appendWorkspaceEvent(this.db, input.workspace.id, input.orgId, "source.imported", {
      repositoryId: repository.id,
      repository: repository.name,
      branch: repository.defaultBranch,
      revision: snapshot.commit,
      warnings: snapshot.warnings,
    });
  }

  /**
   * Explicitly imports the local repository's current default-branch commit as the
   * workspace's new source base. The story branch is never moved; the workspace's
   * copy of the default branch only fast-forwards when it has not diverged.
   */
  async refreshLocalSource(input: EnvironmentInput & { repositoryId: string }) {
    const repository = input.credentials.repositories.find(
      (candidate) => candidate.id === input.repositoryId && candidate.source === "local",
    );
    if (!repository) {
      throw new ProjectEnvironmentError(
        "local_repository_not_found",
        "Local repository not found in this project",
      );
    }
    const cwd = repositoryPath(repository);
    const previous = (await this.sourceRevisions(input))[input.repositoryId];
    if (!previous) {
      throw new ProjectEnvironmentError(
        "workspace_not_prepared",
        "The workspace has not imported this repository yet; start a turn first",
      );
    }
    const snapshot = await this.localSnapshot(input, repository);
    if (snapshot.commit === previous.revision) {
      return {
        previous: previous.revision,
        revision: snapshot.commit,
        defaultBranchUpdated: false,
      };
    }
    await this.fetchLocalBundle(input, repository, cwd, snapshot.bundle);
    const current = (
      await this.runtime.exec(input.workspace, {
        command: "git",
        args: ["branch", "--show-current"],
        cwd,
        env: input.credentials.environment,
      })
    ).stdout.trim();
    const updated =
      current === repository.defaultBranch
        ? await this.runtime.exec(input.workspace, {
            command: "git",
            args: ["merge", "--ff-only", "--quiet", localSourceRef(repository)],
            cwd,
            env: input.credentials.environment,
          })
        : await this.runtime.exec(input.workspace, {
            command: "git",
            args: [
              "update-ref",
              `refs/heads/${repository.defaultBranch}`,
              snapshot.commit,
              previous.revision,
            ],
            cwd,
            env: input.credentials.environment,
          });
    await this.recordSourceRevision(input, repository, snapshot.commit, previous.initialRevision);
    await appendWorkspaceEvent(this.db, input.workspace.id, input.orgId, "source.refreshed", {
      repositoryId: repository.id,
      repository: repository.name,
      previous: previous.revision,
      revision: snapshot.commit,
      defaultBranchUpdated: updated.exitCode === 0,
      warnings: snapshot.warnings,
    });
    return {
      previous: previous.revision,
      revision: snapshot.commit,
      defaultBranchUpdated: updated.exitCode === 0,
    };
  }

  /** Runs every configured check in the primary repository and reports the tested commit. */
  async runChecks(input: EnvironmentInput) {
    const checks = Object.entries(input.manifest.environment.checks ?? {});
    if (checks.length === 0) {
      throw new ProjectEnvironmentError(
        "checks_not_configured",
        ".facility.yml does not define environment.checks",
      );
    }
    const preparedInput = await this.withDeclaredEnvironment(input);
    const cwd = primaryPath(preparedInput.credentials);
    const commitSha = await this.gitOutput(preparedInput, cwd, ["rev-parse", "HEAD"]);
    const dirty = (await this.gitOutput(preparedInput, cwd, ["status", "--porcelain"])) !== "";
    const results: LocalCheckResult[] = [];
    for (const [name, command] of checks) {
      const result = redactResult(
        await this.command(preparedInput, command, cwd),
        preparedInput.credentials.environment,
        preparedInput.manifest.environment.secrets,
      );
      results.push({
        name,
        command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: tail(result.stdout),
        stderr: tail(result.stderr),
      });
    }
    const after = await this.gitOutput(preparedInput, cwd, ["rev-parse", "HEAD"]);
    return { commitSha, dirty, commitChanged: after !== commitSha, results };
  }

  async sourceRevisions(input: { orgId: string; workspace: WorkspaceLocator }) {
    const row = (
      await this.db
        .select({ sourceRevisions: workspaces.sourceRevisions })
        .from(workspaces)
        .where(and(eq(workspaces.orgId, input.orgId), eq(workspaces.id, input.workspace.id)))
        .limit(1)
    )[0];
    return row?.sourceRevisions ?? {};
  }

  private async localSnapshot(
    input: EnvironmentInput,
    repository: WorkspaceRepository,
    revision?: string,
  ) {
    if (!this.localSnapshots || !repository.id) {
      throw new ProjectEnvironmentError(
        "local_repositories_disabled",
        "Local repositories are not enabled on this Facility instance",
      );
    }
    if (this.runtime.provider === "vercel") {
      throw new ProjectEnvironmentError(
        "local_source_requires_docker",
        "Local repositories run in Docker workspaces; set FACILITY_WORKSPACE_DRIVER=docker",
      );
    }
    return this.localSnapshots.snapshot(input.orgId, input.projectId, repository.id, revision);
  }

  private async fetchLocalBundle(
    input: EnvironmentInput,
    repository: WorkspaceRepository,
    cwd: string,
    bundle: Buffer,
  ) {
    const staging = `.facility/imports/${randomUUID()}`;
    await this.runCommand(
      input,
      "sh",
      ["-c", 'mkdir -p .facility/imports && : > "$1.b64"', "sh", staging],
      ".",
      "local import",
    );
    try {
      // Encoding chunk by chunk keeps every string small: a repository bundle can
      // exceed V8's maximum string length once base64-encoded as a whole.
      for (const chunk of base64Chunks(bundle)) {
        const appended = await this.runtime.exec(input.workspace, {
          command: "sh",
          args: ["-c", 'cat >> "$1.b64"', "sh", staging],
          stdin: chunk,
          timeoutMs: 10 * 60 * 1_000,
        });
        if (appended.exitCode !== 0) throw commandFailure("local import", "stage bundle", appended);
      }
      await this.runCommand(
        input,
        "sh",
        ["-c", 'base64 -d "$1.b64" > "$1.bundle"', "sh", staging],
        ".",
        "local import",
      );
      const depth = cwd.split("/").length;
      await this.runCommand(
        input,
        "git",
        [
          "fetch",
          "--quiet",
          "--no-tags",
          `${"../".repeat(depth)}${staging}.bundle`,
          `+refs/facility/import:${localSourceRef(repository)}`,
        ],
        cwd,
        "local import",
      );
    } finally {
      await this.runtime
        .exec(input.workspace, {
          command: "rm",
          args: ["-f", `${staging}.b64`, `${staging}.bundle`],
        })
        .catch(() => undefined);
    }
  }

  private async recordSourceRevision(
    input: EnvironmentInput,
    repository: WorkspaceRepository,
    revision: string,
    initialRevision = revision,
  ) {
    if (!repository.id) return;
    const entry = {
      [repository.id]: {
        revision,
        initialRevision,
        branch: repository.defaultBranch,
        importedAt: new Date().toISOString(),
      },
    };
    await this.db
      .update(workspaces)
      .set({
        sourceRevisions: sql`${workspaces.sourceRevisions} || ${JSON.stringify(entry)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(workspaces.orgId, input.orgId), eq(workspaces.id, input.workspace.id)));
  }

  private async gitOutput(input: EnvironmentInput, cwd: string, args: string[]) {
    return (await this.runCommand(input, "git", args, cwd, `git ${args[0]}`)).stdout.trim();
  }

  private async waitUntilReady(input: EnvironmentInput) {
    const ready = input.manifest.environment.ready;
    if (!ready) return;
    const deadline = Date.now() + (input.readinessTimeoutMs ?? 120_000);
    let last: WorkspaceCommandResult | undefined;
    while (Date.now() < deadline) {
      last = await this.command(input, ready, primaryPath(input.credentials));
      if (last.exitCode === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new ProjectEnvironmentError("environment_not_ready", "environment readiness timed out", {
      command: input.manifest.environment.ready,
      exitCode: last?.exitCode,
      stderr: tail(
        redactCredentials(
          last?.stderr ?? "",
          input.credentials.environment,
          input.manifest.environment.secrets,
        ),
      ),
    });
  }

  private async run(input: EnvironmentInput, script: string, cwd: string, phase: string) {
    const result = await this.command(input, script, cwd);
    const safeResult = redactResult(
      result,
      input.credentials.environment,
      input.manifest.environment.secrets,
    );
    await appendWorkspaceEvent(this.db, input.workspace.id, input.orgId, phase, {
      command: script,
      exitCode: result.exitCode,
      stdout: tail(safeResult.stdout),
      stderr: tail(safeResult.stderr),
      durationMs: result.durationMs,
    });
    if (result.exitCode !== 0) throw commandFailure(phase, script, safeResult);
    return result;
  }

  private command(input: EnvironmentInput, script: string, cwd: string) {
    return this.runtime.exec(input.workspace, {
      command: "sh",
      args: ["-lc", script],
      cwd,
      env: input.credentials.environment,
      timeoutMs: 30 * 60 * 1_000,
    });
  }

  private async runCommand(
    input: EnvironmentInput,
    command: string,
    args: string[],
    cwd: string,
    phase: string,
  ) {
    const result = await this.runtime.exec(input.workspace, {
      command,
      args,
      cwd,
      env: input.credentials.environment,
      timeoutMs: 30 * 60 * 1_000,
    });
    if (result.exitCode !== 0) {
      throw commandFailure(
        phase,
        [command, ...args].join(" "),
        redactResult(result, input.credentials.environment, input.manifest.environment.secrets),
      );
    }
    return result;
  }
}

/**
 * Base64 encodes a buffer in pieces whose concatenation equals encoding it whole.
 * Raw slices are a multiple of 3 bytes, so no piece carries padding except the last.
 */
export function* base64Chunks(buffer: Buffer, rawChunkBytes = 3 * 1024 * 1024) {
  if (rawChunkBytes <= 0 || rawChunkBytes % 3 !== 0) {
    throw new RangeError("base64 chunks must be a positive multiple of 3 bytes");
  }
  for (let offset = 0; offset < buffer.length; offset += rawChunkBytes) {
    yield buffer.subarray(offset, offset + rawChunkBytes).toString("base64");
  }
}

export function projectEnvironmentVariableName(projectId: string, name: string) {
  if (!/^[a-z0-9_]{1,100}$/.test(projectId)) {
    throw new ProjectEnvironmentError("project_id_invalid", "project id is invalid");
  }
  return `FACILITY_PROJECT_${projectId.toUpperCase()}_${EnvironmentName.parse(name)}`;
}

/** The name a manifest uses for a configured repository. */
export function manifestRepositoryName(
  repository: Pick<WorkspaceRepository, "source" | "owner" | "name">,
) {
  return repository.source === "local"
    ? `local:${repository.name}`
    : `${repository.owner}/${repository.name}`;
}

export function localSourceRef(repository: Pick<WorkspaceRepository, "defaultBranch">) {
  return `refs/facility/source/${repository.defaultBranch}`;
}

function assertRepositoryContract(manifest: ProjectManifest, repositories: WorkspaceRepository[]) {
  const configuredPrimary = repositories.find((repository) => repository.role === "primary");
  const configured = new Set(
    repositories.map((repository) => manifestRepositoryName(repository).toLowerCase()),
  );
  const declared = [manifest.repositories.primary, ...manifest.repositories.related].map((name) =>
    name.toLowerCase(),
  );
  if (
    !configuredPrimary ||
    manifestRepositoryName(configuredPrimary).toLowerCase() !==
      manifest.repositories.primary.toLowerCase() ||
    configured.size !== declared.length ||
    declared.some((repository) => !configured.has(repository))
  ) {
    throw new ProjectEnvironmentError(
      "project_repository_mismatch",
      ".facility.yml repositories must exactly match the Facility project",
    );
  }
}

export function repositoryPath(repository: Pick<WorkspaceRepository, "owner" | "name">) {
  return `repos/${repository.owner}/${repository.name}`;
}

export function primaryPath(credentials: GithubWorkspaceCredentials) {
  const primary = credentials.repositories.find((repository) => repository.role === "primary");
  if (!primary) {
    throw new ProjectEnvironmentError(
      "primary_repository_not_found",
      "project credentials do not contain a primary repository",
    );
  }
  return repositoryPath(primary);
}

function services(manifest: ProjectManifest): PreviewEndpoint[] {
  return Object.entries(manifest.environment.services).map(([service, value]) => ({
    service,
    ...value,
    url: "",
  }));
}

/** True when a branch name would occupy the ref namespace story branches are created in. */
export function storyNamespaceConflict(branch: string) {
  return branch === "facility" || branch.startsWith("facility/");
}

function commandFailure(phase: string, command: string, result: WorkspaceCommandResult) {
  const reason = result.stderr.trim().split("\n").at(-1)?.trim().slice(0, 300);
  return new ProjectEnvironmentError(
    "environment_command_failed",
    reason ? `${phase} failed: ${reason}` : `${phase} failed`,
    {
      phase,
      command,
      exitCode: result.exitCode,
      stdout: tail(result.stdout),
      stderr: tail(result.stderr),
    },
  );
}

function tail(value: string) {
  return value.length <= 8_000 ? value : value.slice(-8_000);
}

function redactResult(
  result: WorkspaceCommandResult,
  environment: Record<string, string>,
  sensitiveNames: string[] = [],
) {
  return {
    ...result,
    stdout: redactCredentials(result.stdout, environment, sensitiveNames),
    stderr: redactCredentials(result.stderr, environment, sensitiveNames),
  };
}

function redactCredentials(
  value: string,
  environment: Record<string, string>,
  sensitiveNames: string[] = [],
) {
  const secrets = new Set<string>();
  for (const [name, candidate] of Object.entries(environment)) {
    if (
      (sensitiveNames.includes(name) && candidate.length > 0) ||
      ((name.includes("TOKEN") || name.includes("CREDENTIAL")) && candidate.length >= 4)
    ) {
      secrets.add(candidate);
    }
  }
  try {
    const map = JSON.parse(environment.FACILITY_GITHUB_CREDENTIALS ?? "{}") as Record<
      string,
      unknown
    >;
    for (const candidate of Object.values(map)) {
      if (typeof candidate === "string" && candidate.length >= 8) secrets.add(candidate);
    }
  } catch {
    // The credential broker owns this JSON. Invalid data fails later in git's helper.
  }
  let redacted = value;
  for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted;
}
