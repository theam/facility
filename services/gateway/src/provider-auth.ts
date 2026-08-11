import type { Provider, ProviderCredential } from "./types.js";

const REQUIRED_CLAUDE_OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];

/** OAuth credentials are intentionally usable only by a run-scoped Claude Code
 * request. A project virtual key or an API-key-shaped client must not turn a
 * human subscription token into a generic Anthropic API credential. */
export function claudeOAuthRequestProblem(
  key: { runId: string | null; engine: string | null },
  incoming: Record<string, unknown>,
): string | null {
  if (!key.runId || key.engine !== "claude_code") {
    return "oauth credential requires a Claude Code run key";
  }
  const authorization = typeof incoming.authorization === "string" ? incoming.authorization : "";
  if (!authorization.startsWith("Bearer fvk_")) {
    return "oauth credential requires bearer virtual-key auth";
  }
  const beta = typeof incoming["anthropic-beta"] === "string" ? incoming["anthropic-beta"] : "";
  const flags = new Set(beta.split(",").map((value) => value.trim()));
  if (REQUIRED_CLAUDE_OAUTH_BETAS.some((required) => !flags.has(required))) {
    return "oauth credential requires Claude Code OAuth beta headers";
  }
  return null;
}

export function providerRequestHeaders(
  provider: Provider,
  incoming: Record<string, unknown>,
  credential: ProviderCredential,
  body: Buffer,
): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("content-length", String(body.length));
  const userAgent = incoming["user-agent"];
  if (typeof userAgent === "string") headers.set("user-agent", userAgent);

  if (provider === "anthropic") {
    if (credential.authMode === "oauth") {
      headers.set("authorization", `Bearer ${credential.secret}`);
    } else {
      headers.set("x-api-key", credential.secret);
    }
    for (const name of [
      "anthropic-version",
      "anthropic-beta",
      "anthropic-dangerous-direct-browser-access",
      "x-app",
    ]) {
      const value = incoming[name];
      if (typeof value === "string") headers.set(name, value);
    }
  } else {
    if (credential.authMode !== "api_key") {
      throw new Error("OpenAI OAuth credentials are unsupported");
    }
    headers.set("authorization", `Bearer ${credential.secret}`);
    const openaiBeta = incoming["openai-beta"];
    if (typeof openaiBeta === "string") headers.set("openai-beta", openaiBeta);
  }
  return headers;
}
