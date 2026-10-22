import type { PreviewGenerationRepository } from "@facility/core";
import { type FacilityDb, stories, workspaces } from "@facility/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { GithubWorkspaceCredentialBroker } from "../github/workspace-credentials.js";
import { appendWorkspaceEvent } from "../workspaces/events.js";
import type {
  ProjectEnvironmentService,
  ProjectManifestSource,
} from "../workspaces/project-environment.js";
import type {
  CreateWorkspace,
  WorkspaceCommandResult,
  WorkspaceLocator,
  WorkspaceRuntime,
} from "../workspaces/runtime.js";
import type {
  PreviewConvergenceScope,
  StoryPreviewConvergenceService,
} from "./preview-convergence.js";

const MAX_DIRTY_PATHS = 1_000;

export class PreviewConvergenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PreviewConvergenceError";
  }
}

/** Applies one fenced generation and publishes it only after rebuild/readiness succeeds. */
export class StoryPreviewConvergenceExecutor {
  constructor(
    private readonly db: FacilityDb,
    private readonly runtime: WorkspaceRuntime,
    private readonly credentials: GithubWorkspaceCredentialBroker,
    private readonly manifests: ProjectManifestSource,
    private readonly environment: ProjectEnvironmentService,
    private readonly convergence: StoryPreviewConvergenceService,
    private readonly onWriterReleased: (
      scope: PreviewConvergenceScope,
    ) => Promise<unknown> = async () => undefined,
  ) {}

  async dispatch(scope: PreviewConvergenceScope, now = new Date()) {
    const claim = await this.convergence.claim(scope, now);
    if (!claim.claimed) return claim;
    let workspaceId: string | undefined;
    let locator: WorkspaceLocator | undefined;
    try {
      const [story] = await this.db
        .select({ status: stories.status, deletedAt: stories.deletedAt })
        .from(stories)
        .where(
          and(
            eq(stories.orgId, scope.orgId),
            eq(stories.projectId, scope.projectId),
            eq(stories.id, scope.storyId),
          ),
        )
        .limit(1);
      const [workspace] = await this.db
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.orgId, scope.orgId),
            eq(workspaces.projectId, scope.projectId),
            eq(workspaces.storyId, scope.storyId),
            inArray(workspaces.state, ["creating", "running", "sleeping", "error"]),
          ),
        )
        .orderBy(desc(workspaces.createdAt))
        .limit(1);
      if (!story || !workspace) {
        throw new PreviewConvergenceError(
          "preview_workspace_missing",
          "The story does not have a retained workspace to update.",
          false,
        );
      }
      workspaceId = workspace.id;
      if (story.deletedAt || story.status === "archived" || workspace.state === "sleeping") {
        await this.convergence.suspend(
          scope,
          {
            generation: claim.generation,
            leaseToken: claim.leaseToken,
            reason: story.status === "archived" ? "story_archived" : "workspace_sleeping",
          },
          now,
        );
        await this.releaseWriter(scope);
        return { claimed: true as const, state: "suspended" as const };
      }
      locator = workspaceLocator(workspace);
      await this.ensureLease(scope, claim.generation, claim.leaseToken);
      const [credentials, manifest] = await Promise.all([
        this.credentials.issue(scope.orgId, scope.projectId),
        this.manifests.load(scope.orgId, scope.projectId),
      ]);
      await new PreviewWorkspaceGitApplicator(this.runtime).apply({
        workspace: locator,
        repositories: claim.repositories,
        credentials,
        onProgress: () => this.ensureLease(scope, claim.generation, claim.leaseToken),
      });
      await this.ensureLease(scope, claim.generation, claim.leaseToken);
      const refreshed = await this.environment.refreshPrepared({
        ...scope,
        workspace: locator,
        manifest,
        credentials,
        previousSetupChecksum: workspace.setupChecksum,
      });
      await this.ensureLease(scope, claim.generation, claim.leaseToken);
      const settlement = await this.convergence.complete(
        scope,
        {
          generation: claim.generation,
          leaseToken: claim.leaseToken,
          workspaceId: workspace.id,
          setupChecksum: refreshed.setupChecksum,
          endpoints: refreshed.endpoints,
        },
        new Date(),
      );
      if (settlement.settled && !settlement.superseded) {
        await appendWorkspaceEvent(this.db, workspace.id, scope.orgId, "preview.converged", {
          generation: claim.generation,
          repositoryCount: new Set(claim.repositories.map((item) => item.repositoryId)).size,
          pullRequestCount: claim.repositories.length,
          services: refreshed.endpoints.map((endpoint) => endpoint.service),
        });
      } else if (!settlement.settled) {
        await this.honorSuspension(scope, locator, workspace.id);
      }
      await this.releaseWriter(scope);
      return {
        claimed: true as const,
        state: !settlement.settled
          ? ("superseded" as const)
          : settlement.superseded
            ? ("superseded" as const)
            : ("ready" as const),
      };
    } catch (error) {
      if (error instanceof PreviewConvergenceError && error.code === "preview_lease_lost") {
        if (locator && workspaceId) await this.honorSuspension(scope, locator, workspaceId);
        await this.releaseWriter(scope);
        return { claimed: true as const, state: "superseded" as const };
      }
      const failure = safeFailure(error, now);
      await this.convergence.fail(
        scope,
        {
          generation: claim.generation,
          leaseToken: claim.leaseToken,
          workspaceId,
          outcome: failure.retryable ? "failed" : "blocked",
          code: failure.code,
          message: failure.message,
          retryAt: failure.retryAt,
          details: failure.details,
        },
        new Date(),
      );
      await this.releaseWriter(scope);
      return {
        claimed: true as const,
        state: failure.retryable ? ("failed" as const) : ("blocked" as const),
        code: failure.code,
      };
    }
  }

  private async ensureLease(
    scope: PreviewConvergenceScope,
    generation: string,
    leaseToken: string,
  ) {
    if (await this.convergence.renew(scope, { generation, leaseToken })) return;
    throw new PreviewConvergenceError(
      "preview_lease_lost",
      "Preview convergence lost its writer lease before publication.",
      false,
    );
  }

  private async releaseWriter(scope: PreviewConvergenceScope) {
    try {
      await this.onWriterReleased(scope);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "preview.writer.release_failed",
          storyId: scope.storyId,
          error: error instanceof Error ? error.message : "unknown_error",
        }),
      );
    }
  }

  private async honorSuspension(
    scope: PreviewConvergenceScope,
    workspace: WorkspaceLocator,
    workspaceId: string,
  ) {
    const current = await this.convergence.read(scope);
    if (current?.state !== "suspended") return;
    await this.runtime.suspend(workspace);
    await this.db
      .update(workspaces)
      .set({ state: "sleeping", updatedAt: new Date() })
      .where(
        and(
          eq(workspaces.orgId, scope.orgId),
          eq(workspaces.projectId, scope.projectId),
          eq(workspaces.id, workspaceId),
        ),
      );
  }
}

export class PreviewWorkspaceGitApplicator {
  constructor(private readonly runtime: WorkspaceRuntime) {}

  async apply(input: {
    workspace: WorkspaceLocator;
    repositories: PreviewGenerationRepository[];
    credentials: Awaited<ReturnType<GithubWorkspaceCredentialBroker["issue"]>>;
    onProgress?: () => Promise<unknown>;
  }) {
    const configured = new Map(
      input.credentials.repositories.map((repository) => [
        `${repository.owner}/${repository.name}`.toLowerCase(),
        repository,
      ]),
    );
    const grouped = new Map<string, PreviewGenerationRepository[]>();
    for (const target of input.repositories) {
      const key = target.repository.toLowerCase();
      if (!configured.has(key)) {
        throw new PreviewConvergenceError(
          "preview_repository_mismatch",
          "A required preview repository is not connected to the workspace project.",
          false,
          { repository: target.repository },
        );
      }
      grouped.set(key, [...(grouped.get(key) ?? []), target]);
    }
    for (const [name, targets] of grouped) {
      await input.onProgress?.();
      const repository = configured.get(name);
      if (!repository) throw new Error("preview_repository_lookup_failed");
      const cwd = `repos/${repository.owner}/${repository.name}`;
      await this.applyRepository(
        input.workspace,
        cwd,
        [...targets].sort((left, right) => left.pullNumber - right.pullNumber),
        input.credentials.environment,
        input.onProgress,
      );
    }
  }

  private async applyRepository(
    workspace: WorkspaceLocator,
    cwd: string,
    targets: PreviewGenerationRepository[],
    environment: Record<string, string>,
    onProgress?: () => Promise<unknown>,
  ) {
    await this.requireGit(workspace, cwd, environment, ["rev-parse", "--git-dir"], {
      code: "preview_repository_missing",
      message: "A required repository is missing from the retained workspace.",
      retryable: false,
    });
    const unmerged = await this.git(workspace, cwd, environment, [
      "diff",
      "--name-only",
      "--diff-filter=U",
      "-z",
    ]);
    if (unmerged.exitCode !== 0 || paths(unmerged.stdout).length > 0) {
      throw new PreviewConvergenceError(
        "preview_repository_unmerged",
        "The retained repository already has unresolved merge conflicts.",
        false,
      );
    }
    const dirty = await this.dirtySnapshot(workspace, cwd, environment);
    for (const target of targets) {
      await onProgress?.();
      const fetched = await this.git(workspace, cwd, environment, [
        "fetch",
        "--no-tags",
        "origin",
        target.headSha,
      ]);
      if (fetched.exitCode !== 0) {
        throw new PreviewConvergenceError(
          "preview_commit_unavailable",
          "A required preview commit is not currently fetchable from its repository.",
          true,
          { repository: target.repository, pullNumber: target.pullNumber },
        );
      }
      await this.requireGit(
        workspace,
        cwd,
        environment,
        ["cat-file", "-e", `${target.headSha}^{commit}`],
        {
          code: "preview_commit_invalid",
          message: "A required preview revision is not a Git commit.",
          retryable: false,
          details: { repository: target.repository, pullNumber: target.pullNumber },
        },
      );
      if (await this.isAncestor(workspace, cwd, environment, target.headSha, "HEAD")) continue;
      const mergeBase = await this.requireGit(
        workspace,
        cwd,
        environment,
        ["merge-base", "HEAD", target.headSha],
        {
          code: "preview_ancestry_failed",
          message: "Facility could not determine the preview commit ancestry.",
          retryable: true,
        },
      );
      const changed = await this.requireGit(
        workspace,
        cwd,
        environment,
        [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          mergeBase.stdout.trim(),
          target.headSha,
          "--",
        ],
        {
          code: "preview_diff_failed",
          message: "Facility could not compare the retained branch with a required commit.",
          retryable: true,
        },
      );
      const overlap = paths(changed.stdout).filter((path) => dirty.has(path));
      if (overlap.length > 0) {
        throw new PreviewConvergenceError(
          "preview_dirty_overlap",
          "Local workspace edits overlap files changed by the required preview generation.",
          false,
          { paths: overlap.slice(0, 50) },
        );
      }
      if (await this.isAncestor(workspace, cwd, environment, "HEAD", target.headSha)) {
        await this.requireGit(workspace, cwd, environment, ["merge", "--ff-only", target.headSha], {
          code: "preview_fast_forward_failed",
          message: "Facility could not fast-forward the retained repository safely.",
          retryable: true,
        });
      } else {
        const preflight = await this.git(workspace, cwd, environment, [
          "merge-tree",
          "--write-tree",
          "HEAD",
          target.headSha,
        ]);
        if (preflight.exitCode !== 0) {
          throw new PreviewConvergenceError(
            "preview_merge_conflict",
            "Required preview commits conflict with the retained workspace branch.",
            false,
            { repository: target.repository, pullNumber: target.pullNumber },
          );
        }
        const merged = await this.git(workspace, cwd, environment, [
          "merge",
          "--no-edit",
          "--no-ff",
          target.headSha,
        ]);
        if (merged.exitCode !== 0) {
          await this.git(workspace, cwd, environment, ["merge", "--abort"]);
          throw new PreviewConvergenceError(
            "preview_merge_failed",
            "Facility could not combine the required preview commits safely.",
            true,
            { repository: target.repository, pullNumber: target.pullNumber },
          );
        }
      }
      await onProgress?.();
    }
    for (const target of targets) {
      if (!(await this.isAncestor(workspace, cwd, environment, target.headSha, "HEAD"))) {
        throw new PreviewConvergenceError(
          "preview_generation_verification_failed",
          "The retained repository does not contain every required preview commit.",
          true,
          { repository: target.repository, pullNumber: target.pullNumber },
        );
      }
    }
    await this.assertDirtyPreserved(workspace, cwd, environment, dirty);
  }

  private async dirtySnapshot(
    workspace: WorkspaceLocator,
    cwd: string,
    environment: Record<string, string>,
  ) {
    const results = await Promise.all([
      this.requireGit(
        workspace,
        cwd,
        environment,
        ["diff", "--name-only", "--no-renames", "-z", "--"],
        dirtyReadFailure,
      ),
      this.requireGit(
        workspace,
        cwd,
        environment,
        ["diff", "--cached", "--name-only", "--no-renames", "-z", "--"],
        dirtyReadFailure,
      ),
      this.requireGit(
        workspace,
        cwd,
        environment,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        dirtyReadFailure,
      ),
    ]);
    const names = [...new Set(results.flatMap((result) => paths(result.stdout)))].sort();
    if (names.length > MAX_DIRTY_PATHS) {
      throw new PreviewConvergenceError(
        "preview_dirty_set_too_large",
        "The retained repository has too many local paths for a safe preview update.",
        false,
        { count: names.length },
      );
    }
    const snapshot = new Map<string, string>();
    for (const path of names) {
      const hash = await this.git(workspace, cwd, environment, [
        "hash-object",
        "--no-filters",
        "--",
        path,
      ]);
      snapshot.set(path, hash.exitCode === 0 ? hash.stdout.trim() : "missing");
    }
    return snapshot;
  }

  private async assertDirtyPreserved(
    workspace: WorkspaceLocator,
    cwd: string,
    environment: Record<string, string>,
    snapshot: Map<string, string>,
  ) {
    for (const [path, expected] of snapshot) {
      const hash = await this.git(workspace, cwd, environment, [
        "hash-object",
        "--no-filters",
        "--",
        path,
      ]);
      const actual = hash.exitCode === 0 ? hash.stdout.trim() : "missing";
      if (actual !== expected) {
        throw new PreviewConvergenceError(
          "preview_dirty_preservation_failed",
          "A local workspace edit changed while Facility applied the preview generation.",
          false,
          { path },
        );
      }
    }
  }

  private async isAncestor(
    workspace: WorkspaceLocator,
    cwd: string,
    environment: Record<string, string>,
    ancestor: string,
    descendant: string,
  ) {
    const result = await this.git(workspace, cwd, environment, [
      "merge-base",
      "--is-ancestor",
      ancestor,
      descendant,
    ]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new PreviewConvergenceError(
      "preview_ancestry_failed",
      "Facility could not verify preview commit ancestry.",
      true,
    );
  }

  private async requireGit(
    workspace: WorkspaceLocator,
    cwd: string,
    environment: Record<string, string>,
    args: string[],
    failure: {
      code: string;
      message: string;
      retryable: boolean;
      details?: Record<string, unknown>;
    },
  ) {
    const result = await this.git(workspace, cwd, environment, args);
    if (result.exitCode !== 0) {
      throw new PreviewConvergenceError(
        failure.code,
        failure.message,
        failure.retryable,
        failure.details,
      );
    }
    return result;
  }

  private git(
    workspace: WorkspaceLocator,
    cwd: string,
    environment: Record<string, string>,
    args: string[],
  ): Promise<WorkspaceCommandResult> {
    return this.runtime.exec(workspace, {
      command: "git",
      args,
      cwd,
      env: environment,
      timeoutMs: 5 * 60_000,
    });
  }
}

const dirtyReadFailure = {
  code: "preview_dirty_state_unavailable",
  message: "Facility could not inspect local workspace edits safely.",
  retryable: true,
};

function paths(value: string) {
  return value.split("\0").filter(Boolean);
}

function workspaceLocator(row: typeof workspaces.$inferSelect): WorkspaceLocator {
  if (!row.externalRef) {
    throw new PreviewConvergenceError(
      "preview_workspace_unavailable",
      "The retained workspace has no active provider reference.",
      true,
    );
  }
  const configuration = row.environment as {
    image?: unknown;
    variables?: unknown;
    ports?: unknown;
    resources?: unknown;
  };
  if (typeof configuration.image !== "string") {
    throw new PreviewConvergenceError(
      "preview_workspace_configuration_invalid",
      "The retained workspace configuration is invalid.",
      false,
    );
  }
  const environment =
    configuration.variables &&
    typeof configuration.variables === "object" &&
    !Array.isArray(configuration.variables) &&
    Object.values(configuration.variables).every((value) => typeof value === "string")
      ? (configuration.variables as Record<string, string>)
      : {};
  return {
    id: row.id,
    image: configuration.image,
    environment,
    ports: Array.isArray(configuration.ports)
      ? (configuration.ports as CreateWorkspace["ports"])
      : [],
    resources:
      configuration.resources && typeof configuration.resources === "object"
        ? (configuration.resources as CreateWorkspace["resources"])
        : undefined,
    externalRef: row.externalRef,
    volumeRef: row.volumeRef,
  };
}

function safeFailure(error: unknown, now: Date) {
  if (error instanceof PreviewConvergenceError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
      retryAt: error.retryable ? new Date(now.getTime() + 60_000) : undefined,
    };
  }
  const known = error as { code?: unknown; message?: unknown };
  const code =
    typeof known.code === "string" && /^[a-z][a-z0-9_]{2,100}$/.test(known.code)
      ? known.code
      : "preview_convergence_failed";
  return {
    code,
    message:
      typeof known.message === "string" && known.message.length <= 500
        ? known.message
        : "Preview convergence failed before readiness could be confirmed.",
    retryable: ![
      "project_manifest_invalid",
      "project_manifest_not_found",
      "project_repository_mismatch",
    ].includes(code),
    details: {},
    retryAt: new Date(now.getTime() + 60_000),
  };
}
