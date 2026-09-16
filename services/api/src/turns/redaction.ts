/** Redact string content without treating JSON numbers or booleans as secret text. */
export function redactEvent(value: unknown, secrets: string[]): Record<string, unknown> {
  function visit(input: unknown): unknown {
    if (typeof input === "string") return redactString(input, secrets);
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input).map(([key, item]) => [redactString(key, secrets), visit(item)]),
      );
    return input;
  }
  return visit(value) as Record<string, unknown>;
}

export function redactString(value: string, secrets: string[]) {
  return secrets
    .filter(Boolean)
    .reduce((current, secret) => current.replaceAll(secret, "[REDACTED]"), value);
}
