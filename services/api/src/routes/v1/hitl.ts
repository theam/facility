import { can, newId } from "@facility/core";
import {
  actionTypes,
  platformIssues,
  projects,
  proposalEvents,
  proposals,
  runs,
} from "@facility/db";
import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound } from "../../errors.js";
import { executeApprovedProposal, resolveMcpToolTargetProject } from "../../executors.js";
import { MCP_TOOL_PERMISSIONS } from "../../mcp-policy.js";
import type { Principal } from "../../types.js";
import { ACTIONABLE_SEVERITIES } from "../../watchtower/issues.js";
import {
  AnyObject,
  assertBareRowProjectScope,
  IdParams,
  IsoDateTime,
  PageQuery,
  type PageQueryValue,
  PlatformIssueSchema,
  ProposalEventSchema,
  ProposalSchema,
  principal,
  proposalOpener,
  assertProjectInOrg as sharedAssertProjectInOrg,
  type V1RouteContext,
} from "./shared.js";

export async function registerHitlRoutes(app: FastifyInstance, context: V1RouteContext) {
  const { db, config } = context;
  const assertProjectInOrg = (
    p: Principal,
    projectId: string | null | undefined,
    statusCode?: number,
  ) => sharedAssertProjectInOrg(db, p, projectId, statusCode);

  const ActionTypeSchema = z.object({
    id: z.string(),
    orgId: z.string(),
    name: z.string(),
    payloadSchema: AnyObject,
    resolver: AnyObject,
    executor: AnyObject,
    defaultTtlHours: z.number().int(),
    createdAt: z.date(),
    updatedAt: z.date(),
  });

  app.get(
    "/v1/action-types",
    {
      config: { permission: "hitl:read" },
      schema: { querystring: PageQuery, response: { 200: z.array(ActionTypeSchema) } },
    },
    async (request) => {
      const p = principal(request);
      const query = request.query as PageQueryValue;
      return db
        .select()
        .from(actionTypes)
        .where(eq(actionTypes.orgId, p.orgId))
        .orderBy(asc(actionTypes.name), asc(actionTypes.id))
        .limit(query.limit)
        .offset(query.offset);
    },
  );

  app.get(
    "/v1/action-types/:actionTypeId",
    {
      config: { permission: "hitl:read" },
      schema: {
        params: z.object({ actionTypeId: z.string() }),
        response: { 200: ActionTypeSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const actionTypeId = (request.params as { actionTypeId: string }).actionTypeId;
      const row = (
        await db
          .select()
          .from(actionTypes)
          .where(and(eq(actionTypes.orgId, p.orgId), eq(actionTypes.id, actionTypeId)))
          .limit(1)
      )[0];
      if (!row) throw notFound("Action type not found");
      return row;
    },
  );
  app.get(
    "/v1/inbox",
    {
      config: { permission: "hitl:read" },
      schema: {
        querystring: PageQuery.extend({ state: z.string().optional() }),
        response: {
          200: z.object({
            items: z.array(ProposalSchema),
            proposals: z.array(ProposalSchema),
            issues: z.array(PlatformIssueSchema),
          }),
        },
      },
    },
    async (request) => {
      const p = principal(request);
      const query = request.query as PageQueryValue & { state?: string };
      const state = query.state;
      const proposalClauses = [eq(proposals.orgId, p.orgId)];
      if (state) proposalClauses.push(eq(proposals.state, state));
      if (p.projectId) proposalClauses.push(eq(proposals.projectId, p.projectId));
      const proposalRows = await db
        .select({ proposal: proposals, actionType: actionTypes.name })
        .from(proposals)
        .innerJoin(actionTypes, eq(actionTypes.id, proposals.actionTypeId))
        .where(and(...proposalClauses))
        .orderBy(desc(proposals.createdAt), desc(proposals.id))
        .limit(query.limit)
        .offset(query.offset);
      const failedProposalIds = proposalRows
        .filter(({ proposal }) => proposal.state === "execution_failed")
        .map(({ proposal }) => proposal.id);
      const failureEvents = failedProposalIds.length
        ? await db
            .select()
            .from(proposalEvents)
            .where(
              and(
                eq(proposalEvents.orgId, p.orgId),
                eq(proposalEvents.type, "execution_failed"),
                inArray(proposalEvents.proposalId, failedProposalIds),
              ),
            )
            .orderBy(desc(proposalEvents.seq))
        : [];
      const executionErrors = new Map<string, string | null>();
      for (const event of failureEvents) {
        if (!executionErrors.has(event.proposalId)) {
          executionErrors.set(event.proposalId, executionErrorFromEvents([event]));
        }
      }
      const proposalResponses = proposalRows.map(({ proposal, actionType }) => ({
        ...proposal,
        actionType,
        executionError: executionErrors.get(proposal.id) ?? null,
      }));
      // Issues are watchtower alerts, not proposals: the `state` query param
      // scopes proposals only. Always surface actionable (error/critical) issues
      // that are still open OR acked, so acknowledging one keeps it visible
      // until it is actually resolved.
      const issueClauses = [
        eq(platformIssues.orgId, p.orgId),
        inArray(platformIssues.severity, ACTIONABLE_SEVERITIES),
        or(eq(platformIssues.state, "open"), eq(platformIssues.state, "acked")),
      ];
      if (p.projectId) issueClauses.push(eq(platformIssues.projectId, p.projectId));
      const issueRows = await db
        .select()
        .from(platformIssues)
        .where(and(...issueClauses))
        .orderBy(desc(platformIssues.lastSeen), desc(platformIssues.id))
        .limit(query.limit)
        .offset(query.offset);
      return {
        items: proposalResponses,
        proposals: proposalResponses,
        issues: issueRows,
      };
    },
  );

  app.get(
    "/v1/proposals/:proposalId",
    {
      config: { permission: "hitl:read" },
      schema: {
        params: IdParams,
        response: { 200: ProposalSchema.extend({ events: z.array(ProposalEventSchema) }) },
      },
    },
    async (request) => {
      const p = principal(request);
      const { proposalId } = request.params as { proposalId: string };
      const proposalRow = (
        await db
          .select({ proposal: proposals, actionType: actionTypes.name })
          .from(proposals)
          .innerJoin(actionTypes, eq(actionTypes.id, proposals.actionTypeId))
          .where(and(eq(proposals.orgId, p.orgId), eq(proposals.id, proposalId)))
          .limit(1)
      )[0];
      if (!proposalRow) throw notFound("Proposal not found");
      const proposal = { ...proposalRow.proposal, actionType: proposalRow.actionType };
      assertBareRowProjectScope(p, proposal.projectId, "Proposal not found");
      const events = await db
        .select()
        .from(proposalEvents)
        .where(and(eq(proposalEvents.orgId, p.orgId), eq(proposalEvents.proposalId, proposalId)))
        .orderBy(asc(proposalEvents.seq));
      return { ...proposal, executionError: executionErrorFromEvents(events), events };
    },
  );

  app.post(
    "/v1/mcp/tool-proposals",
    {
      config: { permission: "org:read", auditAction: "hitl.proposed", idempotent: true },
      schema: {
        body: z.object({
          toolName: z.string().min(1),
          permission: z.string().min(1),
          args: AnyObject,
          summary: z.string().min(1),
          projectId: z.string().optional(),
          runId: z.string().optional(),
        }),
        response: { 200: ProposalSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const body = request.body as {
        toolName: string;
        permission: string;
        args: Record<string, unknown>;
        summary: string;
        projectId?: string;
        runId?: string;
      };
      const expectedPermission = MCP_TOOL_PERMISSIONS[body.toolName];
      if (!expectedPermission) {
        throw new ApiError(400, "mcp_tool_not_allowed", "MCP tool is not approval-gated");
      }
      if (body.permission !== expectedPermission) {
        throw new ApiError(
          400,
          "mcp_permission_mismatch",
          "MCP tool permission does not match the server allowlist",
        );
      }
      if (!can(p.permissions, body.permission)) {
        throw new ApiError(403, "forbidden", "Permission denied", { needed: body.permission });
      }
      if (can(p.permissions, "hitl:decide")) {
        throw new ApiError(
          403,
          "mcp_key_can_decide",
          "MCP write keys must not carry hitl:decide; approval must come from a separate human principal",
        );
      }
      await assertProjectInOrg(p, body.projectId);
      const targetProjectId = await resolveMcpToolTargetProject(
        db,
        p.orgId,
        body.toolName,
        body.args,
      );
      if (body.projectId && targetProjectId !== null && targetProjectId !== body.projectId) {
        throw new ApiError(
          400,
          "mcp_target_project_mismatch",
          "MCP tool target does not match the proposal project",
        );
      }
      if (p.projectId && targetProjectId !== p.projectId) {
        throw new ApiError(404, "not_found", "Project not found");
      }
      await assertProjectInOrg(p, targetProjectId, 404);
      const runProjectId = await proposalRunProject(p, body.runId);
      const requestedProjectId = targetProjectId ?? body.projectId ?? p.projectId ?? null;
      if (runProjectId && requestedProjectId && runProjectId !== requestedProjectId) {
        throw new ApiError(
          400,
          "proposal_run_project_mismatch",
          "Proposal run does not belong to the proposal project",
        );
      }
      const actionType = await ensureMcpActionType(p.orgId);
      if (!actionType) throw new ApiError(500, "insert_failed", "Could not create MCP action type");
      const projectId = requestedProjectId ?? runProjectId;
      const proposal = (
        await db
          .insert(proposals)
          .values({
            id: newId("prop"),
            orgId: p.orgId,
            projectId,
            runId: body.runId,
            actionTypeId: actionType.id,
            payload: {
              toolName: body.toolName,
              permission: body.permission,
              args: body.args,
              targetProjectId,
              target: { projectId: targetProjectId },
              requestedBy: { type: p.type, id: p.id },
            },
            contextMd: [
              `MCP write request: ${body.summary}`,
              "",
              `Tool: ${body.toolName}`,
              `Requested by: ${p.type}:${p.id}`,
              "",
              "Approval requires hitl:decide and must be made by a different principal.",
            ].join("\n"),
            expiresAt: new Date(Date.now() + actionType.defaultTtlHours * 3600_000),
          })
          .returning()
      )[0];
      if (proposal) {
        // payload.requestedBy stays the HUMAN principal — the executor
        // re-verifies that identity's permission; only the opener actor (the
        // dual-control comparison) may become the agent.
        const opener = await proposalOpener(db, request, p);
        await db.insert(proposalEvents).values({
          orgId: p.orgId,
          proposalId: proposal.id,
          seq: 1,
          type: "open",
          actor: opener.actor,
          data: {
            source: "mcp",
            toolName: body.toolName,
            permission: body.permission,
            ...opener.data,
          },
        });
      }
      if (!proposal) throw new ApiError(500, "insert_failed", "Could not create proposal");
      return { ...proposal, actionType: actionType.name };
    },
  );

  app.post(
    "/v1/proposals",
    {
      config: { permission: "hitl:write", auditAction: "hitl.proposed", idempotent: true },
      schema: {
        body: z.object({
          projectId: z.string().optional(),
          runId: z.string().optional(),
          actionTypeId: z.string().optional(),
          /** Action-type NAME, resolved server-side — what in-process agents use. */
          actionType: z.string().optional(),
          payload: AnyObject,
          contextMd: z.string(),
          expiresAt: IsoDateTime.optional(),
        }),
        response: { 200: ProposalSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const body = request.body as {
        projectId?: string;
        runId?: string;
        actionTypeId?: string;
        actionType?: string;
        payload: Record<string, unknown>;
        contextMd: string;
        expiresAt?: string;
      };
      if (!body.actionTypeId && !body.actionType) {
        throw new ApiError(400, "schema_validation_failed", "actionTypeId or actionType required");
      }
      await assertProjectInOrg(p, body.projectId);
      const runProjectId = await proposalRunProject(p, body.runId);
      const requestedProjectId = p.projectId ?? body.projectId ?? null;
      if (runProjectId && requestedProjectId && runProjectId !== requestedProjectId) {
        throw new ApiError(
          400,
          "proposal_run_project_mismatch",
          "Proposal run does not belong to the proposal project",
        );
      }
      const projectId = requestedProjectId ?? runProjectId;
      let actionType = (
        await db
          .select()
          .from(actionTypes)
          .where(
            and(
              eq(actionTypes.orgId, p.orgId),
              body.actionTypeId
                ? eq(actionTypes.id, body.actionTypeId)
                : eq(actionTypes.name, body.actionType ?? ""),
            ),
          )
          .limit(1)
      )[0];
      // Orgs seeded before the type existed get it lazily, like mcp_tool_call.
      if (!actionType && body.actionType === "issue_update") {
        actionType = await ensureIssueUpdateActionType(p.orgId);
      }
      if (!actionType) throw notFound("Action type not found");
      if (actionType.name === "plan_acceptance") {
        throw new ApiError(
          403,
          "reserved_action_type",
          "plan_acceptance proposals are created only from a completed Facility Architect run",
        );
      }
      // mcp_tool_call dispatches to privileged operations (create agent, set
      // budget, publish registry version, …) whose per-tool permission is checked
      // ONLY on the dedicated /v1/mcp/tool-proposals route. The generic route
      // gates on hitl:write alone, so allowing an mcp_tool_call proposal here
      // would let a hitl:write principal propose (and a hitl:decide approver
      // execute) an operation it lacks the permission for. Reserve it.
      if (actionType.name === "mcp_tool_call") {
        throw new ApiError(
          403,
          "forbidden",
          "mcp_tool_call proposals must go through POST /v1/mcp/tool-proposals (per-tool permission check)",
        );
      }
      const required = Array.isArray((actionType.payloadSchema as { required?: unknown }).required)
        ? (actionType.payloadSchema as { required: string[] }).required
        : [];
      for (const key of required)
        if (!(key in body.payload))
          throw new ApiError(400, "schema_validation_failed", `Missing payload field: ${key}`);
      const proposal = (
        await db
          .insert(proposals)
          .values({
            id: newId("prop"),
            orgId: p.orgId,
            projectId,
            runId: body.runId,
            actionTypeId: actionType.id,
            payload: body.payload,
            contextMd: body.contextMd,
            expiresAt: body.expiresAt
              ? new Date(body.expiresAt)
              : new Date(Date.now() + actionType.defaultTtlHours * 3600_000),
          })
          .returning()
      )[0];
      if (proposal) {
        const opener = await proposalOpener(db, request, p);
        await db.insert(proposalEvents).values({
          orgId: p.orgId,
          proposalId: proposal.id,
          seq: 1,
          type: "open",
          actor: opener.actor,
          data: opener.data,
        });
      }
      if (!proposal) throw new ApiError(500, "insert_failed", "Could not create proposal");
      return { ...proposal, actionType: actionType.name };
    },
  );

  app.post(
    "/v1/proposals/:proposalId/decide",
    {
      config: { permission: "hitl:decide", auditAction: "hitl.decided" },
      schema: {
        params: IdParams,
        body: z.object({ decision: z.enum(["approve", "reject"]), note: z.string().optional() }),
        response: { 200: ProposalSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { proposalId } = request.params as { proposalId: string };
      const body = request.body as { decision: "approve" | "reject"; note?: string };
      const state = body.decision === "approve" ? "approved" : "rejected";
      const row = await db.transaction(async (tx) => {
        const proposal = (
          await tx
            .select({ proposal: proposals, actionType: actionTypes })
            .from(proposals)
            .innerJoin(actionTypes, eq(actionTypes.id, proposals.actionTypeId))
            .where(and(eq(proposals.orgId, p.orgId), eq(proposals.id, proposalId)))
            .limit(1)
        )[0];
        if (!proposal) throw new ApiError(409, "not_open", "Proposal is not open");
        if (
          body.decision === "approve" &&
          proposal.actionType.name === "plan_acceptance" &&
          proposal.proposal.projectId &&
          p.type !== "user"
        ) {
          const project = (
            await tx
              .select({ builderPlanPolicy: projects.builderPlanPolicy })
              .from(projects)
              .where(and(eq(projects.orgId, p.orgId), eq(projects.id, proposal.proposal.projectId)))
              .limit(1)
          )[0];
          if (project?.builderPlanPolicy === "required") {
            throw new ApiError(
              403,
              "builder_plan_approval_principal_required",
              "Required Builder plans must be approved by a human user principal",
            );
          }
        }
        const opener = (
          await tx
            .select()
            .from(proposalEvents)
            .where(
              and(
                eq(proposalEvents.orgId, p.orgId),
                eq(proposalEvents.proposalId, proposalId),
                eq(proposalEvents.seq, 1),
              ),
            )
            .limit(1)
        )[0];
        if (sameActor(opener?.actor, { type: p.type, id: p.id })) {
          throw new ApiError(
            403,
            "same_principal_approval_denied",
            "Proposals must be approved by a different principal than the requester",
          );
        }
        const updated = (
          await tx
            .update(proposals)
            .set({ state, decidedBy: p.id, decidedAt: new Date() })
            .where(
              and(
                eq(proposals.orgId, p.orgId),
                eq(proposals.id, proposalId),
                eq(proposals.state, "open"),
                or(isNull(proposals.expiresAt), gt(proposals.expiresAt, new Date())),
              ),
            )
            .returning()
        )[0];
        if (!updated) throw new ApiError(409, "not_open", "Proposal is not open");
        assertBareRowProjectScope(p, updated.projectId, "Proposal not found");
        const current = await tx
          .select()
          .from(proposalEvents)
          .where(and(eq(proposalEvents.orgId, p.orgId), eq(proposalEvents.proposalId, proposalId)))
          .orderBy(desc(proposalEvents.seq))
          .limit(1);
        await tx.insert(proposalEvents).values({
          orgId: p.orgId,
          proposalId,
          seq: (current[0]?.seq ?? 0) + 1,
          type: state,
          actor: { type: p.type, id: p.id },
          data: { note: body.note },
        });
        return updated;
      });
      if (row && state === "approved") {
        await executeApprovedProposal(
          db,
          row,
          { type: p.type, id: p.id },
          { config, enqueue: app.enqueue, githubFactory: app.githubClientFactory },
        );
        const executed = (
          await db
            .select()
            .from(proposals)
            .where(and(eq(proposals.orgId, p.orgId), eq(proposals.id, proposalId)))
            .limit(1)
        )[0];
        if (!executed) throw notFound("Proposal not found");
        return proposalResponse(executed);
      }
      return proposalResponse(row);
    },
  );

  app.post(
    "/v1/proposals/:proposalId/execute",
    {
      config: { permission: "hitl:decide", auditAction: "hitl.executed" },
      schema: { params: IdParams, response: { 200: ProposalSchema } },
    },
    async (request) => {
      const p = principal(request);
      const { proposalId } = request.params as { proposalId: string };
      const proposal = (
        await db
          .select()
          .from(proposals)
          .where(and(eq(proposals.orgId, p.orgId), eq(proposals.id, proposalId)))
          .limit(1)
      )[0];
      if (!proposal) throw notFound("Proposal not found");
      assertBareRowProjectScope(p, proposal.projectId, "Proposal not found");
      if (
        proposal.state !== "execution_failed" &&
        proposal.state !== "approved" &&
        proposal.state !== "executing"
      ) {
        throw new ApiError(409, "not_executable", "Proposal is not pending execution");
      }
      const claimed = await executeApprovedProposal(
        db,
        proposal,
        { type: p.type, id: p.id },
        {
          config,
          enqueue: app.enqueue,
          githubFactory: app.githubClientFactory,
        },
      );
      if (!claimed) {
        throw new ApiError(
          409,
          "execution_in_progress",
          "Proposal execution is already in progress",
        );
      }
      const executed = (
        await db
          .select()
          .from(proposals)
          .where(and(eq(proposals.orgId, p.orgId), eq(proposals.id, proposalId)))
          .limit(1)
      )[0];
      if (!executed) throw notFound("Proposal not found");
      return proposalResponse(executed);
    },
  );

  async function ensureIssueUpdateActionType(orgId: string) {
    const spec = {
      payloadSchema: { type: "object", required: ["issueNumber", "title", "bodyMd"] },
      resolver: { type: "permission", config: { permission: "hitl:decide" } },
      executor: { type: "internal", config: {} },
      defaultTtlHours: 72,
    };
    const existing = (
      await db
        .select()
        .from(actionTypes)
        .where(and(eq(actionTypes.orgId, orgId), eq(actionTypes.name, "issue_update")))
        .limit(1)
    )[0];
    if (existing) return existing;
    return (
      await db
        .insert(actionTypes)
        .values({ id: `act_${orgId}_issue_update`, orgId, name: "issue_update", ...spec })
        .onConflictDoUpdate({
          target: [actionTypes.orgId, actionTypes.name],
          set: { ...spec, updatedAt: new Date() },
        })
        .returning()
    )[0];
  }

  async function ensureMcpActionType(orgId: string) {
    const existing = (
      await db
        .select()
        .from(actionTypes)
        .where(and(eq(actionTypes.orgId, orgId), eq(actionTypes.name, "mcp_tool_call")))
        .limit(1)
    )[0];
    if (existing) return existing;
    return (
      await db
        .insert(actionTypes)
        .values({
          id: `act_${orgId}_mcp_tool_call`,
          orgId,
          name: "mcp_tool_call",
          payloadSchema: { type: "object", required: ["toolName", "args", "requestedBy"] },
          resolver: { type: "permission", config: { permission: "hitl:decide" } },
          executor: { type: "mcp", config: {} },
          defaultTtlHours: 72,
        })
        .onConflictDoUpdate({
          target: [actionTypes.orgId, actionTypes.name],
          set: {
            payloadSchema: { type: "object", required: ["toolName", "args", "requestedBy"] },
            resolver: { type: "permission", config: { permission: "hitl:decide" } },
            executor: { type: "mcp", config: {} },
            defaultTtlHours: 72,
            updatedAt: new Date(),
          },
        })
        .returning()
    )[0];
  }

  async function proposalResponse(proposal: typeof proposals.$inferSelect) {
    const actionType = (
      await db
        .select({ name: actionTypes.name })
        .from(actionTypes)
        .where(
          and(eq(actionTypes.orgId, proposal.orgId), eq(actionTypes.id, proposal.actionTypeId)),
        )
        .limit(1)
    )[0];
    if (!actionType) {
      throw new ApiError(500, "invalid_proposal", "Proposal action type is missing");
    }
    return {
      ...proposal,
      actionType: actionType.name,
      executionError: await proposalExecutionError(proposal),
    };
  }

  async function proposalExecutionError(proposal: typeof proposals.$inferSelect) {
    if (proposal.state !== "execution_failed") return null;
    const events = await db
      .select()
      .from(proposalEvents)
      .where(
        and(
          eq(proposalEvents.orgId, proposal.orgId),
          eq(proposalEvents.proposalId, proposal.id),
          eq(proposalEvents.type, "execution_failed"),
        ),
      )
      .orderBy(desc(proposalEvents.seq))
      .limit(1);
    return executionErrorFromEvents(events);
  }

  async function proposalRunProject(p: Principal, runId: string | undefined) {
    if (!runId) return null;
    const run = (
      await db
        .select({ projectId: runs.projectId })
        .from(runs)
        .where(and(eq(runs.orgId, p.orgId), eq(runs.id, runId)))
        .limit(1)
    )[0];
    if (!run || (p.projectId && run.projectId !== p.projectId)) throw notFound("Run not found");
    return run.projectId;
  }
}

function executionErrorFromEvents(events: Array<typeof proposalEvents.$inferSelect>) {
  const failed = [...events].reverse().find((event) => event.type === "execution_failed");
  const data = failed?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const error = (data as { error?: unknown }).error;
  if (typeof error !== "string") return null;
  return /^[a-z0-9_:-]{1,160}$/i.test(error) ? error : "execution_failed";
}

function sameActor(left: unknown, right: { type: string; id: string }) {
  return (
    typeof left === "object" &&
    left !== null &&
    (left as { type?: unknown }).type === right.type &&
    (left as { id?: unknown }).id === right.id
  );
}
