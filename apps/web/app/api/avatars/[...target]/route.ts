import { avatarMode } from "@/lib/avatar-policy";
import {
  allowUpstreamFetch,
  avatarViewerId,
  type CachedAvatar,
  cachedAvatar,
  MAX_AVATAR_BYTES,
  rememberAvatar,
} from "@/lib/avatar-gate";
import {
  type AvatarTarget,
  avatarUpstreamHeaders,
  avatarUpstreamUrl,
  isAllowedAvatarUpstream,
  isForwardableAvatarResponse,
  MAX_AVATAR_REDIRECT_HOPS,
  nextAvatarRedirect,
  parseAvatarTarget,
} from "@/lib/avatar-proxy";

export const dynamic = "force-dynamic";

/**
 * Same-origin avatar images: `/api/avatars/u/{login}` and
 * `/api/avatars/id/{id}`. The browser never contacts GitHub; this route
 * fetches server-side with fresh, referrer-free headers and forwards only
 * successful image bytes.
 *
 * Reaching GitHub is a privilege, not a side effect of being reachable. A
 * request only causes an upstream fetch when it carries a session the control
 * plane recognises, when no cached answer already exists, and when the
 * viewer's fetch allowance is not spent — so the number of requests that can
 * arrive at this route no longer bounds the egress it produces.
 *
 * An unauthenticated caller gets 401. Any other path, an invalid target, a
 * disabled avatar mode, a spent allowance, or an upstream failure maps to
 * 404. Every one of those leaves the caller's CSS background unset and its
 * initial letter showing, so no failure is visible as a broken image.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ target: string[] }> },
) {
  if (avatarMode(process.env.NEXT_PUBLIC_FACILITY_AVATARS) === "off") {
    return empty(404);
  }

  const { target: segments } = await params;
  const target = parseAvatarTarget(segments ?? []);
  if (!target) return empty(404);

  const viewer = await avatarViewerId(request);
  if (!viewer) return empty(401);

  const key = avatarCacheKey(target);
  const cached = cachedAvatar(key);
  if (cached) return deliver(cached);

  if (!allowUpstreamFetch(viewer)) return empty(429);

  const fetched = await fetchAvatar(target);
  rememberAvatar(key, fetched);
  return deliver(fetched);
}

function avatarCacheKey(target: AvatarTarget): string {
  return target.kind === "login" ? `u/${target.login}` : `id/${target.id}`;
}

/**
 * Fetch one avatar, following redirects by hand. `redirect: "manual"` is the
 * point: the fetch layer would follow a hop to any host the upstream names,
 * so each Location is resolved and vetted against the permitted hosts here
 * before it becomes a request, and the chain is cut off after a fixed number
 * of hops rather than run to whatever length the upstream chooses.
 */
async function fetchAvatar(target: AvatarTarget): Promise<CachedAvatar> {
  let url = avatarUpstreamUrl(target);
  try {
    for (let hop = 0; hop <= MAX_AVATAR_REDIRECT_HOPS; hop += 1) {
      if (!isAllowedAvatarUpstream(url)) return { kind: "missing" };
      const response = await fetch(url, {
        headers: avatarUpstreamHeaders(),
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
        cache: "no-store",
      });

      const redirect = nextAvatarRedirect(response.status, response.headers.get("location"), url);
      if (redirect) {
        await response.body?.cancel();
        if (redirect.kind === "deny") return { kind: "missing" };
        url = redirect.url;
        continue;
      }

      if (!isForwardableAvatarResponse(response)) {
        await response.body?.cancel();
        return { kind: "missing" };
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > MAX_AVATAR_BYTES) {
        await response.body?.cancel();
        return { kind: "missing" };
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_AVATAR_BYTES) return { kind: "missing" };
      return {
        kind: "image",
        bytes,
        contentType: response.headers.get("content-type") ?? "image/png",
      };
    }
    // Hops exhausted: the upstream is redirecting in a loop, not serving.
    return { kind: "missing" };
  } catch {
    return { kind: "missing" };
  }
}

function deliver(avatar: CachedAvatar) {
  if (avatar.kind === "missing") return empty(404);
  return new Response(avatar.bytes, {
    status: 200,
    headers: {
      "content-type": avatar.contentType,
      // Avatars change rarely; let the browser keep one for a day, and
      // revalidate against this route afterwards. Private: the bytes are
      // served only to an authenticated viewer, so no shared cache may hold
      // them on behalf of everyone else.
      "cache-control": "private, max-age=86400",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}

function empty(status: number) {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}
