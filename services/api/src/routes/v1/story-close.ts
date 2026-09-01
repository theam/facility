import { createHash } from "node:crypto";
import { githubInstallations, repos } from "@facility/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError, notFound } from "../../errors.js";
import {
  createGithubClientFactory,
  FacilityGithubClient,
  type GithubClientFactory,
} from "../../github/client.js";
import { closeStory, reopenStory, type StoryStateMutation } from "../../github/close-story.js";
import type { Principal } from "../../types.js";
import { loadIssue } from "./github.js";
import { assertProjectScope, DateValue, principal, type V1RouteContext } from "./shared.js";

const GithubNumber = z.coerce.number().int().positive().max(2_147_483_647);
const Params = z.object({ projectId: z.string(), number: GithubNumber });
const RepoQuery = z.object({ repoId: z.string().optional() });
const Response = z.object({
  repoId: z.string(),
  number: z.number().int(),
  state: z.enum(["open", "closed"]),
  closedAt: DateValue.nullable(),
  changed: z.boolean(),
});

export async function registerStoryCloseRoutes(app: FastifyInstance, context: V1RouteContext) {
  const { db } = context;

  // Closing a story is a human decision, not an agent proposal: the person
  // pressing the button is the gate the approval machinery exists to provide.
  app.post(
    "/v1/projects/:projectId/stories/:number/close",
    {
      config: { permission: "repos:write", idempotent: true },
      schema: {
        params: Params,
        querystring: RepoQuery,
        body: z.object({
          reason: z.string().trim().min(1).max(4_000),
          // This verb is the abandon path — completed work closes through a
          // merged pull request, where GitHub sets `completed` itself. So the
          // default is what "won't do" means, and it is the value GitHub
          // renders differently. GitHub ignores `state_reason` without a state
          // change, so a close cannot be reissued to correct this later.
          stateReason: z.enum(["completed", "not_planned"]).default("not_planned"),
        }),
        response: { 200: Response },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId, number } = request.params as { projectId: string; number: number };
      const { repoId } = request.query as { repoId?: string };
      const { reason, stateReason } = request.body as {
        reason: string;
        stateReason: "completed" | "not_planned";
      };
      assertProjectScope(p, projectId);
      const target = await loadStoryTarget(app, context, {
        orgId: p.orgId,
        projectId,
        number,
        repoId,
      });
      const result = await closeStory({
        db,
        client: target.client,
        repo: target.repo,
        issueNumber: number,
        reason,
        stateReason,
        actor: actorLabel(p),
        attemptId: attemptId(request),
        appSlug: context.config.githubAppSlug,
      });
      // Only a transition Facility performed is a decision Facility can claim.
      // A no-op against a story someone already closed elsewhere records
      // nothing, so no later reader can read it as the reason for that closure.
      if (result.changed) {
        await request.audit(
          "story.closed",
          { type: "project", id: projectId },
          {
            repoId: target.repo.id,
            number,
            stateReason,
            reason,
            // The display label the timeline reads back; the actor field on the
            // event itself stays the authoritative principal id.
            actor: actorLabel(p),
            // Binds this rationale to the exact closure it explains.
            closedAt: result.closedAt?.toISOString() ?? null,
            commentId: result.commentId,
          },
        );
      }
      return mutationResponse(target.repo.id, number, result);
    },
  );

  app.post(
    "/v1/projects/:projectId/stories/:number/reopen",
    {
      config: { permission: "repos:write", idempotent: true },
      schema: {
        params: Params,
        querystring: RepoQuery,
        response: { 200: Response },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId, number } = request.params as { projectId: string; number: number };
      const { repoId } = request.query as { repoId?: string };
      assertProjectScope(p, projectId);
      const target = await loadStoryTarget(app, context, {
        orgId: p.orgId,
        projectId,
        number,
        repoId,
      });
      const result = await reopenStory({
        db,
        client: target.client,
        repo: target.repo,
        issueNumber: number,
      });
      if (result.changed) {
        await request.audit(
          "story.reopened",
          { type: "project", id: projectId },
          { repoId: target.repo.id, number, actor: actorLabel(p) },
        );
      }
      return mutationResponse(target.repo.id, number, result);
    },
  );
}

function mutationResponse(repoId: string, number: number, result: StoryStateMutation) {
  return {
    repoId,
    number,
    state: result.state,
    closedAt: result.closedAt,
    changed: result.changed,
  };
}

/**
 * Names this close attempt for its own retries. The idempotency key already
 * identifies a retried request, and hashing keeps the caller's key off GitHub.
 * Without one there is nothing to recover against, so no comment is reused.
 */
function attemptId(request: FastifyRequest) {
  const raw = request.headers["idempotency-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  return key ? createHash("sha256").update(key).digest("hex").slice(0, 16) : null;
}

/** GitHub identity is never taken from the request body — only from the principal. */
function actorLabel(p: Principal) {
  if (p.githubLogin) return `@${p.githubLogin}`;
  return p.email ?? p.name ?? "a Facility API key";
}

async function loadStoryTarget(
  app: FastifyInstance,
  context: V1RouteContext,
  input: { orgId: string; projectId: string; number: number; repoId?: string },
) {
  const issue = await loadIssue(
    context.db,
    input.orgId,
    input.projectId,
    input.number,
    input.repoId,
  );
  const repo = (
    await context.db
      .select()
      .from(repos)
      .where(
        and(
          eq(repos.orgId, input.orgId),
          eq(repos.projectId, input.projectId),
          eq(repos.id, issue.repoId),
        ),
      )
      .limit(1)
  )[0];
  if (!repo) throw notFound("Repository not found");
  const installation = repo.installationId
    ? (
        await context.db
          .select()
          .from(githubInstallations)
          .where(
            and(
              eq(githubInstallations.orgId, input.orgId),
              eq(githubInstallations.id, repo.installationId),
            ),
          )
          .limit(1)
      )[0]
    : null;
  if (!installation) {
    throw new ApiError(
      409,
      "github_installation_required",
      "Repository has no active GitHub App installation",
    );
  }
  if (installation.suspendedAt) {
    throw new ApiError(409, "installation_suspended", "GitHub installation is suspended");
  }
  const factory: GithubClientFactory | undefined =
    app.githubClientFactory ??
    (context.config.githubAppId && context.config.githubAppPrivateKey
      ? createGithubClientFactory(context.config)
      : undefined);
  if (!factory) {
    throw new ApiError(503, "github_app_unconfigured", "GitHub App credentials are not configured");
  }
  const client = new FacilityGithubClient(await factory(installation.installationId), {
    owner: repo.owner,
    repo: repo.name,
    defaultBranch: repo.defaultBranch,
  });
  return { repo, client };
}
