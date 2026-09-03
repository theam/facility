import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../types.js";
import { registerGithubInstallationRoutes } from "./v1/github-installations.js";
import { registerInsightsPipelineRoutes } from "./v1/insights-pipeline.js";
import { registerMeMembersRolesRoutes } from "./v1/me-members-roles.js";
import { registerProjectRoutes } from "./v1/projects.js";
import { assertProjectInOrg } from "./v1/shared.js";
import { registerStoryWorkspaceRoutes } from "./v1/story-workspaces.js";
import { registerWorkspacePreviewRoutes } from "./v1/workspace-previews.js";

export async function registerV1Routes(app: FastifyInstance, config: AppConfig) {
  const db = app.facilityDb;
  const context = { db, config };

  app.addHook("preHandler", async (request) => {
    if (!request.principal) return;
    const projectId = (request.params as Record<string, string | undefined>)?.projectId;
    if (projectId) await assertProjectInOrg(db, request.principal, projectId, 404);
  });

  await registerMeMembersRolesRoutes(app, context);
  await registerProjectRoutes(app, context);
  await registerGithubInstallationRoutes(app, context);
  await registerInsightsPipelineRoutes(app, context);
  await registerStoryWorkspaceRoutes(app, config);
  await registerWorkspacePreviewRoutes(app, config);
}
