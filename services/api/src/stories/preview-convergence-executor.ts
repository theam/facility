import { randomUUID } from "node:crypto";
import type { PreviewGenerationRepository } from "@facility/core";
import { type FacilityDb, stories, workspaces } from "@facility/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  type PreviewPullMergeResolver,
  readPreviewPullMerge,
} from "../github/preview-pull-merge.js";
import type { GithubWorkspaceCredentialBroker } from "../github/workspace-credentials.js";
import { appendWorkspaceEvent } from "../workspaces/events.js";
import { PREVIEW_MANAGED_REF, previewBranchRefs } from "../workspaces/preview-branch.js";
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
import { PreviewConvergenceError } from "./preview-errors.js";
import {
  PreviewComputeStopError,
  PreviewLeaseLostError,
  withPreviewLease,
} from "./preview-lease.js";
import {
  type AppliedPreviewRepository,
  connectedPreviewSubmodules,
  type PreviewSubmodule,
  previewSourceFingerprint,
  previewTreeEntries,
  safePreviewPath,
  validatePreviewCheckout,
} from "./preview-submodules.js";

export { PreviewConvergenceError } from "./preview-errors.js";

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
    private readonly resolvePullMerge: PreviewPullMergeResolver = readPreviewPullMerge,
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
          const applicator = new PreviewWorkspaceGitApplicator(this.runtime, signal, (target) =>
            this.resolvePullMerge(target, credentials, signal),
          );
          const previewSources = await applicator.apply({
            workspace: activeLocator,
            repositories: claim.repositories,
            credentials,
            onProgress: async () => {
              signal.throwIfAborted();
            },
          });
          const refreshed = await this.environment.refreshPrepared({
            ...scope,
            workspace: activeLocator,
            manifest,
            credentials,
            previousSetupChecksum: workspace.setupChecksum,
            sourceFingerprint: previewSourceFingerprint(previewSources),
            signal,
          });
          await applicator.verify(activeLocator, previewSources, credentials.environment);
          return { ...refreshed, previewSources };
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
          sources: refreshed.previewSources,
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
  private readonly validatedCheckouts = new Map<string, string>();
  constructor(
    private readonly runtime: WorkspaceRuntime,
    private readonly signal?: AbortSignal,
    private readonly integratedCommit?: (
      target: PreviewGenerationRepository,
    ) => Promise<string | null>,
  ) {}

  async apply(input: {
    workspace: WorkspaceLocator;
    repositories: PreviewGenerationRepository[];
    credentials: Awaited<ReturnType<GithubWorkspaceCredentialBroker["issue"]>>;
    onProgress?: () => Promise<unknown>;
  }) {
    this.validatedCheckouts.clear();
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
    const environment = input.credentials.environment;
    const bases = new Map<
      string,
      { cwd: string; sha: string; active: boolean; managed: string | null }
    >();
    const connected = new Set(configured.keys());
    for (const [name, repository] of configured) {
      const cwd = `repos/${repository.owner}/${repository.name}`;
      await this.assertCheckout(input.workspace, cwd);
      const targets = grouped.get(name) ?? [];
      const managed = await this.directRef(input.workspace, cwd, environment, PREVIEW_MANAGED_REF);
      const active = targets.length > 0 || !!managed;
      const sha = active
        ? await this.repositoryCandidate(
            input.workspace,
            cwd,
            targets,
            environment,
            input.onProgress,
            repository.developmentBranch ?? repository.defaultBranch,
          )
        : (
            await this.requireGit(
              input.workspace,
              cwd,
              environment,
              ["rev-parse", "HEAD"],
              candidateFailure,
            )
          ).stdout.trim();
      bases.set(name, { cwd, sha, active, managed });
    }
    // A connected parent with no PR can still supply the build root for a
    // required descendant. Use its integration base, never an accumulated HEAD.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [name, base] of bases) {
        if (base.active) continue;
        const modules = await this.submodules(
          input.workspace,
          base.cwd,
          base.sha,
          environment,
          name,
          connected,
        );
        if (!modules.some((module) => bases.get(module.repository)?.active)) continue;
        const repository = configured.get(name);
        if (!repository) throw new Error("preview_repository_lookup_failed");
        base.sha = await this.repositoryCandidate(
          input.workspace,
          base.cwd,
          [],
          environment,
          input.onProgress,
          repository.developmentBranch ?? repository.defaultBranch,
        );
        base.active = true;
        changed = true;
      }
    }
    type Composition = {
      repository: string;
      headSha: string;
      children: Array<{ module: PreviewSubmodule; plan: Composition }>;
    };
    const composed = new Map<string, Composition>();
    const compose = async (
      repository: string,
      source: string,
      trail: string[] = [],
    ): Promise<Composition> => {
      if (trail.includes(repository) || trail.length >= 16 || composed.size >= 100)
        throw new PreviewConvergenceError(
          "preview_submodule_topology_invalid",
          "The candidate submodule topology is cyclic or too large.",
          false,
        );
      const key = `${repository}:${source}`;
      const cached = composed.get(key);
      if (cached) return cached;
      const base = bases.get(repository);
      if (!base) throw new Error("preview_repository_lookup_failed");
      if (base.sha !== source)
        await this.ensureCommit(input.workspace, base.cwd, source, environment);
      const modules = await this.submodules(
        input.workspace,
        base.cwd,
        source,
        environment,
        repository,
        connected,
      );
      const children: Composition["children"] = [];
      for (const module of modules) {
        const child = bases.get(module.repository);
        if (!child) throw new Error("preview_repository_lookup_failed");
        const pin = grouped.has(module.repository) ? child.sha : module.pin;
        children.push({
          module,
          plan: await compose(module.repository, pin, [...trail, repository]),
        });
      }
      // Cross-repository overrides are an explicit working view, not commits
      // that a later builder could accidentally publish in the parent PR.
      const plan = { repository, headSha: source, children };
      composed.set(key, plan);
      return plan;
    };
    const checkouts = new Map<string, { plan: Composition; modules: string[] }>();
    const addCheckout = (cwd: string, plan: Composition) => {
      if (checkouts.size >= 100 || !safePreviewPath(cwd))
        throw new PreviewConvergenceError(
          "preview_submodule_topology_invalid",
          "The candidate has too many or invalid preview checkouts.",
          false,
        );
      const previous = checkouts.get(cwd);
      if (previous && previous.plan.headSha !== plan.headSha)
        throw new PreviewConvergenceError(
          "preview_submodule_topology_invalid",
          "The candidate maps conflicting heads to the same checkout.",
          false,
        );
      if (previous) return;
      checkouts.set(cwd, { plan, modules: plan.children.map((child) => child.module.path) });
      for (const child of plan.children) addCheckout(`${cwd}/${child.module.path}`, child.plan);
    };
    for (const [name, base] of bases)
      if (base.active) addCheckout(base.cwd, await compose(name, base.sha));
    // Validate all nested paths and staged/working edits before moving any
    // parent. Only validated gitlink commit differences are managed overlays.
    const physicalCheckouts = new Map<string, string>();
    for (const [cwd, { modules }] of checkouts) {
      const physical = await this.assertCheckout(input.workspace, cwd);
      const alias = physicalCheckouts.get(physical);
      if (alias && alias !== cwd)
        throw new PreviewConvergenceError(
          "preview_submodule_topology_invalid",
          "Different candidate paths resolve to the same checkout.",
          false,
        );
      physicalCheckouts.set(physical, cwd);
      if (modules.length || ![...bases.values()].some((base) => base.cwd === cwd))
        await this.assertCompositionClean(input.workspace, cwd, modules, environment);
    }
    const applied: AppliedPreviewRepository[] = [];
    for (const [cwd, { plan, modules }] of checkouts) {
      await input.onProgress?.();
      const base = bases.get(plan.repository);
      if (!base) throw new Error("preview_repository_lookup_failed");
      if (cwd !== base.cwd) {
        const source = await this.assertCheckout(input.workspace, base.cwd);
        // Local object transport is restricted to an already validated,
        // connected clone inside this same retained workspace.
        await this.requireGit(
          input.workspace,
          cwd,
          environment,
          [
            "-c",
            "protocol.file.allow=always",
            "fetch",
            "--no-recurse-submodules",
            "--no-tags",
            "--no-write-fetch-head",
            source,
            plan.headSha,
          ],
          candidateFailure,
        );
      }
      await this.applyRepository(
        input.workspace,
        cwd,
        grouped.get(plan.repository) ?? [],
        environment,
        input.onProgress,
        configured.get(plan.repository)?.developmentBranch ??
          configured.get(plan.repository)?.defaultBranch,
        plan.headSha,
        modules,
        cwd === base.cwd ? base.managed : undefined,
      );
      applied.push({
        repository: plan.repository,
        cwd,
        headSha: plan.headSha,
        submodules: plan.children.map((child) => ({
          path: child.module.path,
          repository: child.module.repository,
          pinnedSha: child.module.pin,
          headSha: child.plan.headSha,
        })),
      });
    }
    return applied;
  }

  async verify(
    workspace: WorkspaceLocator,
    sources: AppliedPreviewRepository[],
    environment: Record<string, string>,
  ) {
    this.validatedCheckouts.clear();
    for (const source of sources) {
      await this.assertCheckout(workspace, source.cwd);
      const head = await this.requireGit(
        workspace,
        source.cwd,
        environment,
        ["rev-parse", "HEAD"],
        candidateFailure,
      );
      const complete = source.submodules.every((module) =>
        sources.some(
          (child) =>
            child.cwd === `${source.cwd}/${module.path}` &&
            child.repository === module.repository &&
            child.headSha === module.headSha,
        ),
      );
      if (head.stdout.trim() !== source.headSha || !complete)
        throw new PreviewConvergenceError(
          "preview_generation_verification_failed",
          "Prepared application source differs from the exact composed preview candidate.",
          false,
          { repository: source.repository, path: source.cwd },
        );
      await this.assertCompositionClean(
        workspace,
        source.cwd,
        source.submodules.map((module) => module.path),
        environment,
      );
    }
  }

  private async assertCheckout(workspace: WorkspaceLocator, cwd: string) {
    const validated = this.validatedCheckouts.get(cwd);
    if (validated) return validated;
    if (!safePreviewPath(cwd))
      throw new PreviewConvergenceError(
        "preview_submodule_checkout_unsafe",
        "A preview checkout path is invalid.",
        false,
      );
    const result = await this.runtime.exec(workspace, {
      signal: this.signal,
      command: "node",
      args: ["-e", validatePreviewCheckout, cwd],
      cwd: ".",
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0)
      throw new PreviewConvergenceError(
        "preview_submodule_checkout_unsafe",
        "A required preview checkout is missing, uninitialized or escapes the retained workspace.",
        false,
        { path: cwd },
      );
    await this.requireGit(workspace, cwd, {}, ["rev-parse", "--git-dir"], candidateFailure);
    const top = await this.requireGit(
      workspace,
      cwd,
      {},
      ["rev-parse", "--show-toplevel"],
      candidateFailure,
    );
    if (top.stdout.trim() !== result.stdout.trim())
      throw new PreviewConvergenceError(
        "preview_submodule_checkout_unsafe",
        "A preview Git directory points at another worktree.",
        false,
        { path: cwd },
      );
    this.validatedCheckouts.set(cwd, result.stdout.trim());
    return result.stdout.trim();
  }

  private async assertCompositionClean(
    workspace: WorkspaceLocator,
    cwd: string,
    modules: string[],
    environment: Record<string, string>,
  ) {
    const staged = await this.requireGit(
      workspace,
      cwd,
      environment,
      ["diff", "--cached", "--name-only", "--no-renames", "-z", "--"],
      dirtyReadFailure,
    );
    const tracked = await this.requireGit(
      workspace,
      cwd,
      environment,
      [
        "status",
        "--porcelain",
        "--untracked-files=no",
        "--ignore-submodules=untracked",
        "--",
        ".",
        ...modules.map((path) => `:(exclude,literal)${path}`),
      ],
      dirtyReadFailure,
    );
    if (staged.stdout || tracked.stdout.trim())
      throw new PreviewConvergenceError(
        "preview_dirty_worktree",
        "Save tracked local edits before publishing an exact preview candidate.",
        false,
        { path: cwd },
      );
  }

  private async ensureCommit(
    workspace: WorkspaceLocator,
    cwd: string,
    sha: string,
    environment: Record<string, string>,
  ) {
    if (!/^[a-f0-9]{40}$/.test(sha))
      throw new PreviewConvergenceError(
        "preview_submodule_topology_invalid",
        "The submodule candidate does not identify a commit.",
        false,
      );
    const present = await this.git(workspace, cwd, environment, [
      "cat-file",
      "-e",
      `${sha}^{commit}`,
    ]);
    if (present.exitCode !== 0)
      await this.requireGit(
        workspace,
        cwd,
        environment,
        ["fetch", "--no-recurse-submodules", "--no-tags", "origin", sha],
        candidateFailure,
      );
    await this.requireGit(
      workspace,
      cwd,
      environment,
      ["cat-file", "-e", `${sha}^{commit}`],
      candidateFailure,
    );
  }

  private async submodules(
    workspace: WorkspaceLocator,
    cwd: string,
    sha: string,
    environment: Record<string, string>,
    repository: string,
    connected: Set<string>,
  ) {
    const metadata = await this.requireGit(
      workspace,
      cwd,
      environment,
      ["ls-tree", "-z", sha, "--", ".gitmodules"],
      candidateFailure,
    );
    const entry = previewTreeEntries(metadata.stdout)[0];
    if (!entry) {
      if (connected.size > 1) {
        const modes = await this.requireGit(
          workspace,
          cwd,
          environment,
          ["ls-tree", "-r", "--format=%(objectmode)", sha],
          candidateFailure,
        );
        if (modes.stdout.split("\n").includes("160000"))
          throw new PreviewConvergenceError(
            "preview_submodule_topology_invalid",
            "A candidate contains gitlinks without tracked submodule metadata.",
            false,
          );
      }
      return [];
    }
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
      throw new PreviewConvergenceError(
        "preview_submodule_topology_invalid",
        "Candidate submodule metadata must be a regular tracked file.",
        false,
      );
    const size = await this.requireGit(
      workspace,
      cwd,
      environment,
      ["cat-file", "-s", entry.sha],
      candidateFailure,
    );
    if (Number(size.stdout.trim()) > 64_000)
      throw new PreviewConvergenceError(
        "preview_submodule_topology_invalid",
        "Candidate submodule metadata is too large.",
        false,
      );
    const config = await this.git(workspace, cwd, environment, [
      "config",
      "--null",
      "--no-includes",
      "--blob",
      `${sha}:.gitmodules`,
      "--get-regexp",
      "^submodule\\..*\\.(path|url)$",
    ]);
    if (![0, 1].includes(config.exitCode))
      throw new PreviewConvergenceError(
        "preview_submodule_topology_invalid",
        "Candidate submodule metadata is invalid.",
        false,
      );
    const tree = await this.requireGit(
      workspace,
      cwd,
      environment,
      ["ls-tree", "-r", "-z", sha],
      candidateFailure,
    );
    return connectedPreviewSubmodules(
      config.stdout,
      previewTreeEntries(tree.stdout),
      repository,
      connected,
    );
  }

  private async applyRepository(
    workspace: WorkspaceLocator,
    cwd: string,
    targets: PreviewGenerationRepository[],
    environment: Record<string, string>,
    onProgress?: () => Promise<unknown>,
    baseBranch = "main",
    candidateOverride?: string,
    composedPaths: string[] = [],
    managedOverride?: string | null,
  ) {
    await this.assertCheckout(workspace, cwd);
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
    const managed =
      managedOverride === undefined
        ? await this.directRef(workspace, cwd, environment, PREVIEW_MANAGED_REF)
        : managedOverride;
    if (!targets.length && !managed && !candidateOverride) return;
    const dirty = await this.dirtySnapshot(workspace, cwd, environment, composedPaths);
    const failure = candidateFailure;
    const candidate =
      candidateOverride ??
      (await this.repositoryCandidate(
        workspace,
        cwd,
        targets,
        environment,
        onProgress,
        baseBranch,
      ));
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
    // Only independently validated child commit overrides are excluded. All
    // other tracked overlays, including staged gitlinks, remain unfinished work.
    const tracked = await this.requireGit(
      workspace,
      cwd,
      environment,
      [
        "status",
        "--porcelain",
        "--untracked-files=no",
        "--ignore-submodules=untracked",
        "--",
        ".",
        ...composedPaths.map((path) => `:(exclude,literal)${path}`),
      ],
      dirtyReadFailure,
    );
    if (tracked.stdout.trim())
      throw new PreviewConvergenceError(
        "preview_dirty_worktree",
        "Save tracked local edits before publishing an exact preview candidate.",
        false,
      );
    const preview = previewBranchRefs(workspace.id, cwd);
    const previous = await this.directRef(workspace, cwd, environment, preview.ref);
    const owner = await this.directRef(workspace, cwd, environment, preview.ownershipRef);
    if ((previous && (!owner || previous !== owner || owner !== managed)) || (!previous && owner))
      throw new PreviewConvergenceError(
        "preview_branch_changed",
        "The local preview branch is unowned or has changed outside preview convergence.",
        false,
      );
    const worktrees = await this.requireGit(
      workspace,
      cwd,
      environment,
      ["worktree", "list", "--porcelain", "-z"],
      failure,
    );
    const root = (
      await this.requireGit(workspace, cwd, environment, ["rev-parse", "--show-toplevel"], failure)
    ).stdout.trim();
    const other = worktrees.stdout.split("\0\0").filter((entry) => {
      const fields = entry.split("\0");
      return fields.includes(`branch ${preview.ref}`) && !fields.includes(`worktree ${root}`);
    });
    let ownSubmodule = false;
    if (other.length === 1) {
      const superproject = await this.requireGit(
        workspace,
        cwd,
        environment,
        ["rev-parse", "--show-superproject-working-tree"],
        failure,
      );
      if (superproject.stdout.trim()) {
        const directory = (
          await this.requireGit(
            workspace,
            cwd,
            environment,
            ["rev-parse", "--absolute-git-dir"],
            failure,
          )
        ).stdout.trim();
        const common = (
          await this.requireGit(
            workspace,
            cwd,
            environment,
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            failure,
          )
        ).stdout.trim();
        // Git reports a submodule's main worktree using its absorbed Git
        // directory. This does not authorize a branch in a linked worktree.
        ownSubmodule =
          directory === common && !!other[0]?.split("\0").includes(`worktree ${directory}`);
      }
    }
    if (other.length && !ownSubmodule)
      throw new PreviewConvergenceError(
        "preview_branch_in_use",
        "The local preview branch is checked out in another worktree.",
        false,
        { path: cwd },
      );
    for (const displaced of new Set([current, previous])) {
      if (!displaced || displaced === candidate) continue;
      // Keep both displaced HEAD and preview tips. Never reset, clean or push.
      await this.requireGit(
        workspace,
        cwd,
        environment,
        ["update-ref", `refs/facility/retained/${randomUUID()}`, displaced],
        failure,
      );
    }
    const symbolic = await this.git(workspace, cwd, environment, ["symbolic-ref", "-q", "HEAD"]);
    if (current !== candidate || symbolic.stdout.trim() !== preview.ref) {
      await onProgress?.();
      // First check out the exact tree without moving any branch. Ignored files
      // remain protected even when an owned preview branch must rewind.
      await this.requireGit(
        workspace,
        cwd,
        environment,
        ["checkout", "--no-recurse-submodules", "--detach", "--no-overwrite-ignore", candidate],
        {
          code: "preview_checkout_blocked",
          message: "The preview candidate would overwrite a retained local path.",
          retryable: false,
        },
      );
    }
    const zero = "0".repeat(40);
    await this.requireGit(
      workspace,
      cwd,
      environment,
      ["update-ref", "--stdin"],
      {
        code: "preview_branch_changed",
        message: "The local preview references changed before the candidate could be attached.",
        retryable: false,
      },
      [
        "start",
        "option no-deref",
        `update ${preview.ref} ${candidate} ${previous ?? zero}`,
        `update ${preview.ownershipRef} ${candidate} ${owner ?? zero}`,
        `update ${PREVIEW_MANAGED_REF} ${candidate} ${managed ?? zero}`,
        "prepare",
        "commit",
        "",
      ].join("\n"),
    );
    await this.requireGit(
      workspace,
      cwd,
      environment,
      ["switch", "--no-recurse-submodules", "--no-overwrite-ignore", preview.branch],
      {
        code: "preview_checkout_blocked",
        message: "The exact preview candidate could not be attached to its local preview branch.",
        retryable: false,
      },
    );
    if (
      (
        await this.requireGit(workspace, cwd, environment, ["rev-parse", "HEAD"], failure)
      ).stdout.trim() !== candidate ||
      (
        await this.requireGit(workspace, cwd, environment, ["symbolic-ref", "-q", "HEAD"], failure)
      ).stdout.trim() !== preview.ref
    )
      throw new PreviewConvergenceError(
        "preview_generation_verification_failed",
        "The retained repository is not the exact reconstructed candidate.",
        false,
      );
    await this.assertDirtyPreserved(workspace, cwd, environment, dirty);
  }

  private async repositoryCandidate(
    workspace: WorkspaceLocator,
    cwd: string,
    targets: PreviewGenerationRepository[],
    environment: Record<string, string>,
    onProgress?: () => Promise<unknown>,
    baseBranch = "main",
  ) {
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
      ["fetch", "--no-recurse-submodules", "--no-tags", "origin", `refs/heads/${baseBranch}`],
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
        ["fetch", "--no-recurse-submodules", "--no-tags", "origin", target.headSha],
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
      const integrated = await this.integratedCommit?.(target);
      if (integrated) {
        if (!/^[a-f\d]{40}$/i.test(integrated)) {
          throw new PreviewConvergenceError(
            "preview_merge_commit_invalid",
            "The required PR's integration commit is invalid.",
            false,
          );
        }
        await this.requireGit(
          workspace,
          cwd,
          environment,
          ["fetch", "--no-recurse-submodules", "--no-tags", "origin", integrated],
          {
            code: "preview_commit_unavailable",
            message: "A required PR's integration commit is not fetchable.",
            retryable: true,
          },
        );
        await this.requireGit(
          workspace,
          cwd,
          environment,
          ["cat-file", "-e", `${integrated}^{commit}`],
          failure,
        );
        // Squash and rebase merges replace the original PR head's ancestry.
        // Skip it only when Git proves its confirmed integration is already here.
        if (await this.isAncestor(workspace, cwd, environment, integrated, candidate)) continue;
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
    return candidate;
  }

  private async directRef(
    workspace: WorkspaceLocator,
    cwd: string,
    environment: Record<string, string>,
    ref: string,
  ) {
    const symbolic = await this.git(workspace, cwd, environment, ["symbolic-ref", "-q", ref]);
    if (symbolic.exitCode !== 1)
      throw new PreviewConvergenceError(
        "preview_branch_changed",
        "Facility preview references must be direct local references.",
        false,
      );
    const result = await this.git(workspace, cwd, environment, [
      "rev-parse",
      "--verify",
      "--quiet",
      ref,
    ]);
    if (result.exitCode === 1) return null;
    if (result.exitCode === 0) return result.stdout.trim();
    throw new PreviewConvergenceError(
      "preview_branch_unavailable",
      "Facility could not inspect the local preview references.",
      true,
    );
  }

  private async dirtySnapshot(
    workspace: WorkspaceLocator,
    cwd: string,
    environment: Record<string, string>,
    composedPaths: string[] = [],
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
    const names = [...new Set(results.flatMap((result) => paths(result.stdout)))]
      .filter((path) => !composedPaths.includes(path))
      .sort();
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
    stdin?: string,
  ) {
    const result = await this.git(workspace, cwd, environment, args, stdin);
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
    stdin?: string,
  ): Promise<WorkspaceCommandResult> {
    this.signal?.throwIfAborted();
    return this.runtime.exec(workspace, {
      signal: this.signal,
      command: "git",
      args,
      cwd,
      env: environment,
      stdin,
      timeoutMs: 5 * 60_000,
    });
  }
}

const dirtyReadFailure = {
  code: "preview_dirty_state_unavailable",
  message: "Facility could not inspect local workspace edits safely.",
  retryable: true,
};

const candidateFailure = {
  code: "preview_candidate_build_failed",
  message: "Facility could not reconstruct the complete preview candidate.",
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
