export const CHECKS_NOT_CONFIGURED = "checks_not_configured";
export const DELIVERY_REPO_NOT_CONFIGURED = "delivery_repo_not_configured";

// Extract the machine code from a run's stored error: the runner posts JSON
// fault payloads (possibly followed by stderr tail), and the platform marks
// early failures with the same JSON shape. Anything else is not a coded error.
export function runErrorCode(error: string | null | undefined): string | null {
  if (!error) return null;
  const trimmed = error.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    const end = trimmed.indexOf("}");
    if (end > 1) {
      try {
        const parsed = JSON.parse(trimmed.slice(0, end + 1)) as { code?: unknown };
        if (typeof parsed.code === "string") return parsed.code;
      } catch {
        // Not a JSON error payload — render the raw string below.
      }
    }
  }
  return /^[a-z][a-z0-9_]*$/.test(trimmed) ? trimmed : null;
}

export type RunErrorPresentation = {
  code: string;
  message: string;
  href: string | null;
};

export function runErrorPresentation(
  error: string | null | undefined,
  projectId: string | null,
): RunErrorPresentation | null {
  const code = runErrorCode(error);
  if (code === DELIVERY_REPO_NOT_CONFIGURED) {
    return {
      code,
      message:
        "This builder run has no repository configured, so it cannot create a branch or pull request. Connect a repository in Settings and retry.",
      href: projectId ? `/projects/${projectId}/settings` : null,
    };
  }
  if (code !== CHECKS_NOT_CONFIGURED) return null;
  return {
    code,
    message:
      "No acceptance checks are configured for this project, so the builder run could not deliver.",
    href: projectId ? `/projects/${projectId}/settings` : null,
  };
}
