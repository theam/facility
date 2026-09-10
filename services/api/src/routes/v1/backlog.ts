import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PHASE_REASONS, WORK_PHASES } from "../../stories/phase.js";
import { DateValue, principal, type V1RouteContext } from "./shared.js";

const ProjectParams = z.object({ projectId: z.string() });
const list = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.flatMap((entry) => String(entry).split(","))
        : typeof value === "string"
          ? value.split(",")
          : value,
    z.array(item).max(50).optional(),
  );
const Phase = z.enum(WORK_PHASES);
const BacklogQuery = z.object({
  q: z.string().trim().max(200).optional(),
  phase: list(z.enum([...WORK_PHASES, "open", "all"])),
  label: list(z.string().trim().min(1).max(160)),
  assignee: list(z.string().trim().min(1).max(200)),
  repository: list(z.string().trim().min(1).max(200)),
  sort: z.enum(["priority", "updated", "created"]).default("priority"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const Person = z.object({
  key: z.string(),
  login: z.string().nullable(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  sources: z.array(z.enum(["github", "facility"])),
});
const PullRequest = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  repository: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  ciState: z.enum(["pending", "success", "failure"]).nullable(),
  ciFailureNames: z.array(z.string()),
  reviewState: z.enum(["approved", "changes_requested", "commented"]).nullable(),
  headRef: z.string(),
  author: z.string().nullable(),
  updatedAt: DateValue,
});
const BacklogItem = z.object({
  key: z.string(),
  kind: z.enum(["story", "issue", "pull_request"]),
  title: z.string(),
  titleSource: z.string(),
  phase: Phase,
  reason: z.enum(PHASE_REASONS),
  activity: z.object({
    state: z.enum(["running", "queued", "idle"]),
    agentName: z.string().nullable(),
    engine: z.string().nullable(),
    turnId: z.string().nullable(),
    since: DateValue.nullable(),
  }),
  environment: z.object({
    recordedState: z.string().nullable(),
    lastActivityAt: DateValue.nullable(),
  }),
  attention: z.array(
    z.object({
      id: z.string().nullable(),
      source: z.enum(["facility", "github"]),
      kind: z.string(),
      title: z.string(),
      turnId: z.string().nullable(),
      createdAt: DateValue.nullable(),
    }),
  ),
  story: z
    .object({
      id: z.string(),
      status: z.string(),
      provider: z.string(),
      externalId: z.string(),
      branch: z.string().nullable(),
      activeAgentName: z.string().nullable(),
      createdAt: DateValue,
      updatedAt: DateValue,
    })
    .nullable(),
  issue: z
    .object({
      repository: z.string(),
      repositoryId: z.string(),
      number: z.number(),
      url: z.string(),
      state: z.enum(["open", "closed"]),
      labels: z.array(z.string()),
      author: z.string().nullable(),
      createdAt: DateValue.nullable(),
      updatedAt: DateValue,
      closedAt: DateValue.nullable(),
      syncedAt: DateValue,
      stale: z.boolean(),
    })
    .nullable(),
  pullRequest: PullRequest.nullable(),
  labels: z.array(z.string()),
  assignees: z.array(Person),
  createdAt: DateValue,
  lastActivityAt: DateValue,
});
export const BacklogResponse = z.object({
  generatedAt: DateValue,
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  counts: z.object(
    Object.fromEntries(WORK_PHASES.map((phase) => [phase, z.number()])) as Record<
      (typeof WORK_PHASES)[number],
      z.ZodNumber
    >,
  ),
  items: z.array(BacklogItem),
  facets: z.object({
    labels: z.array(z.object({ name: z.string(), count: z.number() })),
    assignees: z.array(Person.extend({ count: z.number() })),
    unassigned: z.number(),
    repositories: z.array(z.object({ id: z.string(), name: z.string(), count: z.number() })),
  }),
});

export async function registerBacklogRoutes(app: FastifyInstance, _context: V1RouteContext) {
  app.get(
    "/v1/projects/:projectId/backlog",
    {
      config: { permission: "projects:read" },
      schema: {
        params: ProjectParams,
        querystring: BacklogQuery,
        response: { 200: BacklogResponse },
        operationId: "listProjectBacklog",
      },
    },
    async (request, reply) => {
      const actor = principal(request);
      const { projectId } = request.params as z.infer<typeof ProjectParams>;
      const query = request.query as z.infer<typeof BacklogQuery>;
      reply.header("cache-control", "no-store");
      // Reading the backlog is a pure control-plane read: no provider inspection,
      // no workspace wake, no turn.
      return app.storyDomain.backlog.list(
        actor.orgId,
        projectId,
        {
          q: query.q,
          phase: query.phase,
          label: query.label,
          assignee: query.assignee,
          repository: query.repository,
          sort: query.sort,
          limit: query.limit,
          offset: query.offset,
        },
        {
          userId: actor.userId ?? (actor.type === "user" ? actor.id : undefined),
          githubLogin: actor.githubLogin,
        },
      );
    },
  );
}
