import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { registeredSite } from "../origin-isolation.js";
import type { AppConfig } from "../types.js";

const Site = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,64}$/),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    workspaceId: z.string().min(1),
    service: z.string().min(1),
    origin: z.string().url(),
    surfaceToken: z.string().min(32).max(128),
  })
  .strict();
export type PreviewSite = z.infer<typeof Site>;
export const SITE_COOKIE = "__Host-facility-preview";
export const SITE_PREFIX = "/workspace-preview-site/";

// Operator configuration, never supplied by a workspace or inferred from Host.
// Every site must have its own browser site and reverse-proxy credential.
export function parsePreviewSites(
  raw: string | undefined,
  config: Pick<
    AppConfig,
    "publicUrl" | "webUrl" | "mcpPublicUrl" | "previewUrl" | "facilityInsecureDev"
  >,
): PreviewSite[] {
  if (!raw?.trim()) return [];
  try {
    const sites = z.array(Site).max(200).parse(JSON.parse(raw));
    const origins = new Set<string>();
    const ids = new Set<string>();
    const tokens = new Set<string>();
    const bindings = new Set<string>();
    const registered = new Set(
      [config.publicUrl, config.webUrl, config.mcpPublicUrl, config.previewUrl]
        .filter((url): url is string => Boolean(url))
        .map((url) => registeredSite(new URL(url).hostname)),
    );
    for (const site of sites) {
      const url = new URL(site.origin);
      const domain = registeredSite(url.hostname);
      const binding = JSON.stringify([site.orgId, site.projectId, site.workspaceId, site.service]);
      if (
        url.origin !== site.origin ||
        url.username ||
        url.password ||
        (!config.facilityInsecureDev &&
          (url.protocol !== "https:" || !domain || registered.has(domain))) ||
        origins.has(site.origin) ||
        ids.has(site.id) ||
        tokens.has(site.surfaceToken) ||
        bindings.has(binding)
      ) {
        throw new Error("invalid site");
      }
      origins.add(site.origin);
      ids.add(site.id);
      tokens.add(site.surfaceToken);
      bindings.add(binding);
      registered.add(domain);
    }
    return sites;
  } catch {
    // Do not include Zod input or the credential-bearing JSON in startup logs.
    throw new Error(
      "FACILITY_PREVIEW_SITES must contain unique, isolated workspace service origins and credentials",
    );
  }
}

export function previewSiteFor(
  config: AppConfig,
  binding: Pick<PreviewSite, "orgId" | "projectId" | "workspaceId" | "service">,
) {
  return config.previewSites?.find(
    (site) =>
      site.orgId === binding.orgId &&
      site.projectId === binding.projectId &&
      site.workspaceId === binding.workspaceId &&
      site.service === binding.service,
  );
}

export function assertSiteSession(
  site: PreviewSite,
  session: Pick<PreviewSite, "orgId" | "projectId" | "workspaceId" | "service">,
) {
  if (
    site.orgId !== session.orgId ||
    site.projectId !== session.projectId ||
    site.workspaceId !== session.workspaceId ||
    site.service !== session.service
  ) {
    throw new ApiError(401, "preview_access_invalid", "Preview access is invalid or expired");
  }
}

export function isSiteSurface(
  config: AppConfig,
  path: string,
  token: string | string[] | undefined,
) {
  const siteId = path.slice(SITE_PREFIX.length).split("/", 1)[0];
  const site = config.previewSites?.find((entry) => entry.id === siteId);
  if (!path.startsWith(SITE_PREFIX) || !site || typeof token !== "string") return false;
  const actual = Buffer.from(token);
  const expected = Buffer.from(site.surfaceToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
