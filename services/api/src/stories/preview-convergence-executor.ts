import { randomUUID } from "node:crypto";
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
import {
  PreviewComputeStopError,
  PreviewLeaseLostError,
  withPreviewLease,
} from "./preview-lease.js";

const MAX_DIRTY_PATHS = 1_000;

/** Called with the convergence row locked, before suspension releases its writer. */
export async function retirePreviewWriter(
  db: FacilityDb,
  runtime: WorkspaceRuntime,
  scope: PreviewConvergenceScope,
) {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.orgId, scope.orgId),
        eq(workspaces.projectId, scope.projectId),
        eq(workspaces.storyId, scope.storyId),
      ),
    )
    .orderBy(desc(workspaces.createdAt))
    .limit(1);
  if (!workspace) throw new Error("preview_workspace_missing");
  const locator = workspaceLocator(workspace);
  const compute = await runtime.inspect(locator);
  if (compute.computeRef)
    await runtime.retireCompute({ ...locator, expectedComputeRef: compute.computeRef });
}

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
      // Retire abandoned compute so no delayed stop or command from the old
      // attempt can address the replacement through the reusable workspace name.
      if (claim.requiresComputeFence) {
        try {
          const abandoned = await this.runtime.inspect(locator);
          if (abandoned.computeRef)
            await this.runtime.retireCompute({
              ...locator,
              expectedComputeRef: abandoned.computeRef,
            });
        } catch (cause) {
          throw new PreviewComputeStopError("Abandoned preview compute was not retired", { cause });
        }
        await this.convergence.acknowledgeStopped(scope, {
          generation: claim.generation,
          leaseToken: claim.leaseToken,
        });
        await this.convergence.observe(scope);
        await this.convergence.retry(scope);
        await this.releaseWriter(scope);
        return { claimed: true as const, state: "recovered" as const };
      }
      const target = locator;
      const compute = await this.convergence.bindCompute(scope, claim, () =>
        this.runtime.wake(target),
      );
      if (!compute)
        throw new PreviewConvergenceError(
          "preview_lease_lost",
          "Preview compute binding lost its writer lease.",
          false,
        );
      const activeLocator = { ...locator, expectedComputeRef: compute.computeRef };
      locator = activeLocator;
      // A worker delayed before binding compute must not clean up a newer owner.
      await this.ensureLease(scope, claim.generation, claim.leaseToken);
      const refreshed = await withPreviewLease(
        () =>
          this.convergence.renew(scope, {
            generation: claim.generation,
            leaseToken: claim.leaseToken,
          }),
        async (signal) => {
          const [credentials, manifest] = await Promise.all([
            this.credentials.issue(scope.orgId, scope.projectId),
            this.manifests.load(scope.orgId, scope.projectId),
          ]);
          signal.throwIfAborted();
          await new PreviewWorkspaceGitApplicator(this.runtime, signal).apply({
            workspace: activeLocator,
            repositories: claim.repositories,
            credentials,
            onProgress: async () => {
              signal.throwIfAborted();
            },
          });
          return this.environment.refreshPrepared({
            ...scope,
            workspace: activeLocator,
            manifest,
            credentials,
            previousSetupChecksum: workspace.setupChecksum,
            signal,
          });
        },
        () => this.runtime.suspend(activeLocator),
      );
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
      // An unconfirmed provider fence retains the durable writer. Recovery may
      // reclaim its expired lease, but must retire compute before releasing it.
      if (error instanceof PreviewComputeStopError)
        return { claimed: true as const, state: "failed" as const, code: error.code };
      if (
        error instanceof PreviewLeaseLostError ||
        (error instanceof PreviewConvergenceError && error.code === "preview_lease_lost")
      ) {
        if (error instanceof PreviewLeaseLostError)
          await this.convergence.acknowledgeStopped(scope, {
            generation: claim.generation,
            leaseToken: claim.leaseToken,
          });
        if (locator?.expectedComputeRef && workspaceId)
          await this.honorSuspension(scope, locator, workspaceId);
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
  constructor(
    private readonly runtime: WorkspaceRuntime,
    private readonly signal?: AbortSignal,
  ) {}

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
    for (const name of configured.keys()) {
      const targets = grouped.get(name) ?? [];
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
        repository.developmentBranch ?? repository.defaultBranch,
      );
    }
  }

  private async applyRepository(
    workspace: WorkspaceLocator,
    cwd: string,
    targets: PreviewGenerationRepository[],
    environment: Record<string, string>,
    onProgress?: () => Promise<unknown>,
    baseBranch = "main",
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
    const managed = await this.git(workspace, cwd, environment, [
      "rev-parse",
      "--verify",
      "refs/facility/preview-managed",
    ]);
    if (!targets.length && managed.exitCode !== 0) return;
    const dirty = await this.dirtySnapshot(workspace, cwd, environment);
    const failure = {
      code: "preview_candidate_build_failed",
      message: "Facility could not reconstruct the complete preview candidate.",
      retryable: true,
    };
    // Reconstruct from the configured integration base and the current complete set,
    // never from accumulated HEAD. Object construction leaves the retained index alone.
    await this.requireGit(
      workspace,
      cwd,
      environment,
      ["fetch", "--no-tags", "origin", `refs/heads/${baseBranch}`],
      failure,
    );
    let candidate = (
      await this.requireGit(
        workspace,
        cwd,
        environment,
        ["rev-parse", "FETCH_HEAD^{commit}"],
        failure,
      )
    ).stdout.trim();
    for (const target of targets) {
      await onProgress?.();
      await this.requireGit(
        workspace,
        cwd,
        environment,
        ["fetch", "--no-tags", "origin", target.headSha],
        {
          code: "preview_commit_unavailable",
          message: "A required preview commit is not fetchable.",
          retryable: true,
        },
      );
      await this.requireGit(
        workspace,
        cwd,
        environment,
        ["cat-file", "-e", `${target.headSha}^{commit}`],
        failure,
      );
      if (await this.isAncestor(workspace, cwd, environment, target.headSha, candidate)) continue;
      if (await this.isAncestor(workspace, cwd, environment, candidate, target.headSha)) {
        candidate = target.headSha;
        continue;
      }
      const tree = await this.git(workspace, cwd, environment, [
        "merge-tree",
        "--write-tree",
        candidate,
        target.headSha,
      ]);
      if (tree.exitCode !== 0)
        throw new PreviewConvergenceError(
          "preview_merge_conflict",
          "The current required preview heads conflict.",
          false,
          { repository: target.repository, pullNumber: target.pullNumber },
        );
      candidate = (
        await this.requireGit(
          workspace,
          cwd,
          {
            ...environment,
            GIT_AUTHOR_NAME: "Facility Preview",
            GIT_AUTHOR_EMAIL: "preview@facility.invalid",
            GIT_COMMITTER_NAME: "Facility Preview",
            GIT_COMMITTER_EMAIL: "preview@facility.invalid",
            GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
            GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
          },
          [
            "commit-tree",
            tree.stdout.trim().split("\n")[0] ?? "",
            "-p",
            candidate,
            "-p",
            target.headSha,
            "-m",
            "Facility complete preview candidate",
          ],
          failure,
        )
      ).stdout.trim();
    }
    const current = (
      await this.requireGit(workspace, cwd, environment, ["rev-parse", "HEAD"], failure)
    ).stdout.trim();
    const changed = await this.requireGit(
      workspace,
      cwd,
      environment,
      ["diff", "--name-only", "--no-renames", "-z", current, candidate, "--"],
      failure,
    );
    const overlap = paths(changed.stdout).filter((path) => dirty.has(path));
    if (overlap.length)
      throw new PreviewConvergenceError(
        "preview_dirty_overlap",
        "Local workspace edits overlap the current preview candidate.",
        false,
        { paths: overlap.slice(0, 50) },
      );
    // A tracked local overlay cannot be labelled the exact candidate. Preserve it
    // in place and ask the user to save it before retrying, including staged edits.
    const tracked = await this.requireGit(
      workspace,
      cwd,
      environment,
      ["status", "--porcelain", "--untracked-files=no"],
      dirtyReadFailure,
    );
    if (tracked.stdout.trim())
      throw new PreviewConvergenceError(
        "preview_dirty_worktree",
        "Save tracked local edits before publishing an exact preview candidate.",
        false,
      );
    if (current !== candidate) {
      // Retain every displaced commit, even a detached local branch. No reset or clean.
      await this.requireGit(
        workspace,
        cwd,
        environment,
        ["update-ref", `refs/facility/retained/${randomUUID()}`, current],
        failure,
      );
      await onProgress?.();
      await this.requireGit(
        workspace,
        cwd,
        environment,
        ["checkout", "--detach", "--no-overwrite-ignore", candidate],
        {
          code: "preview_checkout_blocked",
          message: "The preview candidate would overwrite a retained local path.",
          retryable: false,
        },
      );
    }
    await this.requireGit(
      workspace,
      cwd,
      environment,
      ["update-ref", "refs/facility/preview-managed", candidate],
      failure,
    );
    if (
      (
        await this.requireGit(workspace, cwd, environment, ["rev-parse", "HEAD"], failure)
      ).stdout.trim() !== candidate
    )
      throw new PreviewConvergenceError(
        "preview_generation_verification_failed",
        "The retained repository is not the exact reconstructed candidate.",
        false,
      );
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
    this.signal?.throwIfAborted();
    return this.runtime.exec(workspace, {
      signal: this.signal,
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
