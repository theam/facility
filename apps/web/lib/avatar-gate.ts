import {
  type BucketLimit,
  type BucketState,
  isFresh,
  newBucket,
  overCapacity,
  SESSION_COOKIE,
  sessionTokenFrom,
  spendToken,
} from "@/lib/avatar-egress";

/**
 * The mutable side of avatar egress: the caches and allowances that decide
 * whether a request reaches GitHub at all. Every rule these stores apply is a
 * pure function from `avatar-egress.ts`; this module only holds state, reads
 * the clock, and asks the control plane who the viewer is.
 *
 * Each store is bounded in entries and in lifetime, so a caller cycling
 * logins or IDs cannot grow this process's memory, and a viewer's fetches
 * against the upstream are capped whether or not the cache answers.
 */

/** Session lookups are cheap to repeat but not free; hold each answer briefly. */
const SESSION_TTL_MS = 60_000;
const SESSION_CACHE_MAX = 1_024;

/** Avatars change rarely, so a hit here is the common case after warm-up. */
const IMAGE_TTL_MS = 86_400_000;
/** A login with no avatar is remembered too, or it is refetched every paint. */
const MISS_TTL_MS = 300_000;
const IMAGE_CACHE_MAX = 512;

/** An avatar is a few kilobytes. Anything this large is not one. */
export const MAX_AVATAR_BYTES = 256 * 1024;

/**
 * Per viewer: enough to paint a full board of distinct assignees at once,
 * then a steady trickle. Cache hits cost nothing, so the ceiling only binds
 * on someone asking for logins nobody has asked for before.
 */
const UPSTREAM_LIMIT: BucketLimit = { burst: 60, perMinute: 30 };
const BUCKET_TTL_MS = 600_000;
const BUCKET_CACHE_MAX = 4_096;

type Entry<V> = { value: V; expiresAt: number };

type BoundedStore<V> = {
  get(key: string, now: number): V | undefined;
  set(key: string, value: V, ttlMs: number, now: number): void;
  clear(): void;
};

/**
 * A map bounded in both directions: entries expire, and the oldest are
 * dropped once `max` is exceeded. A read re-inserts, so insertion order is
 * least-recently-used order and eviction takes from the front.
 */
function boundedStore<V>(max: number): BoundedStore<V> {
  const entries = new Map<string, Entry<V>>();
  return {
    get(key, now) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (!isFresh(entry, now)) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value, ttlMs, now) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now + ttlMs });
      for (const stale of [...entries].filter(([, e]) => !isFresh(e, now)).map(([k]) => k)) {
        entries.delete(stale);
      }
      for (const oldest of [...entries.keys()].slice(0, overCapacity(entries.size, max))) {
        entries.delete(oldest);
      }
    },
    clear() {
      entries.clear();
    },
  };
}

/** The principal a session belongs to, or "" for a token the control plane rejected. */
const sessions = boundedStore<string>(SESSION_CACHE_MAX);
const images = boundedStore<CachedAvatar>(IMAGE_CACHE_MAX);
const buckets = boundedStore<BucketState>(BUCKET_CACHE_MAX);

export type CachedAvatar =
  | { kind: "image"; bytes: Uint8Array<ArrayBuffer>; contentType: string }
  | { kind: "missing" };

function controlPlaneUrl() {
  // Read at request time so a promoted standalone image sees the deployment's
  // runtime environment, matching lib/api.ts.
  return process.env.FACILITY_API_URL ?? "http://localhost:4400";
}

/**
 * The principal behind this request's session cookie, or null when there is
 * no cookie or the control plane does not recognise it. Null must stop the
 * request: an unauthenticated caller may not make this deployment fetch
 * anything from GitHub.
 *
 * The answer is cached per token, rejections included, so a caller replaying
 * one token cannot turn avatar loads into control-plane load either.
 */
export async function avatarViewerId(request: Request): Promise<string | null> {
  const token = sessionTokenFrom(request.headers.get("cookie"));
  if (!token) return null;

  const now = Date.now();
  const cached = sessions.get(token, now);
  if (cached !== undefined) return cached || null;

  let viewer = "";
  try {
    const response = await fetch(`${controlPlaneUrl()}/v1/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}`, accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const body = (await response.json()) as { principal?: { id?: unknown } };
      if (typeof body?.principal?.id === "string") viewer = body.principal.id;
    } else if (response.status >= 500) {
      // A control plane that is down has not said this session is invalid.
      // Deny the request without remembering the answer.
      return null;
    }
  } catch {
    return null;
  }

  sessions.set(token, viewer, SESSION_TTL_MS, now);
  return viewer || null;
}

/**
 * Whether this viewer may cause one more upstream fetch. Callers ask only
 * after the cache has missed, so a warm avatar never spends an allowance.
 */
export function allowUpstreamFetch(viewerId: string): boolean {
  const now = Date.now();
  const current = buckets.get(viewerId, now) ?? newBucket(UPSTREAM_LIMIT, now);
  const { state, allowed } = spendToken(current, UPSTREAM_LIMIT, now);
  buckets.set(viewerId, state, BUCKET_TTL_MS, now);
  return allowed;
}

/** A previously fetched avatar, or a remembered absence, for this target. */
export function cachedAvatar(key: string): CachedAvatar | undefined {
  return images.get(key, Date.now());
}

/** Remember a fetched avatar, or the fact that the upstream has none. */
export function rememberAvatar(key: string, value: CachedAvatar): void {
  images.set(key, value, value.kind === "image" ? IMAGE_TTL_MS : MISS_TTL_MS, Date.now());
}

/** Drop every store. Tests call this so one case cannot answer the next. */
export function resetAvatarGate(): void {
  sessions.clear();
  images.clear();
  buckets.clear();
}
