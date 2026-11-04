import { createHmac, timingSafeEqual } from "node:crypto";
import { newId } from "@facility/core";
import { type FacilityDb, stories, storyInputFiles, workspaces } from "@facility/db";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { authorizePrincipal } from "../auth/workspace-execution.js";
import { ApiError } from "../errors.js";
import { INPUT_FILE_MAX_BYTES, verifyInputBytes } from "../workspaces/input-files.js";
import type { WorkspaceLocator, WorkspaceRuntime } from "../workspaces/runtime.js";

export type InputScope = { orgId: string; projectId: string; storyId: string };
type Authorizer = { type: "user" | "key"; id: string };
export type InputFileReference = {
  id: string;
  name: string;
  size: number;
  sha256: string;
  mediaType: string;
};
type FileRow = typeof storyInputFiles.$inferSelect;
export const INPUT_FILE_LIMITS = {
  fileBytes: INPUT_FILE_MAX_BYTES,
  storyBytes: 100 * 1024 * 1024,
  messageFiles: 5,
};

export function publicInputFile(row: FileRow) {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    sha256: row.sha256,
    mediaType: row.mediaType,
    state: row.state,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    receivedAt: row.receivedAt,
    expiresAt: row.expiresAt,
  };
}

export async function validateInputFileReferences(
  db: FacilityDb,
  scope: InputScope,
  ids: string[] = [],
) {
  if (ids.length > INPUT_FILE_LIMITS.messageFiles || new Set(ids).size !== ids.length)
    throw new ApiError(400, "input_files_invalid", "Attach at most five distinct files");
  if (!ids.length) return [];
  const rows = await db
    .select()
    .from(storyInputFiles)
    .where(
      and(
        fileScope(scope),
        inArray(storyInputFiles.id, ids),
        eq(storyInputFiles.state, "available"),
      ),
    );
  if (rows.length !== ids.length)
    throw new ApiError(
      409,
      "input_file_unavailable",
      "Every attachment must be an available file in this story",
    );
  return ids.map((id) => {
    const row = requireInputRow(rows.find((r) => r.id === id));
    return {
      id: row.id,
      name: row.name,
      size: row.size,
      sha256: row.sha256,
      mediaType: row.mediaType,
    };
  });
}

export class StoryInputFileService {
  constructor(
    private readonly db: FacilityDb,
    private readonly runtime: WorkspaceRuntime,
    private readonly secret: string,
    private readonly projectMaxBytes = 250 * 1024 * 1024,
  ) {}

  async list(scope: InputScope) {
    await this.context(this.db, scope);
    const items = await this.db
      .select()
      .from(storyInputFiles)
      .where(
        and(
          fileScope(scope),
          inArray(storyInputFiles.state, ["prepared", "uploading", "available", "failed"]),
        ),
      )
      .orderBy(desc(storyInputFiles.createdAt))
      .limit(100);
    return {
      items: items.map(publicInputFile),
      limits: { ...INPUT_FILE_LIMITS, projectBytes: this.projectMaxBytes },
    };
  }

  async prepare(
    scope: InputScope,
    input: {
      name: string;
      size: number;
      sha256: string;
      mediaType: string;
      idempotencyKey: string;
      resume: boolean;
    },
    actor: Authorizer,
  ) {
    if (
      !input.name.trim() ||
      input.name.length > 180 ||
      [...input.name].some(
        (char) =>
          char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "/" || char === "\\",
      ) ||
      input.name === "." ||
      input.name === ".."
    )
      throw new ApiError(
        400,
        "input_filename_invalid",
        "Use a filename without path separators or control characters",
      );
    if (
      !Number.isSafeInteger(input.size) ||
      input.size < 1 ||
      input.size > INPUT_FILE_MAX_BYTES ||
      !/^[a-f0-9]{64}$/.test(input.sha256)
    )
      throw new ApiError(400, "input_file_invalid", "File size or SHA-256 is invalid");
    const row = await this.db.transaction(async (raw) => {
      const db = raw as unknown as FacilityDb;
      await this.lock(db, scope);
      await authorizePrincipal(db, scope, actor, ["workspaces:execute"]);
      const { workspace } = await this.context(db, scope, true);
      if (!this.runtime.writeInputFile)
        throw new ApiError(
          409,
          "input_files_unsupported",
          "This workspace provider does not support files",
        );
      const [existing] = await db
        .select()
        .from(storyInputFiles)
        .where(and(fileScope(scope), eq(storyInputFiles.dedupeKey, input.idempotencyKey)));
      if (existing) {
        if (
          existing.name !== input.name ||
          existing.size !== input.size ||
          existing.sha256 !== input.sha256 ||
          existing.mediaType !== input.mediaType ||
          existing.authorizer.id !== actor.id ||
          existing.authorizer.type !== actor.type ||
          existing.allowResume !== input.resume
        )
          throw new ApiError(
            409,
            "input_file_idempotency_conflict",
            "Use a new idempotency key for a different upload",
          );
        return existing;
      }
      // Expiry revokes grants, not storage. Keep quota until explicit discard has
      // also removed any bytes left by an interrupted provider/DB commit.
      await db
        .update(storyInputFiles)
        .set({ state: "failed", errorCode: "upload_expired", updatedAt: new Date() })
        .where(
          and(
            eq(storyInputFiles.orgId, scope.orgId),
            eq(storyInputFiles.projectId, scope.projectId),
            eq(storyInputFiles.state, "prepared"),
            lt(storyInputFiles.expiresAt, new Date()),
          ),
        );
      const reserved = await db
        .select({ storyId: storyInputFiles.storyId, size: storyInputFiles.size })
        .from(storyInputFiles)
        .where(
          and(
            eq(storyInputFiles.orgId, scope.orgId),
            eq(storyInputFiles.projectId, scope.projectId),
            inArray(storyInputFiles.state, ["prepared", "uploading", "available", "failed"]),
          ),
        );
      if (reserved.filter((r) => r.storyId === scope.storyId).length >= 100)
        throw new ApiError(
          413,
          "input_file_count_exceeded",
          "Remove unused files before adding more than 100 story files",
        );
      if (
        reserved.reduce((s, r) => s + r.size, 0) + input.size > this.projectMaxBytes ||
        reserved.filter((r) => r.storyId === scope.storyId).reduce((s, r) => s + r.size, 0) +
          input.size >
          INPUT_FILE_LIMITS.storyBytes
      )
        throw new ApiError(
          413,
          "input_file_quota_exceeded",
          "The story or project file storage limit would be exceeded",
        );
      const [created] = await db
        .insert(storyInputFiles)
        .values({
          ...scope,
          id: newId("infile"),
          workspaceId: workspace.id,
          name: input.name,
          size: input.size,
          sha256: input.sha256,
          mediaType: input.mediaType,
          authorizer: actor,
          allowResume: input.resume,
          dedupeKey: input.idempotencyKey,
          expiresAt: new Date(Date.now() + 10 * 60_000),
        })
        .returning();
      return requireInputRow(created);
    });
    const uploadPath = `/v1/projects/${scope.projectId}/workspace-stories/${scope.storyId}/input-files/${row.id}/content`;
    return {
      file: publicInputFile(row),
      upload: {
        method: "PUT" as const,
        path: uploadPath,
        headers: {
          "content-type": "application/octet-stream",
          "x-facility-file-token": this.token(row),
        },
        expiresAt: row.expiresAt,
        mayResumeCompute: row.allowResume,
      },
      limits: INPUT_FILE_LIMITS,
    };
  }

  /** Called before body parsing as well as immediately before transfer. */
  async authorizeUpload(
    projectId: string,
    storyId: string,
    id: string,
    token: string,
    attemptId?: string,
  ) {
    const [row] = await this.db
      .select()
      .from(storyInputFiles)
      .where(
        and(
          eq(storyInputFiles.id, id),
          eq(storyInputFiles.projectId, projectId),
          eq(storyInputFiles.storyId, storyId),
        ),
      );
    if (
      !row ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(this.token(row))) ||
      row.expiresAt.getTime() <= Date.now()
    )
      throw new ApiError(401, "input_upload_invalid", "Upload grant is invalid or expired");
    await authorizePrincipal(this.db, row, row.authorizer, ["workspaces:execute"]);
    if (
      attemptId
        ? row.state !== "uploading" || row.uploadAttemptId !== attemptId
        : row.state !== "prepared"
    )
      throw new ApiError(
        409,
        "input_upload_consumed",
        "Upload grant has already been consumed; read file status before retrying",
      );
    await this.context(this.db, row, true);
    return row;
  }

  async beginUpload(
    projectId: string,
    storyId: string,
    id: string,
    token: string,
    attemptId: string,
  ) {
    const row = await this.authorizeUpload(projectId, storyId, id, token);
    const [claimed] = await this.db
      .update(storyInputFiles)
      .set({ state: "uploading", uploadAttemptId: attemptId, updatedAt: new Date() })
      .where(and(eq(storyInputFiles.id, id), eq(storyInputFiles.state, "prepared")))
      .returning({ id: storyInputFiles.id });
    if (!claimed)
      throw new ApiError(409, "input_upload_consumed", "Upload grant has already been consumed");
    return { size: row.size };
  }

  async failUpload(id: string, attemptId: string) {
    await this.db
      .update(storyInputFiles)
      .set({ state: "failed", errorCode: "input_file_transfer_failed", updatedAt: new Date() })
      .where(
        and(
          eq(storyInputFiles.id, id),
          eq(storyInputFiles.state, "uploading"),
          eq(storyInputFiles.uploadAttemptId, attemptId),
        ),
      );
  }

  async upload(
    projectId: string,
    storyId: string,
    id: string,
    token: string,
    attemptId: string,
    bytes: Buffer,
  ) {
    const original = await this.authorizeUpload(projectId, storyId, id, token, attemptId);
    let failure = false;
    const file = await this.db.transaction(async (raw) => {
      const db = raw as unknown as FacilityDb;
      await this.lock(db, original);
      const row = await this.authorizeUpload(projectId, storyId, id, token, attemptId);
      await authorizePrincipal(db, row, row.authorizer, ["workspaces:execute"]);
      const { workspace } = await this.context(db, row, true);
      try {
        verifyInputBytes(row, bytes);
      } catch {
        throw new ApiError(
          400,
          "input_file_integrity_failed",
          "Uploaded bytes do not match the declared size and SHA-256",
        );
      }
      await db
        .update(storyInputFiles)
        .set({ state: "uploading", updatedAt: new Date() })
        .where(eq(storyInputFiles.id, id));
      try {
        const target = await this.running(db, workspace, row.allowResume);
        if (!this.runtime.writeInputFile) throw new Error("input_files_unsupported");
        await this.runtime.writeInputFile(target, row, bytes);
        const [ready] = await db
          .update(storyInputFiles)
          .set({ state: "available", receivedAt: new Date(), updatedAt: new Date() })
          .where(eq(storyInputFiles.id, id))
          .returning();
        return requireInputRow(ready);
      } catch {
        failure = true;
        const [failed] = await db
          .update(storyInputFiles)
          .set({ state: "failed", errorCode: "input_file_transfer_failed", updatedAt: new Date() })
          .where(eq(storyInputFiles.id, id))
          .returning();
        return requireInputRow(failed);
      }
    });
    if (failure)
      throw new ApiError(
        503,
        "input_file_transfer_failed",
        "File transfer failed. Check workspace state and prepare a new upload; no agent was started.",
      );
    return { file: publicInputFile(file) };
  }

  async download(scope: InputScope, id: string) {
    return this.db.transaction(async (raw) => {
      const db = raw as unknown as FacilityDb;
      await this.lock(db, scope);
      const { workspace } = await this.context(db, scope);
      const [row] = await db
        .select()
        .from(storyInputFiles)
        .where(
          and(fileScope(scope), eq(storyInputFiles.id, id), eq(storyInputFiles.state, "available")),
        );
      if (!row) throw new ApiError(404, "input_file_not_found", "File not found");
      const target = await this.running(db, workspace, false);
      if (!this.runtime.readInputFile)
        throw new ApiError(
          409,
          "input_files_unsupported",
          "Workspace file transfer is unsupported",
        );
      let bytes: Buffer;
      try {
        bytes = await this.runtime.readInputFile(target, row);
        verifyInputBytes(row, bytes);
      } catch {
        throw new ApiError(
          409,
          "input_file_integrity_failed",
          "Stored file is missing or changed; it was not returned",
        );
      }
      return { file: publicInputFile(row), bytes };
    });
  }

  async remove(scope: InputScope, id: string, actor: Authorizer, resume = false) {
    return this.db.transaction(async (raw) => {
      const db = raw as unknown as FacilityDb;
      await this.lock(db, scope);
      await authorizePrincipal(db, scope, actor, ["workspaces:execute"]);
      const { workspace } = await this.context(db, scope, true);
      const [row] = await db
        .select()
        .from(storyInputFiles)
        .where(and(fileScope(scope), eq(storyInputFiles.id, id)));
      if (!row) throw new ApiError(404, "input_file_not_found", "File not found");
      if (row.state !== "removed") {
        const target = await this.running(db, workspace, resume);
        if (!this.runtime.removeInputFile)
          throw new ApiError(
            409,
            "input_files_unsupported",
            "Workspace file transfer is unsupported",
          );
        await this.runtime.removeInputFile(target, row);
      }
      const [removed] = await db
        .update(storyInputFiles)
        .set({ state: "removed", updatedAt: new Date() })
        .where(eq(storyInputFiles.id, id))
        .returning();
      return { file: publicInputFile(requireInputRow(removed)) };
    });
  }

  private token(row: FileRow) {
    return createHmac("sha256", this.secret)
      .update(
        JSON.stringify([
          "story-input-v1",
          row.orgId,
          row.projectId,
          row.storyId,
          row.id,
          row.size,
          row.sha256,
          row.authorizer,
          row.expiresAt.toISOString(),
        ]),
      )
      .digest("base64url");
  }
  private async lock(db: FacilityDb, scope: InputScope) {
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`facility:input-files:${scope.orgId}:${scope.projectId}`}))`,
    );
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`facility:story:${scope.orgId}:${scope.projectId}:${scope.storyId}`}))`,
    );
  }
  private async context(db: FacilityDb, scope: InputScope, write = false) {
    const [story] = await db
      .select()
      .from(stories)
      .where(
        and(
          eq(stories.orgId, scope.orgId),
          eq(stories.projectId, scope.projectId),
          eq(stories.id, scope.storyId),
        ),
      );
    if (!story) throw new ApiError(404, "story_not_found", "Story not found");
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
    if (!workspace || story.deletedAt || ["deleting", "destroyed"].includes(workspace.state))
      throw new ApiError(409, "workspace_unavailable", "Workspace is unavailable or deleted");
    if (write && story.archivedAt)
      throw new ApiError(409, "story_archived", "Restore the story before changing its files");
    return { story, workspace };
  }
  private async running(
    db: FacilityDb,
    workspace: typeof workspaces.$inferSelect,
    resume: boolean,
  ) {
    if (!workspace.externalRef)
      throw new ApiError(409, "workspace_unavailable", "Workspace is not prepared");
    const config = workspace.environment as {
      image: string;
      variables?: Record<string, string>;
      ports?: WorkspaceLocator["ports"];
      resources?: WorkspaceLocator["resources"];
    };
    const locator: WorkspaceLocator = {
      id: workspace.id,
      externalRef: workspace.externalRef,
      volumeRef: workspace.volumeRef,
      image: config.image,
      environment: config.variables,
      ports: config.ports,
      resources: config.resources,
    };
    const state = await this.runtime.inspect(locator);
    if (state.state !== "running" && !resume)
      throw new ApiError(
        409,
        "workspace_resume_required",
        "Resume the workspace explicitly before transferring files",
      );
    const active = state.state === "running" ? state : await this.runtime.wake(locator);
    if (!active.computeRef || active.state !== "running")
      throw new ApiError(409, "workspace_unavailable", "Workspace is not running");
    if (state.state !== "running")
      await db
        .update(workspaces)
        .set({ state: "running", lastActivityAt: new Date(), updatedAt: new Date() })
        .where(eq(workspaces.id, workspace.id));
    return { ...locator, expectedComputeRef: active.computeRef };
  }
}

function fileScope(scope: InputScope) {
  return and(
    eq(storyInputFiles.orgId, scope.orgId),
    eq(storyInputFiles.projectId, scope.projectId),
    eq(storyInputFiles.storyId, scope.storyId),
  );
}

function requireInputRow(row: FileRow | undefined) {
  if (!row) throw new ApiError(409, "input_file_unavailable", "Input file is unavailable");
  return row;
}
