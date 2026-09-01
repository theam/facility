import type { FacilityDb } from "@facility/db";
import { runEvents } from "@facility/db";
import { eq, sql } from "drizzle-orm";
import type { SandboxDriverName } from "./driver.js";

export type RunnerEngine = "claude_code" | "codex" | "byo";

export type RunBundle = {
  runId: string;
  mode: string;
  engine: RunnerEngine;
  contract: string;
  skills: Array<{ name: string; content: string }>;
  engineConfig: Record<string, unknown>;
  repo: {
    cloneUrl: string | null;
    branch: string | null;
    expectedHeadSha: string | null;
    installationTokenRef: string | null;
  };
  packageInstallCmd: string | null;
  provisionCmd: string | null;
  checkCmds: string[];
  gatewayUrls: { anthropic: string; openai: string };
  /** Optional for bundles persisted before provider auth modes were introduced. */
  anthropicAuthMode?: "api_key" | "oauth";
  scope: Record<string, unknown>;
  timeoutMin: number;
  harness?: { files: Record<string, string> };
  resume?: {
    sessionId: string;
    sessionStateFrom: string;
    prompt: string;
    branch?: string;
    fallbackScope?: Record<string, unknown>;
  };
};

export type RunSandboxState = {
  driver?: SandboxDriverName;
  ref?: string;
  image?: string;
  runnerTokenHash?: string;
  virtualKeyId?: string;
  sealedVirtualKey?: string;
  virtualKeyRevealedAt?: string;
  platformKeyId?: string;
  sealedPlatformKey?: string;
  projectId?: string;
  bundle?: RunBundle;
  launchedAt?: string;
  // Written by finishRun's terminal claim, in the same commit as the status.
  finishedAt?: string;
  // Written once every step that follows that claim — resource reclamation,
  // delivery, events, audit, the conversation turn — has landed. Until it is,
  // the /result route admits a replay so an interrupted finalization resumes;
  // see resultFinalizationPending.
  finalizedAt?: string;
  // The lease on that finalization: written by the claim and taken over by a
  // replayed /result only once it is RESULT_FINALIZATION_LEASE_MS old, so two
  // attempts never run the steps at once — the attempt a rolling restart cut
  // the runner off from may still be running on the old process while the
  // runner replays to the new one. A live attempt renews it for as long as it
  // works (between steps and on a timer inside long ones), so expiry means the
  // holder is dead or stalled, not merely slow.
  finalizingAt?: string;
  // Which attempt holds that lease: minted by the claim, replaced by a
  // takeover. Renewal compare-and-sets on it, so a stalled attempt that was
  // taken over discovers the loss atomically at its next step and aborts
  // instead of running beside — and duplicating the effects of — the winner.
  finalizingToken?: string;
  destroyedAt?: string;
  lastStatus?: string;
  // First reconcile tick that observed the sandbox exited/lost while the run
  // was still live. Cleared when a later probe sees the sandbox alive;
  // confirmation rules live at SANDBOX_LOSS_GRACE_MS.
  lossObservedAt?: string;
  // True for in-process assistant turns: no container, no driver — the key
  // lifecycle and orphan sweeps still apply through virtualKeyId.
  inline?: boolean;
};

export function readSandbox(value: unknown): RunSandboxState {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RunSandboxState)
    : {};
}

// Terminal run statuses — the race-safe guard for every lifecycle UPDATE so a
// stale write can't move a finished run back to an active state.
export const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "canceled"] as const;

export function terminalStatus(status: string) {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

// A run whose terminal status finishRun committed but whose finalization it
// never recorded as complete: the control plane went down, or a step threw,
// between the claim and finalizedAt. Only that claim writes finishedAt — a
// cancel or a failRun leaves it unset — so this is exactly the window a
// replayed /result is admitted to close. A run finalized before finalizedAt
// existed reads as pending too; resuming one re-runs guarded steps that all
// find their work done and then records the marker.
export function resultFinalizationPending(sandbox: RunSandboxState) {
  return Boolean(sandbox.finishedAt) && !sandbox.finalizedAt;
}

// How long one attempt at finalization holds the run without renewing before a
// replay may take it over. Not a bound on how long a finalization may take —
// a security sync can spend minutes on GitHub — but on how long a live attempt
// goes between renewals, which happen at every step boundary and on a
// RESULT_FINALIZATION_RENEW_MS timer inside a step. Short against the runner's
// five-minute result budget, which has to cover a control-plane restart plus
// this wait.
export const RESULT_FINALIZATION_LEASE_MS = 60_000;
// How often an attempt renews mid-step. A third of the lease, so a takeover
// needs several missed renewals, not one late timer tick.
export const RESULT_FINALIZATION_RENEW_MS = RESULT_FINALIZATION_LEASE_MS / 3;

export async function appendRunEvents(
  db: FacilityDb,
  orgId: string,
  runId: string,
  events: Array<{ type: string; data?: Record<string, unknown>; ts?: string }>,
) {
  if (events.length === 0) return [];
  // Allocate the seq range and insert atomically per run. `max(seq)+1` then
  // insert races on the (run_id, seq) PK when two producers append to the same
  // run at once (e.g. a runner batch and a lifecycle event), surfacing as a
  // retryable duplicate-key 500. A per-run advisory lock inside one transaction
  // serializes allocation+insert for THIS run only — other runs (different lock
  // key) never contend. NOTIFY fires after commit so listeners see only durable
  // events.
  const inserted = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runId}))`);
    const rows = await tx
      .select({ max: sql<number>`coalesce(max(seq), 0)` })
      .from(runEvents)
      .where(eq(runEvents.runId, runId));
    const start = Number(rows[0]?.max ?? 0) + 1;
    const values = events.map((event, index) => ({
      orgId,
      runId,
      seq: start + index,
      type: event.type,
      data: event.data ?? {},
      ts: event.ts ? new Date(event.ts) : undefined,
    }));
    return tx.insert(runEvents).values(values).returning();
  });
  for (const event of inserted) {
    await notifyRunEvent(db, runId, event);
  }
  return inserted;
}

export async function notifyRunEvent(db: FacilityDb, runId: string, event: unknown) {
  // NOTIFY is only a wake-up signal; SSE listeners reload durable rows from
  // run_events. PostgreSQL caps NOTIFY payloads below 8 KiB, while command and
  // assistant events can be much larger, so never duplicate the event body here.
  const seq =
    event && typeof event === "object" && !Array.isArray(event)
      ? (event as { seq?: unknown }).seq
      : undefined;
  const payload = JSON.stringify({ seq: typeof seq === "number" ? seq : null });
  await db.execute(sql`select pg_notify(${`run_events:${runId}`}, ${payload})`);
}
