import { type FacilityDb, projects, workspaces } from "@facility/db";
import { and, eq } from "drizzle-orm";

/** Missing, legacy or malformed settings never opt a project in. */
export function projectNativePreviewsEnabled(settings: unknown) {
  return (
    !!settings &&
    typeof settings === "object" &&
    "nativePreviewsEnabled" in settings &&
    settings.nativePreviewsEnabled === true
  );
}

export async function nativePreviewsEnabledForProject(
  db: FacilityDb,
  scope: { orgId: string; projectId: string },
) {
  const [project] = await db
    .select({ settings: projects.settings })
    .from(projects)
    .where(and(eq(projects.orgId, scope.orgId), eq(projects.id, scope.projectId)))
    .limit(1);
  return !!project && projectNativePreviewsEnabled(project.settings);
}

/** Resolve ownership from persisted rows, never from agent-controlled environment variables. */
export async function nativePreviewsEnabledForWorkspace(db: FacilityDb, workspaceId: string) {
  const [project] = await db
    .select({ settings: projects.settings })
    .from(workspaces)
    .innerJoin(
      projects,
      and(eq(projects.id, workspaces.projectId), eq(projects.orgId, workspaces.orgId)),
    )
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return !!project && projectNativePreviewsEnabled(project.settings);
}
