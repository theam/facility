import { newId } from "@facility/core";
import { createDb, insertAuditEvent, previewSandboxes } from "@facility/db";
import { and, eq, inArray, lt } from "drizzle-orm";
import { request as upstreamRequest } from "undici";
import { previewSandboxDriver, type SandboxDriver } from "./sandbox/driver.js";
import type { AppConfig, Principal } from "./types.js";

type Db = ReturnType<typeof createDb>["db"];
type Preview = typeof previewSandboxes.$inferSelect;

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
}

export async function createPreviewRecord(db: Db, input: PreviewCreateInput) {
  const id = newId("sbx");
  return (
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
      .returning()
  )[0];
}

export async function provisionPreview(
  config: AppConfig,
  previewId: string,
  driverOverride?: SandboxDriver,
) {
  const { db, client } = createDb(config.databaseUrl);
  try {
    const preview = (
      await db.select().from(previewSandboxes).where(eq(previewSandboxes.id, previewId)).limit(1)
    )[0];
    if (preview?.status !== "provisioning" || preview.ref) return preview;
    const spec = previewConfig(preview.config);
    const driver = driverOverride ?? (await previewSandboxDriver(config.sandboxDriver));
    await db
      .update(previewSandboxes)
      .set({ driver: driver.name, updatedAt: new Date() })
      .where(eq(previewSandboxes.id, preview.id));
    try {
      const launched = await driver.launch({
        runId: `preview:${preview.id}`,
        image: spec.image,
        cmd: spec.command,
        env: { PORT: String(spec.port), FACILITY_PREVIEW: "1" },
        cpu: spec.cpu,
        memoryMb: spec.memoryMb,
        timeoutMin: Math.max(1, Math.ceil((preview.expiresAt.getTime() - Date.now()) / 60_000)),
        network: { egress: "unrestricted" },
        servicePort: spec.port,
      });
      if (!launched.endpoint || !allowedOrigin(launched.endpoint, driver.name)) {
        await driver.destroy(launched.ref).catch(() => undefined);
        throw new Error("preview_driver_did_not_return_a_private_endpoint");
      }
      const state = await driver.status(launched.ref);
      const ready =
        state === "running" &&
        (spec.readinessPath
          ? await waitForPreviewReadiness(launched.endpoint, spec.readinessPath)
          : true);
      const status = ready ? "running" : "provisioning";
      const updated = (
        await db
          .update(previewSandboxes)
          .set({
            driver: driver.name,
            ref: launched.ref,
            originUrl: launched.endpoint,
            status,
            ...(status === "running" ? { lastHealthAt: new Date() } : {}),
            updatedAt: new Date(),
          })
          .where(eq(previewSandboxes.id, preview.id))
          .returning()
      )[0];
      await insertAuditEvent(db, {
        orgId: preview.orgId,
        projectId: preview.projectId,
        actor: { type: "system", id: "preview.provisioner" },
        action: "preview.provisioned",
        target: { type: "preview", id: preview.id },
        payload: { driver: driver.name, status, auth_mode: "facility_session" },
      });
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(previewSandboxes)
        .set({ status: "failed", error: message, updatedAt: new Date() })
        .where(eq(previewSandboxes.id, preview.id));
      await insertAuditEvent(db, {
        orgId: preview.orgId,
        projectId: preview.projectId,
        actor: { type: "system", id: "preview.provisioner" },
        action: "preview.failed",
        target: { type: "preview", id: preview.id },
        payload: { error: message },
      });
      throw error;
    }
  } finally {
    await client.end();
  }
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
      .set({ status, originUrl: null, updatedAt: new Date() })
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

export async function reconcilePreviews(config: AppConfig) {
  const { db, client } = createDb(config.databaseUrl);
  const changed: string[] = [];
  try {
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
      await destroyPreview(db, preview, "expired");
      changed.push(preview.id);
    }
    const active = await db
      .select()
      .from(previewSandboxes)
      .where(inArray(previewSandboxes.status, ["provisioning", "running"]));
    for (const preview of active) {
      if (!preview.ref) continue;
      const driver = await previewSandboxDriver(preview.driver as "docker" | "aws");
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
        await db
          .update(previewSandboxes)
          .set({ status: "failed", error: `preview_${state}`, updatedAt: new Date() })
          .where(eq(previewSandboxes.id, preview.id));
        changed.push(preview.id);
      }
    }
    return { changed };
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
  return Object.assign(new Error(message), { statusCode, code });
}
