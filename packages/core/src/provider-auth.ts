export const PROVIDER_AUTH_MODES = ["api_key", "oauth"] as const;

export type ProviderAuthMode = (typeof PROVIDER_AUTH_MODES)[number];

export function isProviderAuthMode(value: unknown): value is ProviderAuthMode {
  return typeof value === "string" && PROVIDER_AUTH_MODES.includes(value as ProviderAuthMode);
}

/**
 * Accept the raw token or the shell assignment printed by `claude setup-token`.
 * Embedded whitespace/control characters are rejected instead of concatenated:
 * a stored bearer value must always remain exactly one HTTP-header value.
 */
export function normalizeClaudeCodeOAuthToken(raw: string): string | null {
  let token = raw.trim();
  for (const prefix of ["export CLAUDE_CODE_OAUTH_TOKEN=", "CLAUDE_CODE_OAUTH_TOKEN="]) {
    if (token.startsWith(prefix)) {
      token = token.slice(prefix.length).trim();
      break;
    }
  }

  const quote = token[0];
  if ((quote === '"' || quote === "'") && token.endsWith(quote)) {
    token = token.slice(1, -1);
  }

  // Setup tokens are long opaque bearer values. Avoid pinning an undocumented
  // prefix while still refusing empty, truncated, multiline, or header-breaking
  // input at the API boundary.
  const hasControlCharacter = Array.from(token).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (token.length < 16 || /\s/.test(token) || hasControlCharacter) return null;
  return token;
}
