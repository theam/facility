import { createHash } from "node:crypto";
import { newId } from "@facility/core";
import {
  type FacilityDb,
  stories,
  storyEvidenceEvents,
  storyExports,
  turns,
  workspaces,
} from "@facility/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { appendStoryEvidence } from "../stories/evidence.js";
import { parseGitLog, parseNameStatus } from "../turns/git-evidence.js";
import {
  localSourceRef,
  type ProjectEnvironmentService,
  type ProjectManifestSource,
  repositoryPath,
} from "../workspaces/project-environment.js";
import type { WorkspaceLocator, WorkspaceRuntime } from "../workspaces/runtime.js";
import { loadProjectSource, type RepositoryAccess } from "./sources.js";

const MAX_COMMITS = 500;
const MAX_CHANGED_FILES = 2_000;
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
const REVIEW_TYPES = ["local_review.approved", "local_review.changes_requested"];

export type ReviewActor = { type: "user" | "service" | "system"; id: string };

export class LocalReviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "LocalReviewError";
  }
}

/**
 * Review, checks, source refresh and export for stories whose project uses a
 * local repository. Approval is recorded against one exact commit: any later
 * commit or uncommitted change makes it stale, and only an approved, clean head
 * can be exported. Exporting never merges into the user's repository.
 */
export class LocalReviewService {
  constructor(
    private readonly db: FacilityDb,
    private readonly runtime: WorkspaceRuntime,
    private readonly credentials: RepositoryAccess,
    private readonly manifests: ProjectManifestSource,
    private readonly environment: ProjectEnvironmentService,
  ) {}

  async state(
    orgId: string,
    projectId: string,
    storyId: string,
    options: { wake: boolean } = { wake: true },
  ) {
    const context = await this.context(orgId, projectId, storyId, options);
    return this.describe(context);
  }

  async approve(
    input: { orgId: string; projectId: string; storyId: string; commitSha: string; note?: string },
    actor: ReviewActor,
  ) {
    const context = await this.context(input.orgId, input.projectId, input.storyId);
    await this.assertIdle(context);
    const state = await this.describe(context);
    if (state.headSha !== input.commitSha) {
      throw new LocalReviewError(
        "review_commit_mismatch",
        `The story is now at ${state.headSha.slice(0, 12)}; review the latest changes before approving`,
      );
    }
    if (state.currentBranch !== state.branch) {
      throw new LocalReviewError(
        "story_branch_not_checked_out",
        `The workspace is on ${state.currentBranch || "a detached HEAD"}, not the story branch ${state.branch}`,
      );
    }
    if (state.dirty) {
      throw new LocalReviewError(
        "uncommitted_changes",
        "The workspace has uncommitted changes. Ask the agent to commit or discard them before approving.",
      );
    }
    if (state.commits.length === 0) {
      throw new LocalReviewError("no_changes", "The story branch has no commits to approve");
    }
    await appendStoryEvidence(this.db, {
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      source: "facility",
      type: "local_review.approved",
      data: {
        repositoryId: context.repository.id,
        branch: state.branch,
        baseSha: state.baseSha,
        commitSha: state.headSha,
        note: input.note ?? null,
        reviewer: actor,
      },
    });
    return this.describe(context);
  }

  async requestChanges(
    input: {
      orgId: string;
      projectId: string;
      storyId: string;
      commitSha?: string;
      note: string;
    },
    actor: ReviewActor,
  ) {
    const context = await this.context(input.orgId, input.projectId, input.storyId);
    const state = await this.describe(context);
    await appendStoryEvidence(this.db, {
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      source: "facility",
      type: "local_review.changes_requested",
      data: {
        repositoryId: context.repository.id,
        branch: state.branch,
        commitSha: input.commitSha ?? state.headSha,
        note: input.note,
        reviewer: actor,
      },
    });
    return this.describe(context);
  }

  async runChecks(input: { orgId: string; projectId: string; storyId: string }) {
    const context = await this.context(input.orgId, input.projectId, input.storyId);
    await this.assertIdle(context);
    const manifest = await this.manifests.load(input.orgId, input.projectId);
    const outcome = await this.environment.runChecks({
      orgId: input.orgId,
      projectId: input.projectId,
      workspace: context.locator,
      manifest,
      credentials: context.credentials,
    });
    for (const result of outcome.results) {
      await appendStoryEvidence(this.db, {
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: input.storyId,
        source: "workspace",
        type: "local_check.completed",
        data: {
          repositoryId: context.repository.id,
          commitSha: outcome.commitSha,
          dirty: outcome.dirty,
          commitChanged: outcome.commitChanged,
          ...result,
        },
      });
    }
    return this.describe(context);
  }

  async refreshSource(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    repositoryId?: string;
  }) {
    const context = await this.context(input.orgId, input.projectId, input.storyId);
    await this.assertIdle(context);
    const manifest = await this.manifests.load(input.orgId, input.projectId);
    const refreshed = await this.environment.refreshLocalSource({
      orgId: input.orgId,
      projectId: input.projectId,
      workspace: context.locator,
      manifest,
      credentials: context.credentials,
      repositoryId: input.repositoryId ?? context.repository.id,
    });
    await appendStoryEvidence(this.db, {
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      source: "workspace",
      type: "local_source.refreshed",
      data: { repositoryId: input.repositoryId ?? context.repository.id, ...refreshed },
    });
    // The recorded source revision changed; describe the refreshed workspace.
    const current = await this.context(input.orgId, input.projectId, input.storyId);
    return { ...(await this.describe(current)), refresh: refreshed };
  }

  async createExport(
    input: { orgId: string; projectId: string; storyId: string },
    actor: ReviewActor,
  ) {
    const context = await this.context(input.orgId, input.projectId, input.storyId);
    await this.assertIdle(context);
    const state = await this.describe(context);
    if (state.approval.status !== "approved" || !state.approval.eventId) {
      throw new LocalReviewError(
        state.approval.status === "stale" ? "approval_stale" : "approval_required",
        state.approval.status === "stale"
          ? "The approved commit is no longer the story's head; review and approve the latest changes"
          : "Approve the story's latest commit before exporting it",
      );
    }
    const id = newId("sexp");
    const file = `.facility/exports/${id}.bundle`;
    const depth = context.cwd.split("/").length;
    const relativeFile = `${"../".repeat(depth)}${file}`;
    await this.exec(context, "sh", ["-c", "mkdir -p .facility/exports"], ".");
    try {
      await this.git(context, [
        "bundle",
        "create",
        "--quiet",
        relativeFile,
        `refs/heads/${state.branch}`,
        `^${state.baseSha}`,
      ]);
      await this.git(context, ["bundle", "verify", "--quiet", relativeFile]);
      const encoded = (await this.exec(context, "base64", [file], ".")).replace(/\s+/g, "");
      const bundle = Buffer.from(encoded, "base64");
      if (bundle.length === 0 || bundle.length > MAX_EXPORT_BYTES) {
        throw new LocalReviewError(
          "export_too_large",
          `The export bundle must be between 1 and ${MAX_EXPORT_BYTES} bytes`,
          413,
        );
      }
      const patch = await this.git(context, [
        "format-patch",
        "--stdout",
        "--binary",
        `${state.baseSha}..${state.headSha}`,
      ]);
      const bundleSha256 = createHash("sha256").update(bundle).digest("hex");
      const row = (
        await this.db
          .insert(storyExports)
          .values({
            id,
            orgId: input.orgId,
            projectId: input.projectId,
            storyId: input.storyId,
            repositoryId: context.repository.id,
            reviewEventId: state.approval.eventId,
            branch: state.branch,
            baseSha: state.baseSha,
            headSha: state.headSha,
            commitCount: state.commits.length,
            bundle,
            bundleSha256,
            patch,
            createdBy: actor,
          })
          .returning(exportColumns)
      )[0];
      await appendStoryEvidence(this.db, {
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: input.storyId,
        source: "facility",
        type: "local_export.created",
        data: {
          exportId: id,
          repositoryId: context.repository.id,
          baseSha: state.baseSha,
          headSha: state.headSha,
          commitCount: state.commits.length,
          bundleSha256,
        },
      });
      if (!row) throw new LocalReviewError("export_failed", "The export could not be saved", 500);
      return {
        export: presentExport(row, context.repository.defaultBranch),
        state: await this.describe(context),
      };
    } finally {
      await this.exec(context, "rm", ["-f", file], ".").catch(() => undefined);
    }
  }

  async exportFile(input: { orgId: string; projectId: string; storyId: string; exportId: string }) {
    const row = (
      await this.db
        .select()
        .from(storyExports)
        .where(
          and(
            eq(storyExports.orgId, input.orgId),
            eq(storyExports.projectId, input.projectId),
            eq(storyExports.storyId, input.storyId),
            eq(storyExports.id, input.exportId),
          ),
        )
        .limit(1)
    )[0];
    if (!row) throw new LocalReviewError("export_not_found", "Export not found", 404);
    return row;
  }

  private async context(
    orgId: string,
    projectId: string,
    storyId: string,
    options: { wake: boolean } = { wake: true },
  ) {
    // Checked first: a GitHub project must never mint GitHub credentials for this surface.
    if ((await loadProjectSource(this.db, orgId, projectId)) !== "local") {
      throw new LocalReviewError(
        "local_review_unavailable",
        "Local review applies to projects backed by a local repository; GitHub projects review through pull requests",
      );
    }
    const story = (
      await this.db
        .select()
        .from(stories)
        .where(
          and(eq(stories.orgId, orgId), eq(stories.projectId, projectId), eq(stories.id, storyId)),
        )
        .limit(1)
    )[0];
    if (!story || story.deletedAt) {
      throw new LocalReviewError("story_not_found", "Story not found", 404);
    }
    const credentials = await this.credentials.issue(orgId, projectId);
    const repository = credentials.repositories.find((candidate) => candidate.role === "primary");
    if (repository?.source !== "local" || !repository.id) {
      throw new LocalReviewError(
        "local_review_unavailable",
        "Local review applies to projects backed by a local repository; GitHub projects review through pull requests",
      );
    }
    const workspace = (
      await this.db
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.orgId, orgId),
            eq(workspaces.projectId, projectId),
            eq(workspaces.storyId, storyId),
            inArray(workspaces.state, ["creating", "running", "sleeping", "error"]),
          ),
        )
        .limit(1)
    )[0];
    if (!workspace?.externalRef) {
      throw new LocalReviewError("workspace_not_found", "The story has no workspace yet", 404);
    }
    const imported = workspace.sourceRevisions[repository.id];
    if (!story.branch || !imported) {
      throw new LocalReviewError(
        "workspace_not_prepared",
        "The workspace has not imported the repository yet; wait for the first turn to start",
      );
    }
    const locator = workspaceLocator(workspace);
    if (workspace.state !== "running") {
      if (!options.wake) {
        throw new LocalReviewError(
          "workspace_not_running",
          "The workspace is suspended. Someone who can run workspaces must open the review to wake it.",
        );
      }
      await this.runtime.wake(locator);
      await this.db
        .update(workspaces)
        .set({ state: "running", error: null, lastActivityAt: new Date(), updatedAt: new Date() })
        .where(and(eq(workspaces.orgId, orgId), eq(workspaces.id, workspace.id)));
    }
    return {
      orgId,
      projectId,
      story,
      branch: story.branch,
      workspace,
      locator,
      credentials,
      repository: { ...repository, id: repository.id },
      imported,
      cwd: repositoryPath(repository),
    };
  }

  private async describe(context: Awaited<ReturnType<LocalReviewService["context"]>>) {
    const sourceRef = localSourceRef(context.repository);
    const [headSha, currentBranch, status] = await Promise.all([
      this.git(context, ["rev-parse", "HEAD"]),
      this.git(context, ["branch", "--show-current"]),
      this.git(context, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    const branchHead = await this.git(context, ["rev-parse", `refs/heads/${context.branch}`]).catch(
      () => headSha,
    );
    const baseSha = await this.git(context, ["merge-base", branchHead, sourceRef]);
    const [log, diff] = await Promise.all([
      this.git(context, [
        "log",
        "--reverse",
        `--max-count=${MAX_COMMITS}`,
        "--format=%H%x1f%an%x1f%aI%x1f%s%x1e",
        branchHead,
        "--not",
        baseSha,
      ]),
      this.git(context, ["diff", "--name-status", "-z", baseSha, branchHead, "--"]),
    ]);
    const commits = parseGitLog(log);
    const changedFiles = parseNameStatus(diff).slice(0, MAX_CHANGED_FILES);
    const uncommitted = status
      .split("\0")
      .filter(Boolean)
      .map((entry) => ({ status: entry.slice(0, 2).trim(), path: entry.slice(3) }))
      .filter((entry) => entry.path)
      .slice(0, MAX_CHANGED_FILES);
    const dirty = uncommitted.length > 0;

    const [reviewRows, checkRows, exportRows] = await Promise.all([
      this.db
        .select()
        .from(storyEvidenceEvents)
        .where(
          and(
            eq(storyEvidenceEvents.orgId, context.orgId),
            eq(storyEvidenceEvents.storyId, context.story.id),
            inArray(storyEvidenceEvents.type, REVIEW_TYPES),
          ),
        )
        .orderBy(desc(storyEvidenceEvents.occurredAt), desc(storyEvidenceEvents.observedAt))
        .limit(20),
      this.db
        .select()
        .from(storyEvidenceEvents)
        .where(
          and(
            eq(storyEvidenceEvents.orgId, context.orgId),
            eq(storyEvidenceEvents.storyId, context.story.id),
            eq(storyEvidenceEvents.type, "local_check.completed"),
          ),
        )
        .orderBy(desc(storyEvidenceEvents.occurredAt))
        .limit(200),
      this.db
        .select(exportColumns)
        .from(storyExports)
        .where(
          and(
            eq(storyExports.orgId, context.orgId),
            eq(storyExports.projectId, context.projectId),
            eq(storyExports.storyId, context.story.id),
          ),
        )
        .orderBy(desc(storyExports.createdAt))
        .limit(50),
    ]);

    const latest = reviewRows[0];
    const latestData = (latest?.data ?? {}) as {
      commitSha?: string;
      note?: string;
      reviewer?: unknown;
    };
    const approvalStatus = !latest
      ? "none"
      : latest.type === "local_review.changes_requested"
        ? "changes_requested"
        : latestData.commitSha === branchHead && headSha === branchHead && !dirty
          ? "approved"
          : "stale";

    const checks = new Map<string, Record<string, unknown>>();
    for (const row of checkRows) {
      const data = row.data as { name?: string; commitSha?: string };
      if (!data.name || data.commitSha !== branchHead || checks.has(data.name)) continue;
      checks.set(data.name, {
        ...(row.data as Record<string, unknown>),
        recordedAt: row.occurredAt,
      });
    }

    const blockers: string[] = [];
    if (currentBranch !== context.branch) blockers.push("story_branch_not_checked_out");
    if (dirty) blockers.push("uncommitted_changes");
    if (commits.length === 0) blockers.push("no_changes");
    if (approvalStatus !== "approved") blockers.push("approval_required");

    return {
      repository: {
        id: context.repository.id,
        name: context.repository.name,
        defaultBranch: context.repository.defaultBranch,
      },
      branch: context.branch,
      currentBranch,
      headSha: branchHead,
      baseSha,
      sourceRevision: context.imported.revision,
      initialSourceRevision: context.imported.initialRevision,
      sourceImportedAt: context.imported.importedAt,
      dirty,
      uncommitted,
      commits,
      changedFiles,
      approval: {
        status: approvalStatus as "none" | "approved" | "stale" | "changes_requested",
        commitSha: latestData.commitSha ?? null,
        note: latestData.note ?? null,
        reviewer: latestData.reviewer ?? null,
        reviewedAt: latest?.occurredAt ?? null,
        eventId: latest?.type === "local_review.approved" ? latest.id : null,
      },
      checks: [...checks.values()],
      exports: exportRows.map((row) => presentExport(row, context.repository.defaultBranch)),
      exportable: blockers.length === 0,
      blockers,
    };
  }

  private async assertIdle(context: { orgId: string; projectId: string; story: { id: string } }) {
    const active = await this.db
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(
          eq(turns.orgId, context.orgId),
          eq(turns.projectId, context.projectId),
          eq(turns.storyId, context.story.id),
          inArray(turns.state, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (active.length > 0) {
      throw new LocalReviewError(
        "turn_active",
        "An agent turn is queued or running; wait for it to finish",
      );
    }
  }

  private async git(context: { locator: WorkspaceLocator; cwd: string }, args: string[]) {
    return (await this.exec(context, "git", args, context.cwd)).trim();
  }

  private async exec(
    context: { locator: WorkspaceLocator },
    command: string,
    args: string[],
    cwd: string,
  ) {
    const result = await this.runtime.exec(context.locator, {
      command,
      args,
      cwd,
      timeoutMs: 10 * 60 * 1_000,
    });
    if (result.exitCode !== 0) {
      throw new LocalReviewError(
        "workspace_git_failed",
        `${command} ${args[0] ?? ""} failed: ${result.stderr.trim().slice(-2_000)}`,
      );
    }
    return result.stdout;
  }
}

const exportColumns = {
  id: storyExports.id,
  repositoryId: storyExports.repositoryId,
  reviewEventId: storyExports.reviewEventId,
  branch: storyExports.branch,
  baseSha: storyExports.baseSha,
  headSha: storyExports.headSha,
  commitCount: storyExports.commitCount,
  bundleSha256: storyExports.bundleSha256,
  createdBy: storyExports.createdBy,
  createdAt: storyExports.createdAt,
};

type ExportRow = {
  id: string;
  branch: string;
  baseSha: string;
  headSha: string;
  commitCount: number;
  bundleSha256: string;
  createdBy: unknown;
  createdAt: Date;
};

export function exportReviewBranch(row: { id: string; branch: string }) {
  return `facility-review/${row.branch.replace(/^facility\//, "")}-${row.id.slice(-6)}`;
}

function presentExport(row: ExportRow, defaultBranch: string) {
  const reviewBranch = exportReviewBranch(row);
  const bundleFile = `${row.id}.bundle`;
  return {
    id: row.id,
    branch: row.branch,
    baseSha: row.baseSha,
    headSha: row.headSha,
    commitCount: row.commitCount,
    bundleSha256: row.bundleSha256,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    reviewBranch,
    // Importing creates a new branch in the user's repository. Merging stays their decision.
    instructions: [
      `git fetch ./${bundleFile} "refs/heads/${row.branch}:refs/heads/${reviewBranch}"`,
      `git log --oneline ${defaultBranch}..${reviewBranch}`,
      `git merge ${reviewBranch}   # when you are ready; resolve any conflicts as usual`,
    ],
    patchInstructions: [`git am ./${row.id}.patch`],
  };
}

function workspaceLocator(row: typeof workspaces.$inferSelect): WorkspaceLocator {
  const environment = row.environment as {
    image?: string;
    variables?: Record<string, string>;
    ports?: WorkspaceLocator["ports"];
    resources?: WorkspaceLocator["resources"];
  };
  if (!row.externalRef || typeof environment.image !== "string") {
    throw new LocalReviewError("workspace_not_ready", "Workspace is not ready");
  }
  return {
    id: row.id,
    image: environment.image,
    environment: environment.variables ?? {},
    ports: Array.isArray(environment.ports) ? environment.ports : [],
    resources: environment.resources,
    externalRef: row.externalRef,
    volumeRef: row.volumeRef,
  };
}
