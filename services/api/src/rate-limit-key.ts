import { open } from "@facility/core";

const SESSION_COOKIE = "facility_session";
const USER_ID = /^[a-z0-9_]{1,80}$/;

/**
 * Signed-in callers get their own budget. The web task proxies every browser
 * through one address, so an IP key would make those users share 200
 * requests/minute. A cookie counts only after it opens with the master key;
 * missing, forged, and expired cookies stay on the connection IP. Forwarded
 * address headers are not a key.
 */
export async function rateLimitKey(
  input: { ip: string; cookieHeader: string | undefined },
  masterKey: string,
): Promise<string> {
  const sealed = sessionCookie(input.cookieHeader);
  if (!sealed) return input.ip;
  try {
    const parsed = JSON.parse(await open(sealed, masterKey)) as { userId?: unknown; exp?: unknown };
    if (typeof parsed.userId !== "string" || !USER_ID.test(parsed.userId)) return input.ip;
    if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp) || parsed.exp < Date.now()) {
      return input.ip;
    }
    return `session:${parsed.userId}`;
  } catch {
    return input.ip;
  }
}

function sessionCookie(header: string | undefined) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}
