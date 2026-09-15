import { type FacilityDb, turnGitEvidence } from "@facility/db";
import { and, eq } from "drizzle-orm";
import { appendStoryEvidence } from "../stories/evidence.js";
import type { WorkspaceLocator, WorkspaceRuntime } from "../workspaces/runtime.js";

const MAX_COMMITS = 500;
const MAX_CHANGED_FILES = 2_000;

export type GitCommitEvidence = {
  sha: string;
  author: string;
  authoredAt: string;
  subject: string;
};

export type ChangedFileEvidence = {
  status: string;
  path: string;
  previousPath?: string;
};

export type StartedGitEvidence = {
  orgId: string;
  projectId: string;
  storyId: string;
  turnId: string;
  workspaceId: string;
  engineSessionId: string;
  workspace: WorkspaceLocator;
  cwd: string;
  environment: Record<string, string>;
  initialBranch: string | null;
  initialSha: string;
};

export class TurnGitEvidenceService {
  constructor(
    private readonly db: FacilityDb,
    private readonly runtime: WorkspaceRuntime,
  ) {}

  async start(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    turnId: string;
    workspace: WorkspaceLocator;
    workspaceProvider: string;
    cwd: string;
    environment: Record<string, string>;
    engineSessionId: string;
    nativeSessionId?: string;
    agentName: string;
    engine: string;
    model: string;
  }): Promise<StartedGitEvidence> {
    const [initialSha, initialBranch] = await Promise.all([
      this.git(input.workspace, input.cwd, input.environment, ["rev-parse", "HEAD"]),
      this.git(input.workspace, input.cwd, input.environment, ["branch", "--show-current"]),
    ]);
    const startedAt = new Date();
    await this.db.insert(turnGitEvidence).values({
      turnId: input.turnId,
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      workspaceId: input.workspace.id,
      engineSessionId: input.engineSessionId,
      initialBranch: initialBranch || null,
      initialSha,
      startedAt,
    });
    await appendStoryEvidence(this.db, {
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      turnId: input.turnId,
      source: "workspace",
      type: "turn.context_recorded",
      externalKey: `turn:${input.turnId}:context`,
      occurredAt: startedAt,
      data: {
        agent: input.agentName,
        engine: input.engine,
        model: input.model,
        sessionId: input.engineSessionId,
        nativeSessionId: input.nativeSessionId ?? null,
        workspaceId: input.workspace.id,
        workspaceProvider: input.workspaceProvider,
        branch: initialBranch || null,
        initialSha,
      },
    });
    return {
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      turnId: input.turnId,
      workspaceId: input.workspace.id,
      engineSessionId: input.engineSessionId,
      workspace: input.workspace,
      cwd: input.cwd,
      environment: input.environment,
      initialBranch: initialBranch || null,
      initialSha,
    };
  }

  async complete(started: StartedGitEvidence) {
    const completedAt = new Date();
    try {
      const [finalSha, finalBranch, commitOutput, diffOutput, untrackedOutput, statusOutput] =
        await Promise.all([
          this.git(started.workspace, started.cwd, started.environment, ["rev-parse", "HEAD"]),
          this.git(started.workspace, started.cwd, started.environment, [
            "branch",
            "--show-current",
          ]),
          this.git(started.workspace, started.cwd, started.environment, [
            "log",
            "--reverse",
            `--max-count=${MAX_COMMITS}`,
            "--format=%H%x1f%an%x1f%aI%x1f%s%x1e",
            "HEAD",
            "--not",
            started.initialSha,
          ]),
          this.git(started.workspace, started.cwd, started.environment, [
            "diff",
            "--name-status",
            "-z",
            started.initialSha,
            "--",
          ]),
          this.git(started.workspace, started.cwd, started.environment, [
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
          ]),
          this.git(started.workspace, started.cwd, started.environment, [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
          ]),
        ]);
      const commits = parseGitLog(commitOutput).slice(0, MAX_COMMITS);
      const changedFiles = mergeChangedFiles(
        parseNameStatus(diffOutput),
        parseUntracked(untrackedOutput),
      ).slice(0, MAX_CHANGED_FILES);
      await this.db
        .update(turnGitEvidence)
        .set({
          finalBranch: finalBranch || null,
          finalSha,
          commits,
          changedFiles,
          dirty: statusOutput.length > 0,
          captureError: null,
          completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(turnGitEvidence.orgId, started.orgId),
            eq(turnGitEvidence.projectId, started.projectId),
            eq(turnGitEvidence.turnId, started.turnId),
          ),
        );
      await appendStoryEvidence(this.db, {
        orgId: started.orgId,
        projectId: started.projectId,
        storyId: started.storyId,
        turnId: started.turnId,
        source: "workspace",
        type: "git.changes_recorded",
        externalKey: `turn:${started.turnId}:git`,
        occurredAt: completedAt,
        data: {
          workspaceId: started.workspaceId,
          sessionId: started.engineSessionId,
          initialBranch: started.initialBranch,
          initialSha: started.initialSha,
          finalBranch: finalBranch || null,
          finalSha,
          commits,
          changedFiles,
          dirty: statusOutput.length > 0,
          truncated: commits.length === MAX_COMMITS || changedFiles.length === MAX_CHANGED_FILES,
        },
      });
      return { finalSha, finalBranch: finalBranch || null, commits, changedFiles };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.db
        .update(turnGitEvidence)
        .set({ captureError: detail.slice(0, 8_000), completedAt, updatedAt: completedAt })
        .where(
          and(
            eq(turnGitEvidence.orgId, started.orgId),
            eq(turnGitEvidence.projectId, started.projectId),
            eq(turnGitEvidence.turnId, started.turnId),
          ),
        );
      await appendStoryEvidence(this.db, {
        orgId: started.orgId,
        projectId: started.projectId,
        storyId: started.storyId,
        turnId: started.turnId,
        source: "workspace",
        type: "git.capture_failed",
        externalKey: `turn:${started.turnId}:git`,
        occurredAt: completedAt,
        data: { initialSha: started.initialSha, error: detail.slice(0, 8_000) },
      });
      return null;
    }
  }

  private async git(
    workspace: WorkspaceLocator,
    cwd: string,
    environment: Record<string, string>,
    args: string[],
  ) {
    const result = await this.runtime.exec(workspace, {
      command: "git",
      args,
      cwd,
      env: environment,
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `git ${args[0]} failed with exit ${result.exitCode}`);
    }
    return result.stdout.trimEnd();
  }
}

export function parseGitLog(value: string): GitCommitEvidence[] {
  return value
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const [sha, author, authoredAt, ...subject] = entry.split("\x1f");
      return sha && author && authoredAt
        ? [{ sha, author, authoredAt, subject: subject.join("\x1f") }]
        : [];
    });
}

export function parseNameStatus(value: string): ChangedFileEvidence[] {
  const fields = value.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const files: ChangedFileEvidence[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    const path = fields[index++];
    if (!status || !path) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const destination = fields[index++];
      if (!destination) break;
      files.push({ status, path: destination, previousPath: path });
    } else {
      files.push({ status, path });
    }
  }
  return files;
}

function parseUntracked(value: string): ChangedFileEvidence[] {
  return value
    .split("\0")
    .filter(Boolean)
    .map((path) => ({ status: "?", path }));
}

function mergeChangedFiles(...groups: ChangedFileEvidence[][]) {
  const byPath = new Map<string, ChangedFileEvidence>();
  for (const file of groups.flat()) if (!byPath.has(file.path)) byPath.set(file.path, file);
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}
