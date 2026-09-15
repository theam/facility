type ObjectValue = Record<string, unknown>;

/** Provider throttling must not become a permanent authorization decision. */
export function githubRateLimitRetryAt(error: unknown, now = Date.now()): Date | undefined {
  const failure = object(error);
  if (failure.status !== 403 && failure.status !== 429) return undefined;
  const response = object(failure.response);
  const headers = object(response.headers);
  const retryAfter = seconds(headers["retry-after"]);
  const exhausted = headers["x-ratelimit-remaining"] === "0";
  const message = object(response.data).message;
  if (
    failure.status !== 429 &&
    !exhausted &&
    retryAfter === undefined &&
    !(typeof message === "string" && /\brate limit\b/i.test(message))
  )
    return undefined;

  // Honor supplied deadlines within a day, including the hourly reset. Bound
  // corrupt but parseable values so the only durable retry cannot be stranded
  // centuries in the future. Missing or elapsed values wait at least a minute.
  const reset = exhausted ? seconds(headers["x-ratelimit-reset"]) : undefined;
  return new Date(
    Math.min(
      now + 24 * 60 * 60 * 1_000,
      Math.max(
        now + 60_000,
        validDeadline(retryAfter === undefined ? 0 : now + retryAfter * 1_000),
        validDeadline(reset === undefined ? 0 : reset * 1_000 + 1_000),
      ),
    ),
  );
}

function seconds(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function validDeadline(value: number): number {
  return Number.isFinite(new Date(value).getTime()) ? value : 0;
}

function object(value: unknown): ObjectValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ObjectValue) : {};
}
