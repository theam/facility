import { createHash } from "node:crypto";
import { newId } from "@facility/core";
import type { FacilityDb } from "@facility/db";
import { githubInstallations, projectRepositories, storyArtifacts, workspaces } from "@facility/db";
import { and, eq } from "drizzle-orm";
import { parseDocument } from "yaml";
import { z } from "zod";
import { FacilityGithubClient, type GithubClientFactory } from "../github/client.js";
import { decodeContent } from "../github/repo-files.js";
import type {
  GithubWorkspaceCredentials,
  WorkspaceRepository,
} from "../github/workspace-credentials.js";
import { appendWorkspaceEvent } from "./events.js";
import type {
  PreviewEndpoint,
  WorkspaceCommandResult,
  WorkspaceLocator,
  WorkspaceRuntime,
} from "./runtime.js";

const RepositoryName = z
  .string()
  .min(3)
  .max(240)
  .transform((value, context) => {
    const match =
      /^(?:https:\/\/)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
    if (!match) {
      context.addIssue({ code: "custom", message: "must be github.com/owner/repository" });
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
        setup: z.string().min(1).max(4_000).optional(),
        start: z.string().min(1).max(4_000),
        ready: z.string().min(1).max(4_000).optional(),
        stop: z.string().min(1).max(4_000).optional(),
        seed: z.string().min(1).max(4_000).optional(),
        browser_test: z.string().min(1).max(4_000).optional(),
        secrets: z.array(EnvironmentName).default([]),
        variables: z.array(EnvironmentName).default([]),
        services: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), ServiceSchema).default({}),
      })
      .strict(),
  })
  .strict();

export type ProjectManifest = z.infer<typeof ProjectManifestSchema> & { hash: string };

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

export class ProjectEnvironmentService {
  constructor(
    private readonly db: FacilityDb,
    private readonly runtime: WorkspaceRuntime,
    private readonly gitBaseUrl = "https://github.com",
    private readonly environmentValue: (projectId: string, name: string) => string | undefined = (
      projectId,
      name,
    ) => process.env[projectEnvironmentVariableName(projectId, name)],
  ) {}

  async prepare(input: {
    orgId: string;
    projectId: string;
    workspace: WorkspaceLocator;
    manifest: ProjectManifest;
    credentials: GithubWorkspaceCredentials;
    branch: string;
    previousSetupChecksum?: string | null;
    cleanSetup?: boolean;
    readinessTimeoutMs?: number;
  }) {
    assertRepositoryContract(input.manifest, input.credentials.repositories);
    const preparedInput = this.withDeclaredEnvironment(input);
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
      if (present.exitCode !== 0) {
        await this.runCommand(
          preparedInput,
          "git",
          ["clone", `${this.gitBaseUrl}/${repository.owner}/${repository.name}.git`, cwd],
          ".",
          `clone ${repository.owner}/${repository.name}`,
        );
      }
      await this.runCommand(preparedInput, "git", ["fetch", "--all", "--prune"], cwd, "git fetch");
      await this.runCommand(
        preparedInput,
        "git",
        ["config", "user.name", "Facility Agent"],
        cwd,
        "git identity",
      );
      await this.runCommand(
        preparedInput,
        "git",
        ["config", "user.email", "facility-agent@users.noreply.github.com"],
        cwd,
        "git identity",
      );
      if (repository.role === "primary") await this.ensureBranch(preparedInput, repository, cwd);
    }

    const setupChecksum = await this.setupChecksum(preparedInput);
    const setupRequired = input.cleanSetup || input.previousSetupChecksum !== setupChecksum;
    if (preparedInput.manifest.environment.setup && setupRequired) {
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
    await this.run(
      preparedInput,
      preparedInput.manifest.environment.start,
      primaryPath(preparedInput.credentials),
      "environment.start",
    );
    if (preparedInput.manifest.environment.ready) await this.waitUntilReady(preparedInput);
    const endpoints = await this.runtime.expose(
      preparedInput.workspace,
      services(preparedInput.manifest),
    );
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
    const preparedInput = this.withDeclaredEnvironment({ ...input, branch: "browser-test" });
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

  private withDeclaredEnvironment<
    T extends {
      projectId: string;
      manifest: ProjectManifest;
      credentials: GithubWorkspaceCredentials;
    },
  >(input: T): T {
    const names = [...input.manifest.environment.variables, ...input.manifest.environment.secrets];
    const values: Record<string, string> = {};
    const missing: Array<{ name: string; operatorName: string }> = [];
    for (const name of names) {
      const operatorName = projectEnvironmentVariableName(input.projectId, name);
      const value = this.environmentValue(input.projectId, name);
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
    return {
      ...input,
      credentials: {
        ...input.credentials,
        environment: { ...input.credentials.environment, ...values },
      },
    };
  }

  private async setupChecksum(input: Parameters<ProjectEnvironmentService["prepare"]>[0]) {
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

  private async waitUntilReady(input: Parameters<ProjectEnvironmentService["prepare"]>[0]) {
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

  private async run(
    input: Parameters<ProjectEnvironmentService["prepare"]>[0],
    script: string,
    cwd: string,
    phase: string,
  ) {
    const result = await this.command(input, script, cwd);
    const safeResult = redactResult(
      result,
      input.credentials.environment,
      input.manifest.environment.secrets,
    );
    if (result.exitCode !== 0) throw commandFailure(phase, script, safeResult);
    await appendWorkspaceEvent(this.db, input.workspace.id, input.orgId, phase, {
      command: script,
      exitCode: result.exitCode,
      stdout: tail(safeResult.stdout),
      stderr: tail(safeResult.stderr),
      durationMs: result.durationMs,
    });
    return result;
  }

  private command(
    input: Parameters<ProjectEnvironmentService["prepare"]>[0],
    script: string,
    cwd: string,
  ) {
    return this.runtime.exec(input.workspace, {
      command: "sh",
      args: ["-lc", script],
      cwd,
      env: input.credentials.environment,
      timeoutMs: 30 * 60 * 1_000,
    });
  }

  private async runCommand(
    input: Parameters<ProjectEnvironmentService["prepare"]>[0],
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

export function projectEnvironmentVariableName(projectId: string, name: string) {
  if (!/^[a-z0-9_]{1,100}$/.test(projectId)) {
    throw new ProjectEnvironmentError("project_id_invalid", "project id is invalid");
  }
  return `FACILITY_PROJECT_${projectId.toUpperCase()}_${EnvironmentName.parse(name)}`;
}

function isSafeGitBranch(branch: string) {
  const hasControlOrForbiddenCharacter = [...branch].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character);
  });
  return Boolean(
    branch &&
      branch.length <= 200 &&
      !branch.startsWith("-") &&
      !branch.startsWith("/") &&
      !branch.endsWith("/") &&
      !branch.endsWith(".") &&
      !branch.includes("..") &&
      !branch.includes("@{") &&
      !hasControlOrForbiddenCharacter,
  );
}

function assertRepositoryContract(manifest: ProjectManifest, repositories: WorkspaceRepository[]) {
  const configuredPrimary = repositories.find((repository) => repository.role === "primary");
  const configured = new Set(
    repositories.map((repository) => `${repository.owner}/${repository.name}`.toLowerCase()),
  );
  const declared = [manifest.repositories.primary, ...manifest.repositories.related].map((name) =>
    name.toLowerCase(),
  );
  if (
    !configuredPrimary ||
    `${configuredPrimary.owner}/${configuredPrimary.name}`.toLowerCase() !==
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

function repositoryPath(repository: WorkspaceRepository) {
  return `repos/${repository.owner}/${repository.name}`;
}

function primaryPath(credentials: GithubWorkspaceCredentials) {
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

function commandFailure(phase: string, command: string, result: WorkspaceCommandResult) {
  return new ProjectEnvironmentError("environment_command_failed", `${phase} failed`, {
    phase,
    command,
    exitCode: result.exitCode,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr),
  });
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
      (sensitiveNames.includes(name) || name.includes("TOKEN") || name.includes("CREDENTIAL")) &&
      candidate.length >= 4
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
