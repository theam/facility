import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { AppConfig } from "./types.js";

export type OauthConfig = {
  issuer: string;
  audience: string;
  jwks: JSONWebKeySet;
};

export type AccessTokenClaims = { userId: string; orgId: string; scope: string };

export class AccessTokenError extends Error {
  constructor(message = "Invalid access token") {
    super(message);
    this.name = "AccessTokenError";
  }
}

export function oauthConfigFromApp(config: AppConfig): OauthConfig | null {
  if (!config.oauthIssuer || !config.mcpPublicUrl || !config.oauthJwks) return null;
  return {
    issuer: config.oauthIssuer,
    audience: config.mcpPublicUrl,
    jwks: {
      // This derives a verification set from signing keys, so an operation the
      // source key declares cannot carry over: `key_ops: ["sign"]` describes the
      // private half, and jose skips any candidate whose `key_ops` omits
      // "verify", which leaves the instance unable to verify the tokens it just
      // signed. Drop it with the private members rather than translating it, so
      // the derived set constrains nothing beyond `kid`, `alg`, and `use`.
      keys: config.oauthJwks.keys.map(
        ({
          d: _d,
          p: _p,
          q: _q,
          dp: _dp,
          dq: _dq,
          qi: _qi,
          oth: _oth,
          key_ops: _keyOps,
          ext: _ext,
          ...publicKey
        }) => publicKey,
      ),
    } as JSONWebKeySet,
  };
}

export async function verifyAccessToken(
  token: string,
  config: OauthConfig,
  jwks: JWTVerifyGetKey = createLocalJWKSet(config.jwks),
): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["ES256"],
      requiredClaims: ["exp", "iat", "sub", "org_id", "scope"],
    });
    const userId = typeof payload.sub === "string" ? payload.sub : "";
    const orgId = typeof payload.org_id === "string" ? payload.org_id : "";
    const scope = typeof payload.scope === "string" ? payload.scope : "";
    if (!userId || !orgId || !scope.split(/\s+/).includes("facility:mcp"))
      throw new AccessTokenError();
    return { userId, orgId, scope };
  } catch (error) {
    if (error instanceof AccessTokenError) throw error;
    throw new AccessTokenError();
  }
}

export function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}
