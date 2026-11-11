import { createHash } from "node:crypto";
import { type FacilityDb, projects } from "@facility/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { isSafeGitBranch } from "../workspaces/git-branch.js";

export const DevelopmentBranchSchema = z
  .string()
  .refine(
    (branch) =>
      isSafeGitBranch(branch) &&
      branch !== "@" &&
      !branch.startsWith("refs/") &&
      branch.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock")),
    "Use an existing branch name, without a refs/ prefix",
  );

/** Separate proposal heads prevent a source change from rewriting a PR against the old base. */
export function configurationBranch(
  prefix: string,
  developmentBranch: string,
  defaultBranch: string,
) {
  return developmentBranch === defaultBranch
    ? prefix
    : `${prefix}-${createHash("sha256").update(developmentBranch).digest("hex").slice(0, 12)}`;
}

export function projectDevelopmentBranch(settings: unknown, defaultBranch: string) {
  const branch =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).developmentBranch
      : undefined;
  return branch === undefined || branch === null
    ? defaultBranch
    : DevelopmentBranchSchema.parse(branch);
}

/** The override belongs to the primary repository; related repositories retain their defaults. */
export async function repositoryDevelopmentBranch(
  db: FacilityDb,
  repository: { orgId: string; projectId: string; defaultBranch: string; role?: string },
) {
  if (repository.role === "related") return repository.defaultBranch;
  const project = (
    await db
      .select({ settings: projects.settings })
      .from(projects)
      .where(and(eq(projects.orgId, repository.orgId), eq(projects.id, repository.projectId)))
      .limit(1)
  )[0];
  if (!project) throw new Error("Project not found");
  return projectDevelopmentBranch(project.settings, repository.defaultBranch);
}
