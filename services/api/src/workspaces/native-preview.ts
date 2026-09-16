import { createHash, timingSafeEqual } from "node:crypto";
import { can } from "@facility/core";

export const PREVIEW_GRANT_TTL_MS = 60_000;
export const PREVIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function canViewPreview(permissions: readonly string[]) {
  return can(permissions, "previews:read") || can(permissions, "workspaces:execute");
}

export function previewTokenHash(token: string) {
  return PREVIEW_TOKEN_PATTERN.test(token)
    ? createHash("sha256").update(token).digest("hex")
    : "invalid";
}

export function previewChallenge(verifier: string) {
  return PREVIEW_TOKEN_PATTERN.test(verifier)
    ? createHash("sha256").update(verifier).digest("base64url")
    : "invalid";
}

export function equalPreviewSecret(candidate: unknown, expected: unknown) {
  if (typeof candidate !== "string" || typeof expected !== "string" || expected.length < 32)
    return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Only runtime-discovered native endpoints, never arbitrary caller return URLs. */
export function nativePreviewOrigin(endpoints: unknown, service: string): string | undefined {
  if (!Array.isArray(endpoints)) return undefined;
  const endpoint = endpoints.find((item) => item?.service === service && item?.access === "native");
  if (typeof endpoint?.url !== "string") return undefined;
  try {
    const url = new URL(endpoint.url);
    if (
      url.origin !== endpoint.url ||
      url.protocol !== "https:" ||
      !/^[a-z0-9-]+\.vercel\.run$/.test(url.hostname) ||
      url.port ||
      url.username ||
      url.password
    )
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
