/**
 * Pure egress policy for `/api/avatars/…`.
 *
 * The route fetches a third party, so two things must be bounded: who may
 * cause a fetch, and how many fetches they may cause. Both decisions live
 * here as plain functions over plain values, with the clock passed in. The
 * mutable stores that apply them are in `avatar-gate.ts`.
 */

/** The session cookie the control plane mints. Absent means unauthenticated. */
export const SESSION_COOKIE = "facility_session";

/** The viewer's session token from a raw Cookie header, or null when absent. */
export function sessionTokenFrom(cookieHeader: string | null | undefined): string | null {
  for (const pair of (cookieHeader ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

export type BucketLimit = { burst: number; perMinute: number };
export type BucketState = { tokens: number; updatedAt: number };

/** A viewer's allowance of upstream fetches: a full bucket, as of `now`. */
export function newBucket(limit: BucketLimit, now: number): BucketState {
  return { tokens: limit.burst, updatedAt: now };
}

/**
 * Spend one upstream fetch from a viewer's bucket, refilling for the time
 * since it was last touched. `allowed: false` leaves the bucket empty and the
 * caller must not reach the upstream.
 */
export function spendToken(
  state: BucketState,
  limit: BucketLimit,
  now: number,
): { state: BucketState; allowed: boolean } {
  const elapsed = Math.max(0, now - state.updatedAt);
  const refilled = Math.min(limit.burst, state.tokens + (elapsed * limit.perMinute) / 60_000);
  if (refilled < 1) return { state: { tokens: refilled, updatedAt: now }, allowed: false };
  return { state: { tokens: refilled - 1, updatedAt: now }, allowed: true };
}

/**
 * How many entries a store of `size` must drop to stay within `max`. Callers
 * take that many from the front of an insertion-ordered map, which is the
 * least recently used end when reads re-insert.
 */
export function overCapacity(size: number, max: number): number {
  return Math.max(0, size - max);
}

/** Whether a stored entry is still within its lifetime at `now`. */
export function isFresh(entry: { expiresAt: number }, now: number): boolean {
  return entry.expiresAt > now;
}
