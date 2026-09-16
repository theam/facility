type ProtectionLogger = { warn: (message: string) => void };
type Protection = { set: (enabled: boolean) => Promise<void> };

const LEASE_MINUTES = 120;
const RENEW_MS = 60_000;
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
  return {
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
      if (!result.ok) throw new Error("ECS worker protection request failed");
      const body = (await result.json()) as {
        error?: unknown;
        failure?: unknown;
        protection?: { TaskArn?: unknown; ProtectionEnabled?: unknown; ExpirationDate?: unknown };
      };
      const protection = body?.protection;
      if (
        body?.error ||
        body?.failure ||
        !sameTask(taskArn, protection?.TaskArn) ||
        protection?.ProtectionEnabled !== enabled
      ) {
        throw new Error("ECS worker protection was not confirmed for this task");
      }
      if (
        enabled &&
        (typeof protection.ExpirationDate !== "string" ||
          !(Date.parse(protection.ExpirationDate) > Date.now() + RENEW_MS))
      ) {
        throw new Error("ECS worker protection lease is expired or invalid");
      }
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
            .catch(() =>
              this.logger.warn(
                "Could not renew ECS worker protection; the previous lease remains in effect",
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
          .catch(() =>
            this.logger.warn("Could not release ECS worker protection; its lease will expire"),
          );
      }
      this.busy = false;
    }
  }
}
