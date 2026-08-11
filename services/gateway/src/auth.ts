import {
  isProviderAuthMode,
  keyLookup,
  open,
  validateProviderBaseUrl,
  verifyKey,
} from "@facility/core";
import type { FacilityDb } from "@facility/db";
import { providerCredentials, runs, virtualKeys } from "@facility/db";
import { and, eq, isNull } from "drizzle-orm";
import type { AuthedKey, GatewayConfig, Provider, ProviderCredential } from "./types.js";

// Cache TTL is the *backstop* on how long a revoked run key can survive in the
// gateway. The primary path is push invalidation: the api NOTIFYs
// `facility_key_revoked` with the key prefix on revoke and the gateway evicts
// synchronously (startKeyRevocationListener). The TTL bounds exposure if that
// notify (or its LISTEN connection) is ever missed; run keys also carry their
// own expiry, enforced on every hit regardless of cache.
const KEY_CACHE_TTL_MS = 15_000;
const KEY_REVOKED_CHANNEL = "facility_key_revoked";
// The api NOTIFYs this with an `${orgId}:${provider}` cache key when a provider
// credential is created/updated/deleted, so the gateway drops the cached opened
// credential immediately instead of serving the stale one for up to the 60s TTL.
const PROVIDER_CHANGED_CHANNEL = "facility_provider_changed";
const keyCache = new Map<
  string,
  {
    cacheExpiresAt: number;
    keyExpiresAt: number | null;
    row: AuthedKey & { hash: string };
    secret: string;
  }
>();
const credentialCache = new Map<string, { expiresAt: number; credential: ProviderCredential }>();

export function virtualKeyFromHeaders(headers: Record<string, unknown>): string | null {
  const authorization = typeof headers.authorization === "string" ? headers.authorization : "";
  if (authorization.startsWith("Bearer fvk_")) return authorization.slice("Bearer ".length);
  const anthropicKey = headers["x-api-key"];
  return typeof anthropicKey === "string" && anthropicKey.startsWith("fvk_") ? anthropicKey : null;
}

export async function authenticateVirtualKey(
  db: FacilityDb,
  secret: string,
  now = Date.now(),
): Promise<AuthedKey | null> {
  const lookup = keyLookup(secret);
  const cached = keyCache.get(lookup);
  if (
    cached &&
    cached.secret === secret &&
    cached.cacheExpiresAt > now &&
    (cached.keyExpiresAt === null || cached.keyExpiresAt > now)
  ) {
    return cached.row;
  }
  const loaded = await loadVirtualKeyByPrefix(db, lookup, secret, now);
  if (!loaded) return null;
  keyCache.set(lookup, {
    cacheExpiresAt: now + KEY_CACHE_TTL_MS,
    keyExpiresAt: loaded.keyExpiresAt,
    row: loaded.row,
    secret,
  });
  return loaded.row;
}

async function loadVirtualKeyByPrefix(
  db: FacilityDb,
  lookup: string,
  secret: string,
  now: number,
): Promise<{ row: AuthedKey & { hash: string }; keyExpiresAt: number | null } | null> {
  // Verify against every non-revoked key sharing this prefix, not just the
  // first — a prefix collision must not make a valid key fail (finding #6).
  const rows = await db
    .select({ key: virtualKeys, run: runs })
    .from(virtualKeys)
    .leftJoin(runs, eq(virtualKeys.runId, runs.id))
    .where(and(eq(virtualKeys.prefix, lookup), isNull(virtualKeys.revokedAt)))
    .limit(8);
  for (const row of rows) {
    const keyExpiresAt = row.key.expiresAt ? row.key.expiresAt.getTime() : null;
    if (keyExpiresAt !== null && keyExpiresAt <= now) continue;
    if (!(await verifyKey(secret, row.key.hash))) continue;
    return {
      keyExpiresAt,
      row: {
        id: row.key.id,
        orgId: row.key.orgId,
        projectId: row.key.projectId,
        runId: row.key.runId,
        taskId: taskIdFromRunTrigger(row.run?.trigger),
        allowedModels: row.key.allowedModels,
        budgetId: row.key.budgetId,
        agentDefId: row.run?.agentDefId ?? null,
        engine: row.run?.engine ?? null,
        hash: row.key.hash,
      },
    };
  }
  return null;
}

export async function providerCredential(
  db: FacilityDb,
  config: GatewayConfig,
  provider: Provider,
  orgId: string,
): Promise<ProviderCredential> {
  const cacheKey = `${orgId}:${provider}`;
  const cached = credentialCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.credential;

  const row = (
    await db
      .select()
      .from(providerCredentials)
      .where(and(eq(providerCredentials.orgId, orgId), eq(providerCredentials.provider, provider)))
      // Deterministic when an org has several credentials for one provider: the
      // oldest (first-configured) wins, with id as a stable tiebreaker for rows
      // sharing a created_at (bulk insert), rather than an arbitrary limit(1).
      .orderBy(providerCredentials.createdAt, providerCredentials.id)
      .limit(1)
  )[0];

  const fallback = provider === "anthropic" ? config.devAnthropicApiKey : config.devOpenaiApiKey;
  if (!row && fallback) {
    if (config.nodeEnv === "production" && !config.facilityInsecureDev) {
      throw new Error("dev provider key fallback refused in production");
    }
    const credential = {
      authMode: "api_key" as const,
      secret: fallback,
      baseUrl: await validateProviderBaseUrl(defaultBaseUrl(provider), {
        allowLocalhostHttp: config.facilityInsecureDev,
      }),
    };
    credentialCache.set(cacheKey, { expiresAt: Date.now() + 60_000, credential });
    return credential;
  }
  if (!row) throw new Error(`missing ${provider} provider credential`);
  if (!isProviderAuthMode(row.authMode)) throw new Error(`invalid ${provider} auth mode`);

  const credential = {
    authMode: row.authMode,
    secret: await open(row.sealedSecret, config.secretMasterKey),
    baseUrl: await validateProviderBaseUrl(row.baseUrl ?? defaultBaseUrl(provider), {
      allowLocalhostHttp: config.facilityInsecureDev,
    }),
  };
  credentialCache.set(cacheKey, { expiresAt: Date.now() + 60_000, credential });
  return credential;
}

export function clearAuthCaches() {
  keyCache.clear();
  credentialCache.clear();
}

// Structural view of the postgres.js client — just the LISTEN surface we need,
// so auth.ts stays decoupled from the concrete driver type.
type RevocationListenClient = {
  listen: (
    channel: string,
    onNotify: (payload: string) => void,
  ) => Promise<{ unlisten: () => Promise<void> }>;
};

// Subscribe to the api's cache-invalidation NOTIFYs and drop the matching entry
// immediately, making revocation/rotation effectively synchronous. Two channels:
// `facility_key_revoked` (payload = key prefix) evicts the key cache, and
// `facility_provider_changed` (payload = `${orgId}:${provider}`) evicts the
// opened-credential cache so a rotated/removed provider secret isn't served for
// up to the 60s TTL. postgres.js re-subscribes automatically on reconnect; the
// cache TTLs cover any gap.
export async function startKeyRevocationListener(
  client: RevocationListenClient,
): Promise<{ unlisten: () => Promise<void> }> {
  const keySub = await client.listen(KEY_REVOKED_CHANNEL, (prefix) => {
    if (prefix) keyCache.delete(prefix);
  });
  const providerSub = await client.listen(PROVIDER_CHANGED_CHANNEL, (cacheKey) => {
    if (cacheKey) credentialCache.delete(cacheKey);
  });
  return {
    unlisten: async () => {
      await keySub.unlisten().catch(() => undefined);
      await providerSub.unlisten().catch(() => undefined);
    },
  };
}

function defaultBaseUrl(provider: Provider): string {
  return provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";
}

function taskIdFromRunTrigger(trigger: unknown): string | null {
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) return null;
  const taskId = (trigger as { taskId?: unknown }).taskId;
  return typeof taskId === "string" && taskId ? taskId : null;
}
