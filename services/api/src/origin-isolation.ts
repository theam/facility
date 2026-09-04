import { timingSafeEqual } from "node:crypto";
import { getDomain } from "tldts";
import { ApiError } from "./errors.js";
import type { AppConfig } from "./types.js";

export function registeredSite(hostname: string) {
  return getDomain(hostname, { allowPrivateDomains: true });
}

export function isolatedPreviewOrigin(config: AppConfig) {
  if (!config.previewUrl) return false;
  const previewSite = registeredSite(new URL(config.previewUrl).hostname);
  if (!previewSite) return false;
  return [config.publicUrl, config.webUrl ?? config.publicUrl, config.mcpPublicUrl]
    .filter((value): value is string => Boolean(value))
    .every((value) => registeredSite(new URL(value).hostname) !== previewSite);
}

export function assertWorkspacePreviewAvailable(
  config: AppConfig,
): asserts config is AppConfig & { previewUrl: string } {
  if (!config.previewUrl) {
    throw new ApiError(503, "preview_origin_unavailable", "Facility preview URL is not configured");
  }
  if (!config.facilityInsecureDev && !isolatedPreviewOrigin(config)) {
    throw new ApiError(
      503,
      "preview_origin_unavailable",
      "Facility preview URL must use a registered site separate from the control plane",
    );
  }
}

export function assertPreviewOriginSurface(
  config: AppConfig,
  rawHost: string | undefined,
  rawPath: string,
  rawSurfaceToken?: string | string[],
) {
  if (!isolatedPreviewOrigin(config) || !config.previewUrl) return;
  const requestHost = hostname(rawHost);
  const previewHost = new URL(config.previewUrl).hostname.toLowerCase();
  const proxyMarked = previewSurfaceTokenMatches(config.previewSurfaceToken, rawSurfaceToken);
  let path: string;
  try {
    path = decodeURIComponent(rawPath.split("?", 1)[0] ?? "/");
  } catch {
    throw new ApiError(404, "not_found", "Route not found");
  }
  const servesPreview = /^\/(?:workspace-preview|workspace-preview-auth)\//.test(path);
  if ((requestHost === previewHost || proxyMarked) !== servesPreview) {
    throw new ApiError(404, "not_found", "Route not found");
  }
}

function previewSurfaceTokenMatches(
  expected: string | undefined,
  candidate: string | string[] | undefined,
) {
  if (!expected || typeof candidate !== "string") return false;
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return (
    expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes)
  );
}

function hostname(rawHost: string | undefined) {
  try {
    return new URL(`http://${rawHost ?? ""}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}
