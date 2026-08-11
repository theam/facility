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
  finishedAt?: string;
  destroyedAt?: string;
  lastStatus?: string;
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
