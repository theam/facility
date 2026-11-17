/**
 * The control plane's record of a story workspace's lifecycle, persisted in
 * `workspaces.state`. This is not the provider's view of compute
 * (`WorkspaceState` in runtime.ts): `deleting` exists only here, while a
 * provider is being asked to destroy durable storage.
 *
 * The record functions below are the only code that writes `workspaces.state`.
 * Each one sets the fields that must change with its state, so a record can
 * never claim a state without them (an error without its detail, a destroyed
 * workspace without its destruction time). They take the caller's database
 * handle, so a caller that holds a story lock across a provider call keeps it
 * through the write. They know nothing about previews or events: callers append
 * workspace events and notify observers after their transaction commits.
 */
import type { FacilityDb } from "@facility/db";
import { workspaces } from "@facility/db";
import { and, eq } from "drizzle-orm";
import type { PreviewEndpoint } from "./runtime.js";

/** Every state a workspace record can hold; matches the `workspaces_state_check` constraint. */
export const WORKSPACE_RECORD_STATES = [
  "creating",
  "running",
  "sleeping",
  "error",
  "deleting",
  "destroyed",
] as const;

export type WorkspaceRecordState = (typeof WORKSPACE_RECORD_STATES)[number];

/**
 * States in which a record still owns its story's workspace: at most one record
 * per story is in one of them (the `workspaces_story_active_uidx` index).
 */
export const LIVE_WORKSPACE_STATES = [
  "creating",
  "running",
  "sleeping",
  "error",
] as const satisfies readonly WorkspaceRecordState[];

/** True when the record says compute is stopped (sleeping) or gone for good (destroyed). */
export function isComputeSuspended(state: string): boolean {
  return state === "sleeping" || state === "destroyed";
}

/**
 * Identifies one workspace record inside its tenant scope. With `storyId`, the
 * write also requires the record to belong to that story, which fences a caller
 * holding a workspace id from another story.
 */
export type WorkspaceRecordRef = {
  orgId: string;
  projectId: string;
  workspaceId: string;
  storyId?: string;
};

/** What a caller observed when compute came up; each field is written only when present. */
export type RunningObservation = {
  /** Provider references returned by create or wake. */
  compute?: { externalRef: string; volumeRef: string };
  /** Endpoints published by a prepared environment or a converged preview. */
  endpoints?: PreviewEndpoint[];
  /** Checksum of the setup that produced the published endpoints. */
  setupChecksum?: string;
};

/**
 * Records that the workspace's compute is running (or, for a dispatcher that
 * persists intent before waking, about to be). Clears any previous error and
 * counts as activity. Returns false when no record matches the ref.
 */
export async function recordRunning(
  db: FacilityDb,
  ref: WorkspaceRecordRef,
  observed: RunningObservation = {},
  now = new Date(),
): Promise<boolean> {
  return write(db, ref, {
    state: "running",
    error: null,
    lastActivityAt: now,
    updatedAt: now,
    ...(observed.compute ?? {}),
    ...(observed.endpoints ? { endpoints: observed.endpoints } : {}),
    ...(observed.setupChecksum ? { setupChecksum: observed.setupChecksum } : {}),
  });
}

/**
 * Records that compute is stopped while durable storage remains. Call only
 * after the provider confirmed suspension. Returns false when no record matches.
 */
export async function recordSleeping(
  db: FacilityDb,
  ref: WorkspaceRecordRef,
  now = new Date(),
): Promise<boolean> {
  return write(db, ref, { state: "sleeping", updatedAt: now });
}

/** Records that the provider failed to bring compute up, keeping its detail for operators. */
export async function recordFailed(
  db: FacilityDb,
  ref: WorkspaceRecordRef,
  detail: string,
  now = new Date(),
): Promise<boolean> {
  return write(db, ref, { state: "error", error: detail, updatedAt: now });
}

/**
 * Records that deletion started: the record leaves the live states, so new work
 * cannot claim it while the provider destroys storage.
 */
export async function recordDeleting(
  db: FacilityDb,
  ref: WorkspaceRecordRef,
  now = new Date(),
): Promise<boolean> {
  return write(db, ref, { state: "deleting", updatedAt: now });
}

/** Records that the provider destroyed durable storage at `destroyedAt`. */
export async function recordDestroyed(
  db: FacilityDb,
  ref: WorkspaceRecordRef,
  destroyedAt = new Date(),
): Promise<boolean> {
  return write(db, ref, { state: "destroyed", destroyedAt, updatedAt: destroyedAt });
}

async function write(
  db: FacilityDb,
  ref: WorkspaceRecordRef,
  changes: Partial<typeof workspaces.$inferInsert> & { state: WorkspaceRecordState },
): Promise<boolean> {
  const updated = await db
    .update(workspaces)
    .set(changes)
    .where(
      and(
        eq(workspaces.orgId, ref.orgId),
        eq(workspaces.projectId, ref.projectId),
        eq(workspaces.id, ref.workspaceId),
        ref.storyId ? eq(workspaces.storyId, ref.storyId) : undefined,
      ),
    )
    .returning({ id: workspaces.id });
  return updated.length > 0;
}

/** The story whose workspace compute changed. */
export type StoryScope = { orgId: string; projectId: string; storyId: string };

/**
 * Reacts when a story's workspace compute stops or starts, so state that
 * depends on live compute (preview convergence) follows it immediately instead
 * of waiting for a reconciliation pass. Callers notify after recording the new
 * state. A caller that wakes compute inside a transaction may notify before it
 * commits; an observer must not read that caller's uncommitted writes, and its
 * own reconciliation of recorded state corrects a rollback.
 */
export type ComputeObserver = {
  /**
   * Compute was suspended. Rejects when work that depends on compute could not
   * be stopped, so a caller that suspended on someone's request can report it;
   * the observer's reconciliation retries the stop.
   */
  computeSuspended(scope: StoryScope): Promise<void>;
  /**
   * Compute is running again; safe to call when nothing was suspended. Never
   * rejects: a missed resume only delays dependent work until reconciliation.
   */
  computeResumed(scope: StoryScope): Promise<void>;
};

/** For compositions with nothing that depends on live compute. */
export const UNOBSERVED_COMPUTE: ComputeObserver = {
  computeSuspended: async () => undefined,
  computeResumed: async () => undefined,
};
