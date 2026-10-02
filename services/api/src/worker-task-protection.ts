import { TURN_POOL_SIZE } from "./turn-queue.js";

type ProtectionLogger = { warn: (data: Record<string, unknown>, message: string) => void };
type Protection = { set: (enabled: boolean) => Promise<void>; readonly expiresAt?: number };

// ECS can reject renewals of an old deployment. Cover the 24-hour engine command
// plus preparation without relying on renewal; release promptly in finally.
const LEASE_MINUTES = 48 * 60;
const RENEW_MS = 60_000;
const FAILURE_CODES = new Set([
  "DEPLOYMENT_BLOCKED",
  "AccessDeniedException",
  "TASK_NOT_VALID",
  "MISSING",
  "ThrottlingException",
]);

class ProtectionError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(`ECS worker protection failed: ${code}`);
  }
}

function failureEvidence(error: unknown, protection: Protection) {
  return {
    code: error instanceof ProtectionError ? error.code : "REQUEST_FAILED",
    status: error instanceof ProtectionError ? error.status : undefined,
    leaseRemainingMs:
      protection.expiresAt === undefined
        ? undefined
        : Math.max(0, protection.expiresAt - Date.now()),
  };
}
const TASK_ARN =
  /^(arn:aws(?:-us-gov|-cn)?:ecs:[a-z0-9-]+:\d{12}:task\/)(?:([a-zA-Z0-9_-]+)\/)?([a-f0-9]{32})$/;

function sameTask(expected: string, actual: unknown) {
  if (typeof actual !== "string") return false;
  const expectedParts = TASK_ARN.exec(expected);
  const actualParts = TASK_ARN.exec(actual);
  // ECS protection responses may omit the cluster segment present in task metadata.
  return Boolean(
    expectedParts &&
      actualParts &&
      expectedParts[1] === actualParts[1] &&
      expectedParts[3] === actualParts[3] &&
      (!expectedParts[2] || !actualParts[2] || expectedParts[2] === actualParts[2]),
  );
}

function agentUrl(value: string | undefined, label: string) {
  if (!value) throw new Error(`${label} is required for ECS worker protection`);
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "169.254.170.2" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(`${label} must be an ECS link-local HTTP endpoint`);
  return url.toString().replace(/\/$/, "");
}

/** The agent endpoint can modify only the calling task. Never accept task IDs from jobs. */
export async function ecsTaskProtection(
  env: NodeJS.ProcessEnv,
  request: typeof fetch = fetch,
): Promise<Protection | undefined> {
  const mode = env.FACILITY_WORKER_TASK_PROTECTION;
  if (!mode || mode === "none") return undefined;
  if (mode !== "ecs") throw new Error("Unknown worker task protection mode");
  const endpoint = `${agentUrl(env.ECS_AGENT_URI, "ECS_AGENT_URI")}/task-protection/v1/state`;
  const metadata = `${agentUrl(env.ECS_CONTAINER_METADATA_URI_V4, "ECS_CONTAINER_METADATA_URI_V4")}/task`;
  const response = await request(metadata, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Cannot identify the ECS worker task");
  const identity = (await response.json()) as { TaskARN?: unknown };
  const taskArn = identity?.TaskARN;
  if (typeof taskArn !== "string" || !TASK_ARN.test(taskArn))
    throw new Error("Invalid ECS worker identity");
  let expiresAt: number | undefined;
  return {
    get expiresAt() {
      return expiresAt;
    },
    async set(enabled) {
      const result = await request(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ProtectionEnabled: enabled,
          ...(enabled ? { ExpiresInMinutes: LEASE_MINUTES } : {}),
        }),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await result.json().catch(() => null)) as {
        error?: { Code?: unknown };
        failure?: { Reason?: unknown };
        protection?: { TaskArn?: unknown; ProtectionEnabled?: unknown; ExpirationDate?: unknown };
      } | null;
      if (!result.ok || body?.error || body?.failure) {
        const code = body?.failure?.Reason ?? body?.error?.Code;
        throw new ProtectionError(
          typeof code === "string" && FAILURE_CODES.has(code) ? code : "REQUEST_FAILED",
          result.status,
        );
      }
      const protection = body?.protection;
      if (!sameTask(taskArn, protection?.TaskArn) || protection?.ProtectionEnabled !== enabled) {
        throw new ProtectionError("INVALID_RESPONSE", result.status);
      }
      if (
        enabled &&
        (typeof protection.ExpirationDate !== "string" ||
          !(Date.parse(protection.ExpirationDate) > Date.now() + (LEASE_MINUTES - 1) * 60_000))
      ) {
        throw new ProtectionError("INSUFFICIENT_LEASE", result.status);
      }
      expiresAt = enabled ? Date.parse(protection.ExpirationDate as string) : undefined;
    },
  };
}

/** Hold ECS task protection for every in-flight turn, and release it only when the pool is idle. */
export class WorkerTurnGuard {
  private closing = false;
  private slots = 0;
  private protectedTask = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private renewal: Promise<void> | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly protection: Protection | undefined,
    private readonly logger: ProtectionLogger,
    private readonly capacity = TURN_POOL_SIZE,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Turn pool size must be a positive integer");
    }
  }

  close() {
    this.closing = true;
  }

  async run<T>(dispatch: () => Promise<T>): Promise<T> {
    if (this.closing || this.slots >= this.capacity) {
      throw new Error("Worker is not accepting another turn");
    }
    this.slots += 1;
    try {
      await this.exclusive(async () => {
        if (this.closing) throw new Error("Worker is shutting down before turn admission");
        const protection = this.protection;
        if (protection && !this.protectedTask) {
          await protection.set(true);
          this.protectedTask = true;
          this.armRenewal();
        }
      });
      if (this.closing) throw new Error("Worker is shutting down before turn admission");
      return await dispatch();
    } finally {
      await this.exclusive(async () => {
        this.slots -= 1;
        if (this.slots > 0 || !this.protectedTask) return;
        await this.dropProtection();
      });
    }
  }

  private armRenewal() {
    const protection = this.protection;
    if (!protection || this.timer) return;
    this.timer = setInterval(() => {
      if (this.renewal) return;
      this.renewal = protection
        .set(true)
        .catch((error: unknown) =>
          this.logger.warn(
            {
              event: "worker.protection_renewal_failed",
              ...failureEvidence(error, protection),
            },
            "ECS worker protection renewal failed",
          ),
        )
        .finally(() => {
          this.renewal = undefined;
        });
    }, RENEW_MS);
    this.timer.unref();
  }

  private async dropProtection() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.renewal;
    if (this.slots > 0) {
      this.armRenewal();
      return;
    }
    const protection = this.protection;
    this.protectedTask = false;
    if (!protection) return;
    await protection
      .set(false)
      .catch((error: unknown) =>
        this.logger.warn(
          { event: "worker.protection_release_failed", ...failureEvidence(error, protection) },
          "Could not release ECS worker protection; its lease will expire",
        ),
      );
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.chain;
    let release: () => void = () => undefined;
    this.chain = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
