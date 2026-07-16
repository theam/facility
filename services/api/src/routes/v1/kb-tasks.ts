import { newId, verifyKey } from "@facility/core";
import {
  actionTypes,
  kbEntries,
  kbLinks,
  kbSpaces,
  poTasks,
  projects,
  proposalEvents,
  proposals,
  repos,
  runs,
} from "@facility/db";
import { artifactIdFor, validate } from "@facility/harness";
import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound } from "../../errors.js";
import {
  ensureActive,
  ensureLinks,
  loadKbGraph,
  normalizeKbDraft,
  toHarnessEntry,
  toHarnessSpace,
  validateProjectKb,
} from "../../harness.js";
import { readSandbox } from "../../sandbox/state.js";
import type { Principal } from "../../types.js";
import {
  AnyObject,
  assertBareRowProjectScope,
  assertProjectScope,
  bearer,
  definedFields,
  IdParams,
  KbEntryDraftSchema,
  KbEntrySchema,
  KbSpaceSchema,
  Ok,
  objectOrEmpty,
  PageQuery,
  type PageQueryValue,
  ProposalSchema,
  principal,
  TaskSchema,
  type V1RouteContext,
  ValidationReportSchema,
} from "./shared.js";

export async function registerKbTasksRoutes(app: FastifyInstance, context: V1RouteContext) {
  const { db } = context;
  app.get(
    "/v1/projects/:projectId/kb/space",
    {
      config: { permission: "kb:read" },
      schema: { params: IdParams, response: { 200: KbSpaceSchema.nullable() } },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const space = (
        await db
          .select()
          .from(kbSpaces)
          .where(and(eq(kbSpaces.orgId, p.orgId), eq(kbSpaces.projectId, projectId)))
          .limit(1)
      )[0];
      // A project without a KB yet is an empty space, not a serialization crash
      // (the response schema is a record — `null` used to 500 here).
      return space ?? { projectId, charterMd: "", activeMd: "", config: {}, exists: false };
    },
  );

  app.put(
    "/v1/projects/:projectId/kb/space",
    {
      config: { permission: "kb:write", auditAction: "kb.updated" },
      schema: {
        params: IdParams,
        body: z.object({
          charterMd: z.string().default(""),
          activeMd: z.string().default(""),
          config: AnyObject.default({}),
        }),
        response: { 200: KbSpaceSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const body = request.body as {
        charterMd: string;
        activeMd: string;
        config: Record<string, unknown>;
      };
      const row = (
        await db
          .insert(kbSpaces)
          .values({
            id: newId("kb"),
            orgId: p.orgId,
            projectId,
            charterMd: body.charterMd,
            activeMd: body.activeMd,
            config: body.config,
          })
          .onConflictDoUpdate({
            target: kbSpaces.projectId,
            set: {
              charterMd: body.charterMd,
              activeMd: body.activeMd,
              config: body.config,
              updatedAt: new Date(),
            },
          })
          .returning()
      )[0];
      if (!row) throw new ApiError(500, "insert_failed", "Could not update KB space");
      return row;
    },
  );

  app.get(
    "/v1/projects/:projectId/kb/entries",
    {
      config: { permission: "kb:read" },
      schema: {
        params: IdParams,
        querystring: PageQuery.extend({ type: z.string().optional() }),
        response: { 200: z.array(KbEntrySchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const projectId = (request.params as { projectId: string }).projectId;
      assertProjectScope(p, projectId);
      const space = await spaceFor(p.orgId, projectId);
      if (!space) return [];
      const query = request.query as PageQueryValue & { type?: string };
      const type = query.type;
      return db
        .select()
        .from(kbEntries)
        .where(
          type
            ? and(
                eq(kbEntries.orgId, p.orgId),
                eq(kbEntries.spaceId, space.id),
                eq(kbEntries.type, type),
              )
            : and(eq(kbEntries.orgId, p.orgId), eq(kbEntries.spaceId, space.id)),
        )
        .orderBy(asc(kbEntries.type), asc(kbEntries.number), asc(kbEntries.id))
        .limit(query.limit)
        .offset(query.offset);
    },
  );

  app.get(
    "/v1/kb/entries/:entryId",
    {
      config: { permission: "kb:read" },
      schema: { params: IdParams, response: { 200: KbEntrySchema } },
    },
    async (request) => {
      const p = principal(request);
      const entry = await loadKbEntryForPrincipal(
        p,
        (request.params as { entryId: string }).entryId,
      );
      return entry;
    },
  );

  app.post(
    "/v1/projects/:projectId/kb/entries",
    {
      config: { permission: "kb:write", auditAction: "kb.updated" },
      schema: {
        params: IdParams,
        querystring: z.object({ dry: z.coerce.number().optional() }),
        body: z.object({
          type: z.string(),
          slug: z.string(),
          frontmatter: AnyObject.default({}),
          bodyMd: z.string(),
          status: z.string().optional(),
          links: z.array(z.string()).default([]),
        }),
        response: {
          200: z.union([
            KbEntrySchema,
            z.object({
              ok: z.literal(true),
              entry: KbEntryDraftSchema,
              report: ValidationReportSchema,
            }),
          ]),
        },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const body = request.body as {
        type: string;
        slug: string;
        frontmatter: Record<string, unknown>;
        bodyMd: string;
        status?: string;
        links: string[];
      };
      const dry = (request.query as { dry?: number }).dry === 1;
      const space = await spaceFor(p.orgId, projectId);
      if (!space) throw notFound("KB space not found");
      const graph = await loadKbGraph(db, p.orgId, projectId);
      if (!graph) throw notFound("KB space not found");
      const max =
        (
          await db
            .select()
            .from(kbEntries)
            .where(
              and(
                eq(kbEntries.orgId, p.orgId),
                eq(kbEntries.spaceId, space.id),
                eq(kbEntries.type, body.type),
              ),
            )
            .orderBy(desc(kbEntries.number))
            .limit(1)
        )[0]?.number ?? 0;
      const parentEntries = graph.entries.filter((entry) => body.links.includes(entry.id));
      if (parentEntries.length !== body.links.length) {
        throw new ApiError(400, "link_target_missing", "One or more parent links do not exist");
      }
      const normalized = normalizeKbDraft({
        type: body.type,
        number: max + 1,
        slug: body.slug,
        frontmatter: body.frontmatter,
        bodyMd: body.bodyMd,
        parentEntries,
      });
      const draft = {
        id: "__draft__",
        type: body.type,
        number: max + 1,
        slug: body.slug,
        frontmatter: normalized.frontmatter,
        bodyMd: normalized.bodyMd,
        status: body.status,
        supersedes: null,
      };
      const report = validate({
        space: toHarnessSpace(space),
        entries: [...graph.entries, draft],
        links: [
          ...graph.links,
          ...parentEntries.flatMap((parent) => [
            { fromEntry: "__draft__", toEntry: parent.id },
            { fromEntry: parent.id, toEntry: "__draft__" },
          ]),
        ],
        entryId: "__draft__",
        validateSpecials: false,
      });
      if (!report.ok) {
        throw new ApiError(400, "kb_validation_failed", "KB entry failed validation", report);
      }
      if (dry) {
        return { ok: true, entry: draft, report };
      }
      const entry = await db.transaction(async (tx) => {
        const inserted = (
          await tx
            .insert(kbEntries)
            .values({
              id: newId("kb"),
              orgId: p.orgId,
              spaceId: space.id,
              type: body.type,
              number: max + 1,
              slug: body.slug,
              frontmatter: normalized.frontmatter,
              bodyMd: normalized.bodyMd,
              status: body.status,
            })
            .returning()
        )[0];
        if (!inserted) throw new ApiError(500, "insert_failed", "Could not create KB entry");
        const childArtifactId = artifactIdFor(toHarnessEntry(inserted));
        for (const link of body.links) {
          await tx
            .insert(kbLinks)
            .values([
              { orgId: p.orgId, spaceId: space.id, fromEntry: inserted.id, toEntry: link },
              { orgId: p.orgId, spaceId: space.id, fromEntry: link, toEntry: inserted.id },
            ])
            .onConflictDoNothing();
          const parent = parentEntries.find((candidate) => candidate.id === link);
          if (parent) {
            await tx
              .update(kbEntries)
              .set({
                bodyMd: ensureLinks(parent.bodyMd, [childArtifactId]),
                updatedAt: new Date(),
              })
              .where(and(eq(kbEntries.orgId, p.orgId), eq(kbEntries.id, parent.id)));
          }
        }
        await tx
          .update(kbSpaces)
          .set({ activeMd: ensureActive(space.activeMd, [childArtifactId]), updatedAt: new Date() })
          .where(and(eq(kbSpaces.orgId, p.orgId), eq(kbSpaces.id, space.id)));
        return inserted;
      });
      return entry;
    },
  );

  app.patch(
    "/v1/kb/entries/:entryId",
    {
      config: { permission: "kb:write", auditAction: "kb.updated" },
      schema: {
        params: IdParams,
        body: z.object({
          type: z.string().optional(),
          number: z.number().int().optional(),
          slug: z.string().optional(),
          frontmatter: AnyObject.optional(),
          bodyMd: z.string().optional(),
          status: z.string().optional(),
          supersedes: z.string().nullable().optional(),
        }),
        response: { 200: KbEntrySchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { entryId } = request.params as { entryId: string };
      const body = request.body as {
        type?: string;
        number?: number;
        slug?: string;
        frontmatter?: Record<string, unknown>;
        bodyMd?: string;
        status?: string;
        supersedes?: string | null;
      };
      const current = await loadKbEntryForPrincipal(p, entryId);
      const space = (
        await db
          .select()
          .from(kbSpaces)
          .where(and(eq(kbSpaces.orgId, p.orgId), eq(kbSpaces.id, current.spaceId)))
          .limit(1)
      )[0];
      if (!space) throw notFound("KB space not found");
      const entries = await db
        .select()
        .from(kbEntries)
        .where(and(eq(kbEntries.orgId, p.orgId), eq(kbEntries.spaceId, current.spaceId)));
      const links = await db
        .select()
        .from(kbLinks)
        .where(and(eq(kbLinks.orgId, p.orgId), eq(kbLinks.spaceId, current.spaceId)));
      const patch = definedFields({
        type: body.type,
        number: body.number,
        slug: body.slug,
        frontmatter: body.frontmatter,
        bodyMd: body.bodyMd,
        status: body.status,
        supersedes: body.supersedes,
        updatedAt: new Date(),
      });
      const patched = { ...current, ...patch };
      const report = validate({
        space: toHarnessSpace(space),
        entries: entries.map((entry) => toHarnessEntry(entry.id === entryId ? patched : entry)),
        links: links.map((link) => ({ fromEntry: link.fromEntry, toEntry: link.toEntry })),
        entryId,
        validateSpecials: false,
      });
      if (!report.ok) {
        throw new ApiError(400, "kb_validation_failed", "KB entry failed validation", report);
      }
      const row = (
        await db
          .update(kbEntries)
          .set(patch)
          .where(and(eq(kbEntries.orgId, p.orgId), eq(kbEntries.id, entryId)))
          .returning()
      )[0];
      if (!row) throw notFound("KB entry not found");
      return row;
    },
  );
  app.post(
    "/v1/projects/:projectId/kb/validate",
    {
      config: { permission: "kb:write", auditAction: "kb.updated" },
      schema: {
        params: IdParams,
        response: { 200: ValidationReportSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      return validateProjectKb(db, p.orgId, projectId);
    },
  );

  app.post(
    "/v1/runs/:runId/kb-checkpoint",
    {
      config: { public: true },
      schema: { params: IdParams, response: { 200: ValidationReportSchema } },
    },
    async (request) => {
      const { runId } = request.params as { runId: string };
      const token = bearer(request.headers.authorization);
      if (!token) throw new ApiError(401, "unauthorized", "Runner token required");
      const run = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0];
      if (!run) throw notFound("Run not found");
      const sandbox = readSandbox(run.sandbox);
      if (!sandbox.runnerTokenHash || !(await verifyKey(token, sandbox.runnerTokenHash))) {
        throw new ApiError(401, "unauthorized", "Invalid runner token");
      }
      return validateProjectKb(db, run.orgId, run.projectId);
    },
  );

  async function spaceFor(orgId: string, projectId: string) {
    return (
      await db
        .select()
        .from(kbSpaces)
        .where(and(eq(kbSpaces.orgId, orgId), eq(kbSpaces.projectId, projectId)))
        .limit(1)
    )[0];
  }

  async function loadKbEntryForPrincipal(p: Principal, entryId: string) {
    const row = (
      await db
        .select({ entry: kbEntries, space: kbSpaces })
        .from(kbEntries)
        .innerJoin(kbSpaces, eq(kbEntries.spaceId, kbSpaces.id))
        .where(and(eq(kbEntries.orgId, p.orgId), eq(kbEntries.id, entryId)))
        .limit(1)
    )[0];
    if (!row) throw notFound("KB entry not found");
    assertBareRowProjectScope(p, row.space.projectId, "KB entry not found");
    return row.entry;
  }

  app.get(
    "/v1/projects/:projectId/tasks",
    {
      config: { permission: "tasks:read" },
      schema: {
        params: IdParams,
        querystring: PageQuery,
        response: { 200: z.array(TaskSchema) },
      },
    },
    async (request) => {
      const query = request.query as PageQueryValue;
      return db
        .select()
        .from(poTasks)
        .where(
          and(
            eq(poTasks.orgId, principal(request).orgId),
            eq(poTasks.projectId, (request.params as { projectId: string }).projectId),
          ),
        )
        .orderBy(desc(poTasks.createdAt), desc(poTasks.id))
        .limit(query.limit)
        .offset(query.offset);
    },
  );
  app.post(
    "/v1/projects/:projectId/tasks",
    {
      config: { permission: "tasks:write", auditAction: "task.updated" },
      schema: {
        params: IdParams,
        body: z.object({
          title: z.string(),
          bodyMd: z.string(),
          status: z.string().default("draft"),
          kbEntryId: z.string().optional(),
          wsjf: AnyObject.default({}),
        }),
        response: { 200: TaskSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const body = request.body as {
        title: string;
        bodyMd: string;
        status: string;
        kbEntryId?: string;
        wsjf: Record<string, unknown>;
      };
      if (body.kbEntryId) {
        const entry = (
          await db
            .select({ id: kbEntries.id })
            .from(kbEntries)
            .innerJoin(kbSpaces, eq(kbSpaces.id, kbEntries.spaceId))
            .where(
              and(
                eq(kbEntries.orgId, p.orgId),
                eq(kbEntries.id, body.kbEntryId),
                eq(kbSpaces.orgId, p.orgId),
                eq(kbSpaces.projectId, projectId),
              ),
            )
            .limit(1)
        )[0];
        if (!entry) throw notFound("KB entry not found");
      }
      const row = (
        await db
          .insert(poTasks)
          .values({
            id: newId("task"),
            orgId: p.orgId,
            projectId,
            title: body.title,
            bodyMd: body.bodyMd,
            status: body.status,
            kbEntryId: body.kbEntryId,
            wsjf: body.wsjf,
          })
          .returning()
      )[0];
      if (!row) throw new ApiError(500, "insert_failed", "Could not create task");
      return row;
    },
  );
  app.patch(
    "/v1/projects/:projectId/tasks/:taskId",
    {
      config: { permission: "tasks:write", auditAction: "task.updated" },
      schema: {
        params: z.object({ projectId: z.string(), taskId: z.string() }),
        body: z.object({
          title: z.string().optional(),
          bodyMd: z.string().optional(),
          status: z.string().optional(),
          kbEntryId: z.string().optional(),
          wsjf: AnyObject.optional(),
          gh: AnyObject.optional(),
        }),
        response: { 200: TaskSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId, taskId } = request.params as { projectId: string; taskId: string };
      const body = request.body as {
        title?: string;
        bodyMd?: string;
        status?: string;
        kbEntryId?: string;
        wsjf?: Record<string, unknown>;
        gh?: Record<string, unknown>;
      };
      assertProjectScope(p, projectId);
      const row = (
        await db
          .update(poTasks)
          .set(
            definedFields({
              title: body.title,
              bodyMd: body.bodyMd,
              status: body.status,
              kbEntryId: body.kbEntryId,
              wsjf: body.wsjf,
              gh: body.gh,
              updatedAt: new Date(),
            }),
          )
          .where(
            and(
              eq(poTasks.orgId, p.orgId),
              eq(poTasks.projectId, projectId),
              eq(poTasks.id, taskId),
            ),
          )
          .returning()
      )[0];
      if (!row) throw notFound("Task not found");
      return row;
    },
  );
  app.delete(
    "/v1/projects/:projectId/tasks/:taskId",
    {
      config: { permission: "tasks:write", auditAction: "task.updated" },
      schema: {
        params: z.object({ projectId: z.string(), taskId: z.string() }),
        response: { 200: Ok },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId, taskId } = request.params as { projectId: string; taskId: string };
      assertProjectScope(p, projectId);
      await db
        .delete(poTasks)
        .where(
          and(eq(poTasks.orgId, p.orgId), eq(poTasks.projectId, projectId), eq(poTasks.id, taskId)),
        );
      return { ok: true };
    },
  );
  app.post(
    "/v1/tasks/:taskId/transition",
    {
      config: { permission: "tasks:write", auditAction: "task.updated" },
      schema: {
        params: IdParams,
        body: z.object({ status: z.string() }),
        response: { 200: TaskSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { taskId } = request.params as { taskId: string };
      const task = (
        await db
          .select()
          .from(poTasks)
          .where(and(eq(poTasks.orgId, p.orgId), eq(poTasks.id, taskId)))
          .limit(1)
      )[0];
      if (!task) throw notFound("Task not found");
      assertBareRowProjectScope(p, task.projectId, "Task not found");
      const transitioned = (
        await db
          .update(poTasks)
          .set({ status: (request.body as { status: string }).status, updatedAt: new Date() })
          .where(
            and(
              eq(poTasks.orgId, p.orgId),
              eq(poTasks.projectId, task.projectId),
              eq(poTasks.id, taskId),
            ),
          )
          .returning()
      )[0];
      if (!transitioned) throw notFound("Task not found");
      return transitioned;
    },
  );

  app.post(
    "/v1/tasks/:taskId/propose",
    {
      config: { permission: "tasks:write", auditAction: "task.proposed" },
      schema: { params: IdParams, response: { 200: ProposalSchema } },
    },
    async (request) => {
      const p = principal(request);
      const { taskId } = request.params as { taskId: string };
      const task = (
        await db
          .select()
          .from(poTasks)
          .where(and(eq(poTasks.orgId, p.orgId), eq(poTasks.id, taskId)))
          .limit(1)
      )[0];
      if (!task) throw notFound("Task not found");
      assertBareRowProjectScope(p, task.projectId, "Task not found");
      const actionType = await actionTypeByName(p.orgId, "task_creation");
      if (!actionType) throw notFound("Action type not found");
      const repo = (
        await db
          .select()
          .from(repos)
          .where(and(eq(repos.orgId, p.orgId), eq(repos.projectId, task.projectId)))
          .limit(1)
      )[0];
      const project = (
        await db
          .select()
          .from(projects)
          .where(and(eq(projects.orgId, p.orgId), eq(projects.id, task.projectId)))
          .limit(1)
      )[0];
      const board = objectOrEmpty(project?.settings).board;
      const proposal = (
        await db
          .insert(proposals)
          .values({
            id: newId("prop"),
            orgId: p.orgId,
            projectId: task.projectId,
            actionTypeId: actionType.id,
            payload: {
              taskId: task.id,
              title: task.title,
              bodyMd: task.bodyMd,
              wsjf: task.wsjf,
              target: {
                repo: repo ? { owner: repo.owner, name: repo.name } : null,
                board,
              },
            },
            contextMd: `Task creation proposal for ${task.title}`,
            expiresAt: new Date(Date.now() + actionType.defaultTtlHours * 3600_000),
          })
          .returning()
      )[0];
      if (!proposal) throw new ApiError(500, "insert_failed", "Could not create proposal");
      await db.insert(proposalEvents).values({
        orgId: p.orgId,
        proposalId: proposal.id,
        seq: 1,
        type: "open",
        actor: { type: p.type, id: p.id },
        data: {},
      });
      await db
        .update(poTasks)
        .set({ status: "proposed", updatedAt: new Date() })
        .where(
          and(
            eq(poTasks.orgId, p.orgId),
            eq(poTasks.projectId, task.projectId),
            eq(poTasks.id, task.id),
          ),
        );
      return { ...proposal, actionType: actionType.name };
    },
  );

  async function actionTypeByName(orgId: string, name: string) {
    return (
      await db
        .select()
        .from(actionTypes)
        .where(and(eq(actionTypes.orgId, orgId), eq(actionTypes.name, name)))
        .limit(1)
    )[0];
  }
}
