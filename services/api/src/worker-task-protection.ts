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

/** One dispatch consumer per worker; acquire protection before claiming a durable turn. */
export class WorkerTurnGuard {
  private closing = false;
  private busy = false;

  constructor(
    private readonly protection: Protection | undefined,
    private readonly logger: ProtectionLogger,
  ) {}

  close() {
    this.closing = true;
  }

  async run<T>(dispatch: () => Promise<T>): Promise<T> {
    const protection = this.protection;
    if (this.closing || this.busy) throw new Error("Worker is not accepting another turn");
    this.busy = true;
    let protectedTask = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let renewal: Promise<void> | undefined;
    try {
      if (protection) {
        await protection.set(true);
        protectedTask = true;
      }
      if (this.closing) throw new Error("Worker is shutting down before turn admission");
      if (protection) {
        timer = setInterval(() => {
          if (renewal) return;
          renewal = protection
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
              renewal = undefined;
            });
        }, RENEW_MS);
        timer.unref();
      }
      return await dispatch();
    } finally {
      if (timer) clearInterval(timer);
      await renewal;
      if (protectedTask && protection) {
        await protection
          .set(false)
          .catch((error: unknown) =>
            this.logger.warn(
              { event: "worker.protection_release_failed", ...failureEvidence(error, protection) },
              "Could not release ECS worker protection; its lease will expire",
            ),
          );
      }
      this.busy = false;
    }
  }
}
