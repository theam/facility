import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { open } from "@facility/core";
import { createDb, integrations, webhookDeliveries } from "@facility/db";
import { and, asc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { Agent } from "undici";
import type { AppConfig } from "../types.js";

const MAX_ATTEMPTS = 8;
const CLAIM_LIMIT = 25;

type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export async function deliverPendingWebhooks(
  config: AppConfig,
  options: { fetch?: typeof fetch; resolve?: Resolver; now?: Date } = {},
) {
  const fetchImpl = options.fetch ?? fetch;
  const resolve = options.resolve ?? resolveHostname;
  const now = options.now ?? new Date();
  const { db, client } = createDb(config.databaseUrl);
  try {
    const claimed = await db.transaction(async (tx) => {
      const staleClaim = new Date(now.getTime() - 5 * 60_000);
      const rows = await tx
        .select()
        .from(webhookDeliveries)
        .where(
          or(
            and(
              inArray(webhookDeliveries.status, ["pending", "failed"]),
              lte(webhookDeliveries.nextAttemptAt, now),
              lt(webhookDeliveries.attempts, MAX_ATTEMPTS),
            ),
            and(
              eq(webhookDeliveries.status, "delivering"),
              lt(webhookDeliveries.updatedAt, staleClaim),
              lt(webhookDeliveries.attempts, MAX_ATTEMPTS),
            ),
          ),
        )
        .orderBy(asc(webhookDeliveries.nextAttemptAt))
        .limit(CLAIM_LIMIT)
        .for("update", { skipLocked: true });
      if (!rows.length) return [];
      await tx
        .update(webhookDeliveries)
        .set({
          status: "delivering",
          attempts: sql`${webhookDeliveries.attempts} + 1`,
          updatedAt: now,
        })
        .where(
          inArray(
            webhookDeliveries.id,
            rows.map((row) => row.id),
          ),
        );
      return rows.map((row) => ({ ...row, attempts: row.attempts + 1 }));
    });

    const results: Array<{ id: string; status: string }> = [];
    for (const delivery of claimed) {
      const integration = (
        await db
          .select()
          .from(integrations)
          .where(
            and(
              eq(integrations.id, delivery.integrationId),
              eq(integrations.orgId, delivery.orgId),
            ),
          )
          .limit(1)
      )[0];
      if (!integration?.enabled || integration.kind !== "webhook") {
        await finish("discarded", "Integration is disabled or missing");
        results.push({ id: delivery.id, status: "discarded" });
        continue;
      }
      const integrationConfig = objectOrEmpty(integration.config);
      const rawUrl = integrationConfig.url;
      if (typeof rawUrl !== "string") {
        await finish("dead", "Webhook URL is missing");
        results.push({ id: delivery.id, status: "dead" });
        continue;
      }
      let target: Awaited<ReturnType<typeof validateWebhookTarget>>;
      try {
        target = await validateWebhookTarget(rawUrl, config.facilityInsecureDev, resolve);
      } catch (error) {
        await finish("dead", errorMessage(error));
        results.push({ id: delivery.id, status: "dead" });
        continue;
      }
      if (!integration.sealedSecret) {
        await finish("dead", "Webhook signing secret is missing");
        results.push({ id: delivery.id, status: "dead" });
        continue;
      }
      const body = JSON.stringify(delivery.payload);
      const timestamp = Math.floor(now.getTime() / 1_000).toString();
      const secret = await open(integration.sealedSecret, config.secretMasterKey);
      const signature = `sha256=${createHmac("sha256", secret)
        .update(`${timestamp}.${delivery.id}.${delivery.eventType}.${body}`)
        .digest("hex")}`;
      let dispatcher: Agent | undefined;
      try {
        dispatcher = options.fetch
          ? undefined
          : new Agent({
              connect: {
                lookup: (_hostname, lookupOptions, callback) => {
                  const selected = target.addresses[0];
                  if (!selected) {
                    callback(new Error("Webhook hostname did not resolve"), "", 0);
                    return;
                  }
                  if (lookupOptions.all) callback(null, [selected]);
                  else callback(null, selected.address, selected.family);
                },
              },
            });
        const requestInit: RequestInit = {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
          headers: {
            "content-type": "application/json",
            "user-agent": "Facility-Webhook/0.3",
            "x-facility-delivery": delivery.id,
            "x-facility-event": delivery.eventType,
            "x-facility-timestamp": timestamp,
            "x-facility-signature": signature,
          },
          body,
        };
        if (dispatcher) Reflect.set(requestInit, "dispatcher", dispatcher);
        const response = await fetchImpl(target.url, requestInit);
        const responseStatus = response.status;
        const responseOk = response.ok;
        const retryAfter = response.headers.get("retry-after");
        await response.body?.cancel();
        await dispatcher?.close();
        dispatcher = undefined;
        if (responseOk) {
          await db
            .update(webhookDeliveries)
            .set({
              status: "delivered",
              responseStatus,
              error: null,
              deliveredAt: now,
              updatedAt: now,
            })
            .where(eq(webhookDeliveries.id, delivery.id));
          results.push({ id: delivery.id, status: "delivered" });
          continue;
        }
        const retryable =
          responseStatus === 408 ||
          responseStatus === 425 ||
          responseStatus === 429 ||
          responseStatus >= 500;
        const status = retryable && delivery.attempts < MAX_ATTEMPTS ? "failed" : "dead";
        await db
          .update(webhookDeliveries)
          .set({
            status,
            responseStatus,
            error: `Webhook returned HTTP ${responseStatus}`,
            nextAttemptAt: nextAttempt(now, delivery.attempts, retryAfter),
            updatedAt: now,
          })
          .where(eq(webhookDeliveries.id, delivery.id));
        results.push({ id: delivery.id, status });
      } catch (error) {
        await dispatcher?.close().catch(() => undefined);
        const status = delivery.attempts < MAX_ATTEMPTS ? "failed" : "dead";
        await db
          .update(webhookDeliveries)
          .set({
            status,
            error: errorMessage(error),
            nextAttemptAt: nextAttempt(now, delivery.attempts),
            updatedAt: now,
          })
          .where(eq(webhookDeliveries.id, delivery.id));
        results.push({ id: delivery.id, status });
      }

      async function finish(status: "dead" | "discarded", error: string) {
        await db
          .update(webhookDeliveries)
          .set({ status, error, updatedAt: now })
          .where(eq(webhookDeliveries.id, delivery.id));
      }
    }
    return results;
  } finally {
    await client.end();
  }
}

export async function validateWebhookTarget(rawUrl: string, insecure: boolean, resolve: Resolver) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Webhook URL is invalid");
  }
  if (url.protocol !== "https:" && !(insecure && url.protocol === "http:")) {
    throw new Error("Webhook URL must use HTTPS");
  }
  if (url.username || url.password) throw new Error("Webhook URL cannot contain credentials");
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname, family: isIP(url.hostname) }]
    : await resolve(url.hostname);
  if (!addresses.length) throw new Error("Webhook hostname did not resolve");
  if (!insecure && addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Webhook URL resolves to a private or reserved address");
  }
  return { url, addresses };
}

async function resolveHostname(hostname: string) {
  return lookup(hostname, { all: true, verbatim: true });
}

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (!family) return false;
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) {
    return isPublicAddress(address.slice("::ffff:".length));
  }
  return !blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

export function nextAttempt(now: Date, attempts: number, retryAfter?: string | null) {
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return new Date(now.getTime() + Math.min(Number(retryAfter) * 1_000, 24 * 60 * 60_000));
  }
  if (retryAfter) {
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return new Date(Math.min(Math.max(retryAt, now.getTime()), now.getTime() + 24 * 60 * 60_000));
    }
  }
  const delay = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 24 * 60 * 60_000);
  return new Date(now.getTime() + delay);
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 2_000) : "Unknown webhook error";
}
