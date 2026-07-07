import { api, type Project, type Run } from "./api";

export { fmtAgo, fmtCost, fmtDuration, fmtStatus } from "./run-format";

export type RunWithProject = Run & { project: Pick<Project, "id" | "name" | "slug"> };

export async function fetchAllRuns(params = ""): Promise<{
  offline: boolean;
  /** Non-offline load failure (e.g. 500/403). Distinct from a genuinely empty result. */
  error: string | null;
  projects: Project[];
  runs: RunWithProject[];
}> {
  const [projects, runs] = await Promise.all([api.projects(), api.allRuns(params)]);
  // A control-plane-unreachable (status 0) failure is offline; any other failure
  // is surfaced as `error` so callers can show a degraded state instead of
  // silently rendering an empty list as if there were zero runs/projects.
  if ((!projects.ok && projects.offline) || (!runs.ok && runs.offline)) {
    return { offline: true, error: null, projects: [], runs: [] };
  }
  const error = !projects.ok ? projects.message : !runs.ok ? runs.message : null;
  return {
    offline: false,
    error,
    projects: projects.ok ? projects.data : [],
    runs: runs.ok ? runs.data : [],
  };
}
