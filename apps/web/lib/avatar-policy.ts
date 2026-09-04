/**
 * Avatar delivery policy, shared by every call site and pinned by tests.
 *
 * Browsers never contact an avatar host. Images travel through this
 * deployment's own `/api/avatars/…` routes (mode "proxy"), or do not exist
 * and the initial letter underneath shows instead (mode "off"). The
 * browser-direct mode the first cut of this feature shipped is gone: it
 * leaked the deployment origin to GitHub through the referrer and required
 * third-party egress that air-gapped deployments must not make.
 */

export type AvatarMode = "proxy" | "off";

export const AVATAR_MODE_ENV = "NEXT_PUBLIC_FACILITY_AVATARS";

/** Read the operator's avatar mode. Unknown values fail closed to "off". */
export function avatarMode(envValue: string | undefined | null): AvatarMode {
  const value = (envValue ?? "").trim().toLowerCase();
  // Default: same-origin proxying. Nothing leaves the deployment's origin
  // from the browser.
  if (!value || value === "proxy") return "proxy";
  return "off";
}

function currentMode(): AvatarMode {
  // NEXT_PUBLIC_* is inlined at build time, so client components can read it.
  return avatarMode(process.env[AVATAR_MODE_ENV]);
}

/** GitHub logins: alphanumerics and inner hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

/**
 * The image source for an assignee's avatar, served by this deployment, or
 * null when there is nothing to draw (blank login, or avatars disabled).
 * Null keeps the CSS background from ever being set, so the initial letter
 * underneath shows through untouched.
 */
export function avatarSrcFor(login: string, mode?: AvatarMode): string | null {
  const trimmed = login.trim();
  if (!trimmed) return null;
  if ((mode ?? currentMode()) === "off") return null;
  return `/api/avatars/u/${encodeURIComponent(trimmed)}`;
}

/**
 * The image source for a principal's stored avatar URL, rewritten onto this
 * deployment's proxy routes. Only known GitHub avatar shapes are rewritten
 * (`github.com/{login}.png`, `avatars.githubusercontent.com/u/{id}`); any
 * other host falls back to the login-based source so the browser is never
 * pointed at an unreviewed origin. Null when there is nothing to draw.
 */
export function principalAvatarSrc(
  avatarUrl: string | null | undefined,
  login: string | null | undefined,
  mode?: AvatarMode,
): string | null {
  const effective = mode ?? currentMode();
  if (effective === "off") return null;

  if (avatarUrl) {
    try {
      const url = new URL(avatarUrl);
      if (
        url.protocol === "https:" &&
        url.host === "avatars.githubusercontent.com" &&
        /^\/u\/\d{1,12}$/.test(url.pathname)
      ) {
        return `/api/avatars/id/${url.pathname.slice("/u/".length)}`;
      }
      if (
        url.protocol === "https:" &&
        url.host === "github.com" &&
        GITHUB_LOGIN.test(url.pathname.slice(1).replace(/\.png$/, "")) &&
        /^\/[^/]+\.png$/.test(url.pathname)
      ) {
        return `/api/avatars/u/${url.pathname.slice(1).replace(/\.png$/, "")}`;
      }
    } catch {
      // Not a URL at all — fall through to the login-derived source.
    }
  }
  return login ? avatarSrcFor(login, effective) : null;
}
