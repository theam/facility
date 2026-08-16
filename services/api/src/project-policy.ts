export type ProjectAutonomyMode = "observe" | "active";

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Existing projects keep their current behaviour; observe-first is explicit. */
export function projectAutonomyMode(settings: unknown): ProjectAutonomyMode {
  return objectOrEmpty(settings).autonomy_mode === "observe" ? "observe" : "active";
}

export function scheduledAutonomyAllowed(settings: unknown) {
  return projectAutonomyMode(settings) === "active";
}

export type GithubFeedbackMode = "silent" | "summary" | "live";

export function githubFeedbackMode(settings: unknown): GithubFeedbackMode {
  const values = objectOrEmpty(settings);
  if (projectAutonomyMode(values) === "active") return "live";
  return values.observe_summary === true ? "summary" : "silent";
}

export function githubFeedbackModeForRun(trigger: unknown): GithubFeedbackMode {
  const value = objectOrEmpty(trigger).githubFeedback;
  return value === "silent" || value === "summary" ? value : "live";
}
