/**
 * Server-side policy for `/api/avatars/...` routes.
 *
 * The browser only ever talks to this deployment. These functions decide,
 * on the server, which upstream hosts may be fetched and with what headers:
 * targets are pinned to two GitHub avatar hosts by exact-shape match, so no
 * request URL can ever point anywhere else, and the outbound request
 * carries nothing about the deployment or the viewer — no cookies, no
 * forwarding chain, no referrer. The same pinning applies to every redirect
 * hop, because a host that may serve an avatar may still answer with a
 * Location pointing somewhere it may not. A failed upstream fetch maps to a
 * plain 404, which leaves the CSS background unset and the initial letter
 * underneath untouched on every client.
 *
 * Who may cause a fetch, and how often, is decided in `avatar-egress.ts`.
 */

/** GitHub logins: alphanumerics and inner hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

const GITHUB_USER_ID = /^\d{1,12}$/;

export type AvatarTarget = { kind: "login"; login: string } | { kind: "id"; id: string };

/**
 * Parse an `/api/avatars/u/{login}` or `/api/avatars/id/{id}` tail into a
 * validated upstream target, or null when the path is not one of the two
 * exact shapes this route serves.
 */
export function parseAvatarTarget(segments: string[]): AvatarTarget | null {
  if (segments.length !== 2) return null;
  const [kind, value] = segments;
  if (!kind || !value) return null;
  if (kind === "u" && GITHUB_LOGIN.test(value)) return { kind: "login", login: value };
  if (kind === "id" && GITHUB_USER_ID.test(value)) return { kind: "id", id: value };
  return null;
}

/** The upstream URL for a validated target. Nothing else is ever fetched. */
export function avatarUpstreamUrl(target: AvatarTarget): string {
  return target.kind === "login"
    ? `https://github.com/${target.login}.png?size=40`
    : `https://avatars.githubusercontent.com/u/${target.id}?v=4&size=40`;
}

/**
 * Outbound headers: deliberately fresh. No authorization, cookies, or
 * forwarding chain from the inbound request survive, and no referrer or
 * origin travels to GitHub — the request is made by the deployment server,
 * not the viewer's browser.
 */
export function avatarUpstreamHeaders(): Headers {
  const headers = new Headers({ accept: "image/*" });
  headers.delete("referer");
  headers.delete("origin");
  return headers;
}

/** Only successful image responses are forwarded; everything else fails closed. */
export function isForwardableAvatarResponse(response: Response): boolean {
  return response.ok && (response.headers.get("content-type") ?? "").startsWith("image/");
}

/**
 * The only hosts an avatar fetch may reach — at the first request and at
 * every redirect hop alike. `github.com/{login}.png` answers with a 302 to
 * `avatars.githubusercontent.com`, so hops must be followed, but an upstream
 * that answers with a redirect anywhere else is not serving an avatar.
 */
const AVATAR_UPSTREAM_HOSTS = new Set(["github.com", "avatars.githubusercontent.com"]);

/**
 * Redirect hops followed before the fetch fails closed. GitHub's own chain is
 * one hop; the rest is slack, not an invitation.
 */
export const MAX_AVATAR_REDIRECT_HOPS = 3;

/** Whether a URL is one this deployment may fetch an avatar from. */
export function isAllowedAvatarUpstream(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && AVATAR_UPSTREAM_HOSTS.has(parsed.host);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type AvatarRedirect = { kind: "follow"; url: string } | { kind: "deny" };

/**
 * Where a redirect points, resolved against the URL that produced it, or null
 * when the response is not a redirect and its body is the answer. A hop off
 * the two permitted hosts, a missing Location, and an unparsable Location all
 * come back as `deny`: the route never fetches a URL it has not vetted, which
 * is what following redirects in the fetch layer gave away.
 */
export function nextAvatarRedirect(
  status: number,
  location: string | null,
  from: string,
): AvatarRedirect | null {
  if (!REDIRECT_STATUSES.has(status)) return null;
  if (!location) return { kind: "deny" };
  let resolved: string;
  try {
    resolved = new URL(location, from).toString();
  } catch {
    return { kind: "deny" };
  }
  return isAllowedAvatarUpstream(resolved) ? { kind: "follow", url: resolved } : { kind: "deny" };
}
