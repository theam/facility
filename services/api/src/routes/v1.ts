import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../types.js";
import { registerAdminDoctorRoutes } from "./v1/admin-doctor.js";
import { registerAgentsSandboxesRoutes } from "./v1/agents-sandboxes.js";
import { registerConversationsRoutes } from "./v1/conversations.js";
import { registerGithubV1Routes } from "./v1/github.js";
import { registerHitlRoutes } from "./v1/hitl.js";
import { registerAnalyticsRoutes, registerIssuesAuditRoutes } from "./v1/issues-audit-analytics.js";
import { registerKbTasksRoutes } from "./v1/kb-tasks.js";
import { registerMeMembersRolesRoutes } from "./v1/me-members-roles.js";
import { registerProjectsReposRoutes } from "./v1/projects-repos.js";
import { registerProvidersBudgetsSpendRoutes } from "./v1/providers-budgets-spend.js";
import { registerRegistryRoutes } from "./v1/registry.js";
import { registerRunsRoutes } from "./v1/runs.js";
import { assertProjectInOrg } from "./v1/shared.js";

export async function registerV1Routes(app: FastifyInstance, config: AppConfig) {
  const db = app.facilityDb;
  const context = { db, config };

  app.addHook("preHandler", async (request) => {
    if (!request.principal) return;
    const projectId = (request.params as Record<string, string | undefined>)?.projectId;
    if (projectId) await assertProjectInOrg(db, request.principal, projectId, 404);
  });

  await registerMeMembersRolesRoutes(app, context);
  await registerProjectsReposRoutes(app, context);
  await registerRegistryRoutes(app, context);
  await registerRunsRoutes(app, context);
  await registerConversationsRoutes(app, context);
  await registerGithubV1Routes(app, context);
  await registerProvidersBudgetsSpendRoutes(app, context);
  await registerAnalyticsRoutes(app, context);
  await registerHitlRoutes(app, context);
  await registerIssuesAuditRoutes(app, context);
  await registerKbTasksRoutes(app, context);
  await registerAgentsSandboxesRoutes(app, context);
  await registerAdminDoctorRoutes(app, context);
}
