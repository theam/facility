import { newId, open, seal } from "@facility/core";
import { createDb, insertAuditEvent, previewAccessHandoffs, previewSandboxes } from "@facility/db";
import { and, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { request as upstreamRequest } from "undici";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { previewSandboxDriver, type SandboxDriver, SandboxLaunchError } from "./sandbox/driver.js";
import type { AppConfig, Principal } from "./types.js";

type Db = ReturnType<typeof createDb>["db"];
type Preview = typeof previewSandboxes.$inferSelect;

const HandoffTtlMs = 60_000;
const PreviewSessionTtlMs = 60 * 60_000;
const PreviewProvisionLeaseMs = 15 * 60_000;
const PreviewAccessToken = z.discriminatedUnion("kind", [
  z.object({
    version: z.literal(1),
    kind: z.literal("handoff"),
    handoffId: z.string(),
    userId: z.string(),
    orgId: z.string(),
    projectId: z.string(),
    previewId: z.string(),
    expiresAt: z.number().int(),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal("preview_session"),
    userId: z.string(),
    orgId: z.string(),
    previewId: z.string(),
    expiresAt: z.number().int(),
  }),
]);

export type PreviewHandoffClaims = Extract<z.infer<typeof PreviewAccessToken>, { kind: "handoff" }>;
export type PreviewSessionClaims = Extract<
  z.infer<typeof PreviewAccessToken>,
  { kind: "preview_session" }
>;

export type PreviewCreateInput = {
  orgId: string;
  projectId: string;
  repoId?: string;
  runId?: string;
  prNumber?: number;
  commitSha?: string;
  image: string;
  command?: string[];
  port: number;
  readinessPath?: string;
  ttlHours: number;
  driver?: "docker" | "aws";
  createdBy: { type: string; id: string };
};

export function previewAuthReady(config: AppConfig) {
  return config.authIdentityProvider === "oidc"
    ? Boolean(config.oidcIssuer && config.oidcClientId && config.facilityInstanceId)
    : Boolean(config.githubOauthClientId && config.githubOauthClientSecret);
}

export function assertPreviewSession(config: AppConfig, principal: Principal | undefined) {
  if (principal?.type !== "user") {
    throw previewError(
      403,
      "preview_session_required",
      "Preview environments require a user session",
    );
  }
  if (!config.facilityInsecureDev && !previewAuthReady(config)) {
    throw previewError(
      503,
      "preview_auth_unavailable",
      "Preview provisioning is disabled until interactive authentication is configured",
    );
  }
}

export function assertPreviewProvisioningAvailable(config: AppConfig) {
  if (!config.facilityInsecureDev && !previewAuthReady(config)) {
    throw previewError(
      503,
      "preview_auth_unavailable",
      "Preview provisioning is disabled until interactive authentication is configured",
    );
  }
  if (!config.facilityInsecureDev && !isolatedPreviewOrigin(config)) {
    throw previewError(
      503,
      "preview_origin_unavailable",
      "Preview provisioning is disabled until an isolated preview origin is configured",
    );
  }
}

export function isolatedPreviewOrigin(config: AppConfig) {
  if (!config.previewUrl) return false;
  const preview = new URL(config.previewUrl);
  return [config.publicUrl, config.webUrl ?? config.publicUrl, config.mcpPublicUrl]
    .filter((value): value is string => Boolean(value))
    .every((value) => new URL(value).hostname !== preview.hostname);
}

export function assertPreviewOriginSurface(
  config: AppConfig,
  rawHost: string | undefined,
  rawPath: string,
) {
  if (!isolatedPreviewOrigin(config) || !config.previewUrl) return;
  const requestHost = hostname(rawHost);
  const previewHost = new URL(config.previewUrl).hostname.toLowerCase();
  let path: string;
  try {
    // Fastify routes percent-encoded path segments after decoding them. Apply
    // the same interpretation at the origin boundary so `/%70review/...`
    // cannot bypass the dedicated-host check.
    path = decodeURIComponent(rawPath.split("?", 1)[0] ?? "/");
  } catch {
    throw previewError(404, "not_found", "Route not found");
  }
  const servesPreview = /^\/(?:preview|preview-auth)\//.test(path);
  if (requestHost === previewHost ? !servesPreview : servesPreview) {
    throw previewError(404, "not_found", "Route not found");
  }
}

export async function mintPreviewHandoff(
  db: Db,
  config: AppConfig,
  input: { userId: string; orgId: string; projectId: string; previewId: string },
  now = Date.now(),
) {
  const claims: PreviewHandoffClaims = {
    version: 1,
    kind: "handoff",
    handoffId: newId("pvh"),
    ...input,
    expiresAt: now + HandoffTtlMs,
  };
  await db.insert(previewAccessHandoffs).values({
    id: claims.handoffId,
    orgId: claims.orgId,
    projectId: claims.projectId,
    previewId: claims.previewId,
    userId: claims.userId,
    expiresAt: new Date(claims.expiresAt),
  });
  return seal(JSON.stringify(claims), config.secretMasterKey);
}

export async function readPreviewHandoff(
  config: AppConfig,
  token: string,
  previewId: string,
  now = Date.now(),
) {
  const claims = await readPreviewToken(config, token, now);
  if (claims.kind !== "handoff" || claims.previewId !== previewId) {
    throw invalidPreviewAccess();
  }
  return claims;
}

export async function consumePreviewHandoff(
  db: Db,
  claims: PreviewHandoffClaims,
  now = new Date(),
) {
  const consumed = (
    await db
      .update(previewAccessHandoffs)
      .set({ consumedAt: now })
      .where(
        and(
          eq(previewAccessHandoffs.id, claims.handoffId),
          eq(previewAccessHandoffs.orgId, claims.orgId),
          eq(previewAccessHandoffs.projectId, claims.projectId),
          eq(previewAccessHandoffs.previewId, claims.previewId),
          eq(previewAccessHandoffs.userId, claims.userId),
          isNull(previewAccessHandoffs.consumedAt),
          gt(previewAccessHandoffs.expiresAt, now),
        ),
      )
      .returning({ id: previewAccessHandoffs.id })
  )[0];
  if (!consumed) throw invalidPreviewAccess();
}

export async function mintPreviewSession(
  config: AppConfig,
  input: { userId: string; orgId: string; previewId: string },
  now = Date.now(),
) {
  const claims: PreviewSessionClaims = {
    version: 1,
    kind: "preview_session",
    ...input,
    expiresAt: now + PreviewSessionTtlMs,
  };
  return seal(JSON.stringify(claims), config.secretMasterKey);
}

export async function readPreviewSession(
  config: AppConfig,
  token: string,
  previewId: string,
  now = Date.now(),
) {
  const claims = await readPreviewToken(config, token, now);
  if (claims.kind !== "preview_session" || claims.previewId !== previewId) {
    throw invalidPreviewAccess();
  }
  return claims;
}

export function previewCookieName(previewId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(previewId)) throw invalidPreviewAccess();
  return `facility_preview_${previewId}`;
}

export function previewCookieOptions(config: AppConfig, previewId: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.previewUrl?.startsWith("https://") ?? false,
    path: `/preview/${encodeURIComponent(previewId)}`,
    maxAge: PreviewSessionTtlMs / 1000,
  };
}

export function previewAccessUrl(config: AppConfig, projectId: string, previewId: string) {
  const controlUrl = new URL(config.webUrl ?? config.publicUrl);
  const apiUrl = new URL(config.publicUrl);
  const throughWebProxy = controlUrl.origin !== apiUrl.origin;
  controlUrl.pathname = `${throughWebProxy ? "/api" : ""}/v1/projects/${encodeURIComponent(
    projectId,
  )}/previews/${encodeURIComponent(previewId)}/open`;
  controlUrl.search = "";
  controlUrl.hash = "";
  return controlUrl.toString();
}

async function readPreviewToken(config: AppConfig, token: string, now: number) {
  try {
    if (!token || Buffer.from(token, "base64").toString("base64") !== token) {
      throw invalidPreviewAccess();
    }
    const claims = PreviewAccessToken.parse(JSON.parse(await open(token, config.secretMasterKey)));
    if (claims.expiresAt <= now) throw invalidPreviewAccess();
    return claims;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidPreviewAccess();
  }
}

function invalidPreviewAccess() {
  return previewError(401, "preview_access_invalid", "Preview access is invalid or expired");
}

function hostname(rawHost: string | undefined) {
  if (!rawHost) return "";
  try {
    return new URL(`http://${rawHost}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export async function createPreviewRecord(db: Db, input: PreviewCreateInput) {
  const id = newId("sbx");
  const inserted = (
    await db
      .insert(previewSandboxes)
      .values({
        id,
        orgId: input.orgId,
        projectId: input.projectId,
        repoId: input.repoId,
        runId: input.runId,
        prNumber: input.prNumber,
        commitSha: input.commitSha,
        driver: input.driver ?? "docker",
        status: "provisioning",
        authMode: "facility_session",
        config: {
          image: input.image,
          command: input.command,
          port: input.port,
          readinessPath: input.readinessPath,
          cpu: 1,
          memoryMb: 1024,
        },
        expiresAt: new Date(Date.now() + input.ttlHours * 3_600_000),
        createdBy: input.createdBy,
      })
      .onConflictDoNothing()
      .returning()
  )[0];
  if (inserted || !input.runId) return inserted;
  return (
    await db
      .select()
      .from(previewSandboxes)
      .where(
        and(
          eq(previewSandboxes.runId, input.runId),
          eq(previewSandboxes.orgId, input.orgId),
          eq(previewSandboxes.projectId, input.projectId),
          inArray(previewSandboxes.status, ["provisioning", "running"]),
        ),
      )
      .limit(1)
  )[0];
}

export async function provisionPreview(
  config: AppConfig,
  previewId: string,
  driverOverride?: SandboxDriver,
) {
  const provisionStartedAt = Date.now();
  const { db, client } = createDb(config.databaseUrl);
  try {
    const claimedAt = new Date(provisionStartedAt);
    const staleClaim = new Date(provisionStartedAt - PreviewProvisionLeaseMs);
    const candidate = (
      await db.select().from(previewSandboxes).where(eq(previewSandboxes.id, previewId)).limit(1)
    )[0];
    if (
      candidate?.status !== "provisioning" ||
      candidate.ref ||
      (candidate.provisionClaimedAt && candidate.provisionClaimedAt >= staleClaim)
    ) {
      return candidate;
    }
    const recoveringLaunch = candidate.provisionClaimedAt !== null;
    const preview = (
      await db
        .update(previewSandboxes)
        .set({ provisionClaimedAt: claimedAt, updatedAt: claimedAt })
        .where(
          and(
            eq(previewSandboxes.id, previewId),
            eq(previewSandboxes.status, "provisioning"),
            isNull(previewSandboxes.ref),
            candidate.provisionClaimedAt
              ? eq(previewSandboxes.provisionClaimedAt, candidate.provisionClaimedAt)
              : isNull(previewSandboxes.provisionClaimedAt),
            or(
              isNull(previewSandboxes.provisionClaimedAt),
              lt(previewSandboxes.provisionClaimedAt, staleClaim),
            ),
          ),
        )
        .returning()
    )[0];
    if (!preview) {
      return (
        await db.select().from(previewSandboxes).where(eq(previewSandboxes.id, previewId)).limit(1)
      )[0];
    }
    const spec = previewConfig(preview.config);
    const driver = driverOverride ?? (await previewSandboxDriver(config.sandboxDriver));
    await db
      .update(previewSandboxes)
      .set({ driver: driver.name, updatedAt: new Date() })
      .where(eq(previewSandboxes.id, preview.id));
    let launchedRef: string | undefined;
    let launchStartedAt = provisionStartedAt;
    let launchFinishedAt: number | undefined;
    let recoveryLookupFailed = false;
    try {
      launchStartedAt = Date.now();
      const launchSpec = {
        runId: `preview:${preview.id}`,
        image: spec.image,
        cmd: spec.command,
        env: { PORT: String(spec.port), FACILITY_PREVIEW: "1" },
        cpu: spec.cpu,
        memoryMb: spec.memoryMb,
        timeoutMin: Math.max(1, Math.ceil((preview.expiresAt.getTime() - Date.now()) / 60_000)),
        network: { egress: "unrestricted" },
        servicePort: spec.port,
      };
      let launched: Awaited<ReturnType<SandboxDriver["launch"]>> | undefined;
      if (recoveringLaunch && driver.recoverLaunch) {
        try {
          launched = await driver.recoverLaunch({
            runId: launchSpec.runId,
            servicePort: launchSpec.servicePort,
          });
        } catch (error) {
          recoveryLookupFailed = true;
          throw error;
        }
      }
      launched ??= await driver.launch(launchSpec);
      launchFinishedAt = Date.now();
      launchedRef = launched.ref;
      const validEndpoint =
        launched.endpoint && allowedOrigin(launched.endpoint, driver.name)
          ? launched.endpoint
          : undefined;
      const [attached] = await db
        .update(previewSandboxes)
        .set({
          driver: driver.name,
          ref: launched.ref,
          ...(validEndpoint ? { originUrl: validEndpoint } : {}),
          provisionClaimedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(previewSandboxes.id, preview.id),
            eq(previewSandboxes.status, "provisioning"),
            isNull(previewSandboxes.ref),
            eq(previewSandboxes.provisionClaimedAt, claimedAt),
          ),
        )
        .returning({ id: previewSandboxes.id });
      if (!attached) {
        await retainAndDestroyUnattachedPreview(db, preview, driver, launched.ref);
        launchedRef = undefined;
        return (
          await db
            .select()
            .from(previewSandboxes)
            .where(eq(previewSandboxes.id, preview.id))
            .limit(1)
        )[0];
      }
      if (!validEndpoint) {
        try {
          await driver.destroy(launched.ref);
          await db
            .update(previewSandboxes)
            .set({ ref: null, updatedAt: new Date() })
            .where(eq(previewSandboxes.id, preview.id));
          launchedRef = undefined;
        } catch (cleanupError) {
          throw new SandboxLaunchError(
            "preview_driver_did_not_return_a_private_endpoint_and_cleanup_failed",
            launched.ref,
            { cause: cleanupError },
          );
        }
        throw new Error("preview_driver_did_not_return_a_private_endpoint");
      }
      const state = await driver.status(launched.ref);
      const ready =
        state === "running" &&
        (spec.readinessPath
          ? await waitForPreviewReadiness(validEndpoint, spec.readinessPath)
          : true);
      const status = ready ? "running" : "provisioning";
      const provisionFinishedAt = Date.now();
      const updated = (
        await db
          .update(previewSandboxes)
          .set({
            driver: driver.name,
            ref: launched.ref,
            originUrl: validEndpoint,
            status,
            ...(status === "running" ? { lastHealthAt: new Date() } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(previewSandboxes.id, preview.id),
              eq(previewSandboxes.status, "provisioning"),
              eq(previewSandboxes.ref, launched.ref),
            ),
          )
          .returning()
      )[0];
      if (!updated) {
        return (
          await db
            .select()
            .from(previewSandboxes)
            .where(eq(previewSandboxes.id, preview.id))
            .limit(1)
        )[0];
      }
      await insertAuditEvent(db, {
        orgId: preview.orgId,
        projectId: preview.projectId,
        actor: { type: "system", id: "preview.provisioner" },
        action: "preview.provisioned",
        target: { type: "preview", id: preview.id },
        payload: {
          driver: driver.name,
          status,
          auth_mode: "facility_session",
          queue_delay_ms: elapsedMs(preview.createdAt.getTime(), provisionStartedAt),
          launch_ms: elapsedMs(launchStartedAt, launchFinishedAt ?? provisionFinishedAt),
          total_ms: elapsedMs(preview.createdAt.getTime(), provisionFinishedAt),
        },
      });
      return updated;
    } catch (error) {
      const failedAt = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      if (recoveryLookupFailed) {
        await db
          .update(previewSandboxes)
          .set({
            error: `preview_recovery_failed:${message}`,
            // Preserve the stale marker so every retry must rediscover the
            // possibly-live external task before it is allowed to launch.
            provisionClaimedAt: candidate.provisionClaimedAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(previewSandboxes.id, preview.id),
              eq(previewSandboxes.status, "provisioning"),
              isNull(previewSandboxes.ref),
              eq(previewSandboxes.provisionClaimedAt, claimedAt),
            ),
          );
        throw error;
      }
      const retryRef = error instanceof SandboxLaunchError ? error.ref : launchedRef;
      const [failed] = await db
        .update(previewSandboxes)
        .set({
          status: "failed",
          error: message,
          provisionClaimedAt: null,
          ...(retryRef ? { ref: retryRef } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(previewSandboxes.id, preview.id),
            eq(previewSandboxes.status, "provisioning"),
            retryRef
              ? or(isNull(previewSandboxes.ref), eq(previewSandboxes.ref, retryRef))
              : isNull(previewSandboxes.ref),
          ),
        )
        .returning({ id: previewSandboxes.id });
      if (!failed) {
        if (retryRef) await retainAndDestroyUnattachedPreview(db, preview, driver, retryRef);
        throw error;
      }
      await insertAuditEvent(db, {
        orgId: preview.orgId,
        projectId: preview.projectId,
        actor: { type: "system", id: "preview.provisioner" },
        action: "preview.failed",
        target: { type: "preview", id: preview.id },
        payload: {
          error: message,
          queue_delay_ms: elapsedMs(preview.createdAt.getTime(), provisionStartedAt),
          launch_ms: elapsedMs(launchStartedAt, launchFinishedAt ?? failedAt),
          total_ms: elapsedMs(preview.createdAt.getTime(), failedAt),
        },
      });
      throw error;
    }
  } finally {
    await client.end();
  }
}

async function retainAndDestroyUnattachedPreview(
  db: Db,
  preview: Preview,
  driver: SandboxDriver,
  ref: string,
) {
  const [retained] = await db
    .update(previewSandboxes)
    .set({
      driver: driver.name,
      ref,
      error: "preview_attach_lost_cleanup_pending",
      provisionClaimedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(previewSandboxes.id, preview.id), isNull(previewSandboxes.ref)))
    .returning({ id: previewSandboxes.id });
  if (!retained) {
    const current = (
      await db
        .select({ ref: previewSandboxes.ref })
        .from(previewSandboxes)
        .where(eq(previewSandboxes.id, preview.id))
        .limit(1)
    )[0];
    // A recovery worker can adopt the same deterministic ECS task while the
    // original launcher is merely slow. In that case the ref is owned, not an
    // orphan, and destroying it would invalidate the recovered preview.
    if (current?.ref === ref) return;
  }
  try {
    await driver.destroy(ref);
  } catch (error) {
    if (retained) return;
    throw error;
  }
  if (retained) {
    await db
      .update(previewSandboxes)
      .set({ ref: null, error: null, updatedAt: new Date() })
      .where(and(eq(previewSandboxes.id, preview.id), eq(previewSandboxes.ref, ref)));
  }
}

function elapsedMs(startedAt: number, endedAt: number) {
  return Math.max(0, endedAt - startedAt);
}

export async function destroyPreview(
  db: Db,
  preview: Preview,
  status: "destroyed" | "expired" = "destroyed",
  driverOverride?: SandboxDriver,
) {
  if (!["destroyed", "expired"].includes(preview.status) && preview.ref) {
    const driver =
      driverOverride ?? (await previewSandboxDriver(preview.driver as "docker" | "aws"));
    try {
      await driver.destroy(preview.ref);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(previewSandboxes)
        .set({ error: `destroy_failed:${message}`, updatedAt: new Date() })
        .where(and(eq(previewSandboxes.orgId, preview.orgId), eq(previewSandboxes.id, preview.id)));
      await insertAuditEvent(db, {
        orgId: preview.orgId,
        projectId: preview.projectId,
        actor: { type: "system", id: "preview.lifecycle" },
        action: "preview.destroy_failed",
        target: { type: "preview", id: preview.id },
        payload: { driver: preview.driver, error: message },
      });
      throw error;
    }
  }
  const updated = (
    await db
      .update(previewSandboxes)
      .set({ status, ref: null, originUrl: null, updatedAt: new Date() })
      .where(and(eq(previewSandboxes.orgId, preview.orgId), eq(previewSandboxes.id, preview.id)))
      .returning()
  )[0];
  await insertAuditEvent(db, {
    orgId: preview.orgId,
    projectId: preview.projectId,
    actor: { type: "system", id: "preview.lifecycle" },
    action: status === "expired" ? "preview.expired" : "preview.destroyed",
    target: { type: "preview", id: preview.id },
    payload: { driver: preview.driver },
  });
  return updated;
}

export async function destroyPreviewById(config: AppConfig, previewId: string) {
  const { db, client } = createDb(config.databaseUrl);
  try {
    const preview = (
      await db.select().from(previewSandboxes).where(eq(previewSandboxes.id, previewId)).limit(1)
    )[0];
    if (!preview) return null;
    return destroyPreview(db, preview);
  } finally {
    await client.end();
  }
}

export async function reconcilePreviews(
  config: AppConfig,
  driverOverride?: SandboxDriver,
  enqueueProvision?: (previewId: string) => Promise<unknown>,
) {
  const { db, client } = createDb(config.databaseUrl);
  const changed: string[] = [];
  const requeued: string[] = [];
  try {
    await db.delete(previewAccessHandoffs).where(lt(previewAccessHandoffs.expiresAt, new Date()));
    const expired = await db
      .select()
      .from(previewSandboxes)
      .where(
        and(
          inArray(previewSandboxes.status, ["provisioning", "running"]),
          lt(previewSandboxes.expiresAt, new Date()),
        ),
      );
    for (const preview of expired) {
      await destroyPreview(db, preview, "expired", driverOverride);
      changed.push(preview.id);
    }
    const active = await db
      .select()
      .from(previewSandboxes)
      .where(inArray(previewSandboxes.status, ["provisioning", "running"]));
    for (const preview of active) {
      if (!preview.ref) {
        const provisionClaimedAt = preview.provisionClaimedAt;
        const claimIsStale =
          provisionClaimedAt !== null &&
          provisionClaimedAt.getTime() < Date.now() - PreviewProvisionLeaseMs;
        if (preview.status === "provisioning" && (!provisionClaimedAt || claimIsStale)) {
          if (enqueueProvision) {
            await enqueueProvision(preview.id);
            requeued.push(preview.id);
          }
        }
        continue;
      }
      if (preview.error === "preview_attach_lost_cleanup_pending") continue;
      const driver =
        driverOverride ?? (await previewSandboxDriver(preview.driver as "docker" | "aws"));
      const state = await driver.status(preview.ref);
      const spec = previewConfig(preview.config);
      const ready =
        state === "running" &&
        (!spec.readinessPath ||
          (preview.originUrl
            ? await previewReadinessCheck(preview.originUrl, spec.readinessPath)
            : false));
      if (ready && preview.status !== "running") {
        await db
          .update(previewSandboxes)
          .set({ status: "running", lastHealthAt: new Date(), updatedAt: new Date() })
          .where(eq(previewSandboxes.id, preview.id));
        changed.push(preview.id);
      } else if (state === "exited" || state === "lost") {
        let cleanupError: string | null = null;
        try {
          await driver.destroy(preview.ref);
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : String(error);
        }
        await db
          .update(previewSandboxes)
          .set({
            status: "failed",
            error: `preview_${state}${cleanupError ? `;cleanup_failed:${cleanupError}` : ""}`,
            ...(cleanupError ? {} : { ref: null }),
            updatedAt: new Date(),
          })
          .where(eq(previewSandboxes.id, preview.id));
        changed.push(preview.id);
      }
    }
    // A transient ECS/Docker failure must not make a failed preview immortal.
    // Retain its ref on failure and retry cleanup on each reconciliation pass;
    // clear it only after the task/container and its per-preview definition are
    // gone.
    const cleanupPendingRefs = await db
      .select()
      .from(previewSandboxes)
      .where(
        or(
          inArray(previewSandboxes.status, ["failed", "expired", "destroyed"]),
          eq(previewSandboxes.error, "preview_attach_lost_cleanup_pending"),
        ),
      );
    for (const preview of cleanupPendingRefs) {
      if (!preview.ref) continue;
      const driver =
        driverOverride ?? (await previewSandboxDriver(preview.driver as "docker" | "aws"));
      try {
        await driver.destroy(preview.ref);
        await db
          .update(previewSandboxes)
          .set({
            ref: null,
            ...(preview.error === "preview_attach_lost_cleanup_pending" ? { error: null } : {}),
            updatedAt: new Date(),
          })
          .where(eq(previewSandboxes.id, preview.id));
        changed.push(preview.id);
      } catch {
        // Keep the ref for the next bounded worker reconciliation.
      }
    }
    return { changed, requeued };
  } finally {
    await client.end();
  }
}

export async function proxyPreviewRequest(
  preview: Preview,
  path: string,
  method: "GET" | "HEAD",
  headers: Record<string, string | string[] | undefined>,
) {
  if (preview.status !== "running" || !preview.originUrl) {
    throw previewError(409, "preview_not_running", "Preview environment is not running");
  }
  if (!allowedOrigin(preview.originUrl, preview.driver)) {
    throw previewError(502, "preview_origin_invalid", "Preview origin is not a private endpoint");
  }
  const target = previewTarget(preview.originUrl, path);
  const forwarded: Record<string, string> = { accept: String(headers.accept ?? "*/*") };
  if (headers["user-agent"]) forwarded["user-agent"] = String(headers["user-agent"]);
  if (headers["if-none-match"]) forwarded["if-none-match"] = String(headers["if-none-match"]);
  if (headers["if-modified-since"])
    forwarded["if-modified-since"] = String(headers["if-modified-since"]);
  forwarded["accept-encoding"] = "identity";
  return upstreamRequest(target, { method, headers: forwarded });
}

export function rewritePreviewHtml(html: string, previewId: string) {
  const prefix = `/preview/${encodeURIComponent(previewId)}/`;
  return html.replace(/\b(href|src|action)=(['"])\/(?!\/)/gi, `$1=$2${prefix}`);
}

function previewConfig(value: unknown) {
  const config = record(value);
  const image = typeof config.image === "string" ? config.image.trim() : "";
  const port = Number(config.port);
  if (!image || image.length > 300 || /\s/.test(image)) throw new Error("preview_image_invalid");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("preview_port_invalid");
  const command = Array.isArray(config.command)
    ? config.command.filter(
        (part): part is string => typeof part === "string" && part.length <= 500,
      )
    : undefined;
  return {
    image,
    port,
    command: command?.length ? command : undefined,
    readinessPath: readinessPath(config.readinessPath),
    cpu: numberInRange(config.cpu, 0.25, 4, 1),
    memoryMb: numberInRange(config.memoryMb, 128, 8192, 1024),
  };
}

function readinessPath(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error("preview_readiness_path_invalid");
  }
  return value;
}

async function waitForPreviewReadiness(origin: string, path: string) {
  const deadline = Date.now() + 20_000;
  do {
    if (await previewReadinessCheck(origin, path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  return false;
}

async function previewReadinessCheck(origin: string, path: string) {
  try {
    const response = await upstreamRequest(previewTarget(origin, path), {
      method: "GET",
      headersTimeout: 2_000,
      bodyTimeout: 2_000,
    });
    await response.body.dump();
    return response.statusCode >= 200 && response.statusCode < 400;
  } catch {
    return false;
  }
}

function previewTarget(origin: string, path: string) {
  const base = new URL(origin);
  const target = new URL(base);
  target.pathname = `/${path.replace(/^\/+/, "")}`;
  target.search = "";
  target.hash = "";
  return target;
}

function numberInRange(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function allowedOrigin(value: string, driver: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.username || url.password) return false;
    if (driver === "docker") return url.hostname === "127.0.0.1";
    return privateIpv4(url.hostname);
  } catch {
    return false;
  }
}

function privateIpv4(host: string) {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function previewError(statusCode: number, code: string, message: string) {
  return new ApiError(statusCode, code, message);
}
