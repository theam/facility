import { githubInstallations } from "@facility/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound } from "../../errors.js";
import { createGithubClientFactory } from "../../github/client.js";
import { DateValue, principal, type V1RouteContext } from "./shared.js";

const InstallationSchema = z.object({
  id: z.string(),
  installationId: z.number(),
  accountLogin: z.string(),
  targetType: z.string(),
  suspendedAt: DateValue.nullable(),
});

const InstallationRepoSchema = z.object({
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  htmlUrl: z.string(),
});

type InstallationRepo = {
  name?: string;
  full_name?: string;
  private?: boolean;
  default_branch?: string;
  html_url?: string;
  owner?: { login?: string };
};

export async function registerGithubInstallationRoutes(
  app: FastifyInstance,
  context: V1RouteContext,
) {
  const { db, config } = context;

  app.get(
    "/v1/github/installations",
    {
      config: { permission: "projects:kickstart" },
      schema: { response: { 200: z.array(InstallationSchema) } },
    },
    async (request) => {
      const actor = principal(request);
      requireOrgPrincipal(actor);
      return db
        .select({
          id: githubInstallations.id,
          installationId: githubInstallations.installationId,
          accountLogin: githubInstallations.accountLogin,
          targetType: githubInstallations.targetType,
          suspendedAt: githubInstallations.suspendedAt,
        })
        .from(githubInstallations)
        .where(eq(githubInstallations.orgId, actor.orgId));
    },
  );

  app.get(
    "/v1/github/installations/:installationId/repos",
    {
      config: { permission: "projects:kickstart" },
      schema: {
        params: z.object({ installationId: z.coerce.number().int() }),
        querystring: z.object({ query: z.string().optional() }),
        response: {
          200: z.object({ items: z.array(InstallationRepoSchema), truncated: z.boolean() }),
        },
      },
    },
    async (request) => {
      const actor = principal(request);
      requireOrgPrincipal(actor);
      const { installationId } = request.params as { installationId: number };
      const { query } = request.query as { query?: string };
      const installation = (
        await db
          .select()
          .from(githubInstallations)
          .where(
            and(
              eq(githubInstallations.orgId, actor.orgId),
              eq(githubInstallations.installationId, installationId),
            ),
          )
          .limit(1)
      )[0];
      if (!installation) throw notFound("GitHub installation not found");
      if (installation.suspendedAt) {
        throw new ApiError(409, "installation_suspended", "GitHub installation is suspended");
      }
      const factory = app.githubClientFactory ?? createGithubClientFactory(config);
      const octokit = await factory(installation.installationId);
      if (!octokit.request) {
        throw new ApiError(500, "github_request_unavailable", "GitHub request API unavailable");
      }
      const repositories: InstallationRepo[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const response = await octokit.request("GET /installation/repositories", {
          per_page: 100,
          page,
        });
        const pageRepositories = Array.isArray(response.data.repositories)
          ? (response.data.repositories as InstallationRepo[])
          : [];
        repositories.push(...pageRepositories);
        if (pageRepositories.length < 100) break;
      }
      const needle = query?.trim().toLowerCase();
      const items = repositories
        .filter((repository) => !needle || repository.full_name?.toLowerCase().includes(needle))
        .map((repository) => {
          const [owner, name] = String(repository.full_name ?? "/").split("/", 2);
          return {
            owner: repository.owner?.login ?? owner ?? "",
            name: repository.name ?? name ?? "",
            fullName:
              repository.full_name ??
              `${repository.owner?.login ?? owner}/${repository.name ?? name}`,
            private: Boolean(repository.private),
            defaultBranch: repository.default_branch ?? "main",
            htmlUrl: repository.html_url ?? "",
          };
        })
        .filter((repository) => repository.owner && repository.name);
      return { items, truncated: repositories.length >= 300 };
    },
  );
}

function requireOrgPrincipal(actor: { projectId?: string | null }) {
  if (actor.projectId) throw notFound("Not found");
}
